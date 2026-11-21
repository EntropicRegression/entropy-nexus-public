import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import QRCode from 'qrcode';
import type { ApprovalDecision, AuditEntry, Backend, RemoteAccess, RemoteRole, RemoteStatus, Update } from '../shared/types';
import { actionOf, auditDetail, denial, filterSnapshot, filterUpdate, FULL, httpRule, normalizeAccess, rpcRule, visible, type Rule } from './access';
import { allowAttachments } from './attachments';
import type { Core } from './core';
import { IMAGE_HEADERS, readAllowed } from './media';
import { portraitFile } from './portraits';
import page from './remote-page.html?raw';
import shim from './remote-shim.js?raw';
import type { Store } from './store';
import { inspectDir } from './worktree';

/**
 * 手機遠端操作:主控台自己開一個小型網頁伺服器,提供手機版的操作頁面。
 *
 * 安全設計:
 * - 預設關閉;開啟後只在 Tailscale 的位址(100.64.0.0/10)與本機迴路上聆聽,不對一般網路公開。
 *   「同一個 Wi-Fi」要另外勾選才會聆聽區域網路位址。
 * - 裝置必須先配對:桌面顯示一次性的配對碼(QR code),手機用它換取長期通行碼;通行碼只存雜湊值,可以從桌面撤銷。
 * - 沒有通行碼的請求除了載入頁面與配對以外一律拒絕。
 * - 電腦的瀏覽器連進來時,提供和桌面視窗同一份的完整介面(載入建置好的畫面程式,以 remote-shim.js 取代 preload);
 *   手機的瀏覽器仍是手機版頁面。/m 與 /full 可以指定要哪一種。完整介面經 /api/rpc 呼叫和桌面畫面相同的那組函式,
 *   所以配對過的裝置能做的事和坐在電腦前相同(這點和手機版一樣:它本來就能在任意資料夾建立自動模式的節點)。
 * - 每支裝置有角色(完整、操作、唯讀)與節點範圍,規則集中在 access.ts;沒列出的功能只有完整角色能用。
 *   所有請求在這裡先過權限檢查,狀態、對話與即時更新也依裝置過濾。會改變狀態的動作與被拒絕的嘗試寫進操作紀錄。
 * - 連線本身是 HTTP;經由 Tailscale 時由 Tailscale 加密,區域網路則沒有加密。
 */
const PORT = Number(process.env.NEXUS_REMOTE_PORT) || 47615;
const PAIR_TTL = 5 * 60 * 1000;

/** role 與 agents 是後來才加的;舊資料沒有這兩欄,當成完整權限。 */
interface Device { id: string; name: string; hash: string; createdAt: number; lastSeen: number; role?: RemoteRole; agents?: string[] | null }
interface Settings { enabled: boolean; lan: boolean; devices: Device[] }

type Methods = Record<string, (...args: any[]) => unknown>;
type Stream = ServerResponse & { deviceId?: string; full?: boolean };

/** 桌面畫面建置後的檔案(out/renderer)。開發模式沒有建置過時不存在,這時只提供手機版頁面。 */
const rendererDir = join(__dirname, '../renderer');
const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
const PORTRAIT_TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
const FULL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'";

let methods: Methods = {};
let fullCache: { mtime: number; html: string } | null = null;

/** 完整介面的頁面:桌面畫面的 index.html,把入口腳本換成 remote-shim.js(它配對完成後才載入入口)。沒有建置過時回傳 null。 */
function fullPage(): string | null {
  try {
    const file = join(rendererDir, 'index.html');
    const mtime = statSync(file).mtimeMs;
    if (fullCache?.mtime === mtime) return fullCache.html;
    const html = readFileSync(file, 'utf8');
    const entry = /<script[^>]*\bsrc="([^"]+)"[^>]*><\/script>/.exec(html);
    if (!entry) return null;
    fullCache = { mtime, html: html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/, '').replace(entry[0], `<script src="/web-shim.js" data-entry="${entry[1]}"></script>`) };
    return fullCache.html;
  } catch {
    return null;
  }
}

/** 資料夾清單,給完整介面的「瀏覽」用;path 空白時列出磁碟機(Windows)或根目錄。 */
function listDirs(path: string): { path: string; parent: string | null; dirs: string[]; home: string } {
  const home = homedir();
  if (!path.trim()) {
    if (process.platform === 'win32') return { path: '', parent: null, home, dirs: [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(l => `${l}:\\`).filter(d => existsSync(d)) };
    path = '/';
  }
  if (/^[\\/]{2}/.test(path)) throw new Error('不支援網路路徑');
  const abs = resolve(path.trim());
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { throw new Error('讀不到這個資料夾'); }
  const up = dirname(abs);
  return {
    path: abs,
    parent: up !== abs ? up : process.platform === 'win32' ? '' : null,
    home,
    dirs: entries.filter(d => d.isDirectory() && !d.name.startsWith('$')).map(d => d.name).sort((a, b) => a.localeCompare(b)).slice(0, 1000).map(n => join(abs, n)),
  };
}

let core: Core;
let store: Store;
let settings: Settings = { enabled: false, lan: false, devices: [] };
const servers = new Map<string, Server>();
const streams = new Set<Stream>();
let pair = { code: '', expires: 0, fails: 0 };
/** 下一支配對的裝置會得到的權限;每次啟動都回到完整。 */
let pairAccess: RemoteAccess = FULL;
const AUDIT_KEEP = 90 * 86400000;
const ROLE_LABEL: Record<RemoteRole, string> = { full: '完整', operator: '操作', viewer: '唯讀' };

const accessOf = (d: Device): RemoteAccess => normalizeAccess(d.role ?? 'full', d.agents ?? null);
const rootOf = (id: string): string | null => core.agentRef(id)?.root ?? null;
/** 紀錄裡的對象:節點 id,或任務 id(換成它所屬的節點)。要在執行之前查,終止節點之後就查不到名稱了。 */
function targetOf(id: string | null): { id: string; name: string } {
  if (!id) return { id: '', name: '' };
  const agentId = core.agentRef(id) ? id : core.taskAgent(id);
  return agentId ? { id: agentId, name: core.agentRef(agentId)?.name ?? '' } : { id: '', name: '' };
}
const describeAccess = (a: RemoteAccess): string => `${ROLE_LABEL[a.role]}${a.agents ? ` · ${a.agents.length} 個節點` : a.role === 'full' ? '' : ' · 全部節點'}`;

function audit(who: { id: string; name: string }, role: AuditEntry['role'], action: string, target: { id: string; name: string }, detail: string, ok: boolean): void {
  try { store.addAudit({ ts: Date.now(), deviceId: who.id, device: who.name, role, action, agentId: target.id, agentName: target.name, detail: detail.slice(0, 200), ok }); } catch { /* 紀錄寫不進去不影響操作 */ }
}
let lastError = '';
let timer: NodeJS.Timeout | null = null;
/** 手機上傳的圖片與 PDF 暫存在這裡,七天後清掉。 */
let uploads = '';
const inUploads = (p: string) => dirname(resolve(p)).toLowerCase() === resolve(uploads).toLowerCase();

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const isTailscale = (ip: string) => { const m = /^100\.(\d+)\./.exec(ip); return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127; };
const isLan = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

function ips(): { tailscale: string[]; lan: string[] } {
  const all = Object.values(networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i!.address);
  return { tailscale: all.filter(isTailscale), lan: all.filter(isLan) };
}

function save(): void {
  store.setSetting('remote', JSON.stringify(settings));
}

function newPair(): void {
  // 不含容易混淆的字元
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  pair = { code: [...randomBytes(8)].map(b => alphabet[b % alphabet.length]).join(''), expires: Date.now() + PAIR_TTL, fails: 0 };
}

/** 依目前的設定與網路介面,開關各個位址上的伺服器。Tailscale 之後才連上也會自動補開。 */
function reconcile(): void {
  const { tailscale, lan } = ips();
  const want = new Set<string>(settings.enabled ? ['127.0.0.1', ...tailscale, ...(settings.lan ? lan : [])] : []);
  for (const [addr, server] of servers) {
    if (!want.has(addr)) { server.close(); servers.delete(addr); }
  }
  for (const addr of want) {
    if (servers.has(addr)) continue;
    // 操作失敗(例如合併衝突、節點還在執行)時把原因回給手機顯示
    const server = createServer((req, res) => { void handle(req, res).catch(err => { try { json(res, 400, { error: String((err as Error)?.message ?? '操作失敗').slice(0, 300) }); } catch { /* 連線已斷 */ } }); });
    server.on('error', err => { lastError = `無法在 ${addr}:${PORT} 聆聽:${err.message}`; servers.delete(addr); });
    server.listen(PORT, addr, () => { if (lastError.includes(addr)) lastError = ''; });
    servers.set(addr, server);
  }
  if (!settings.enabled) { for (const s of streams) s.end(); streams.clear(); }
}

export function initRemote(c: Core, s: Store, dataDir: string, m: Methods = {}): void {
  core = c;
  methods = m;
  store = s;
  uploads = join(dataDir, 'uploads');
  try {
    mkdirSync(uploads, { recursive: true });
    for (const f of readdirSync(uploads)) { const p = join(uploads, f); if (Date.now() - statSync(p).mtimeMs > 7 * 86400000) unlinkSync(p); }
  } catch { /* 清不掉不影響運作 */ }
  try { settings = { ...settings, ...JSON.parse(s.getSetting('remote') ?? '{}') }; } catch { /* 設定壞了就用預設值 */ }
  if (!Array.isArray(settings.devices)) settings.devices = [];
  try { s.pruneAudit(Date.now() - AUDIT_KEEP); } catch { /* 清不掉不影響運作 */ }
  newPair();
  reconcile();
  timer = setInterval(reconcile, 15000);
}

export function stopRemote(): void {
  if (timer) clearInterval(timer);
  for (const s of streams) s.end();
  for (const server of servers.values()) server.close();
  servers.clear();
}

export async function remoteStatus(): Promise<RemoteStatus> {
  if (Date.now() > pair.expires) newPair();
  const { tailscale, lan } = ips();
  const host = tailscale[0] ?? (settings.lan ? lan[0] : undefined) ?? null;
  const url = settings.enabled && host ? `http://${host}:${PORT}/?pair=${pair.code}` : null;
  return {
    enabled: settings.enabled,
    lan: settings.lan,
    port: PORT,
    tailscaleIp: tailscale[0] ?? null,
    lanIp: lan[0] ?? null,
    listening: [...servers.keys()],
    url,
    qr: url ? await QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#04121a', light: '#e8fbff' } }) : null,
    pairCode: pair.code,
    pairExpires: pair.expires,
    pairAccess,
    devices: settings.devices.map(d => ({ id: d.id, name: d.name, createdAt: d.createdAt, lastSeen: d.lastSeen, ...accessOf(d) })),
    error: lastError,
  };
}

export function remoteSet(patch: { enabled?: boolean; lan?: boolean }): void {
  if (patch.enabled !== undefined) settings.enabled = patch.enabled;
  if (patch.lan !== undefined) settings.lan = patch.lan;
  save();
  reconcile();
}

export function remoteNewCode(): void {
  newPair();
}

/** 設定下一組配對碼的權限,並換一組新的配對碼(舊的配對碼帶的是舊權限,不能再用)。 */
export function remotePairAccess(access: RemoteAccess): void {
  pairAccess = normalizeAccess(access?.role, access?.agents);
  newPair();
}

/** 修改已配對裝置的權限;已經連著的串流切斷,重新連線後用新的權限。 */
export function remoteSetDevice(id: string, access: RemoteAccess): void {
  const d = settings.devices.find(x => x.id === id);
  if (!d) throw new Error('找不到這支裝置');
  const next = normalizeAccess(access?.role, access?.agents);
  d.role = next.role;
  d.agents = next.agents;
  save();
  audit(d, 'desktop', 'setAccess', { id: '', name: '' }, describeAccess(next), true);
  for (const s of streams) { if (s.deviceId === id) { s.end(); streams.delete(s); } }
}

export function remoteAudit(): AuditEntry[] {
  return store.listAudit(500);
}

export function remoteRevoke(id: string): void {
  const gone = settings.devices.find(d => d.id === id);
  if (gone) audit(gone, 'desktop', 'revoke', { id: '', name: '' }, '', true);
  settings.devices = settings.devices.filter(d => d.id !== id);
  save();
  // 已經連著的串流也一併切斷
  for (const s of streams) { if (s.deviceId === id) { s.end(); streams.delete(s); } }
}

/** 核心服務的更新同步推給已連線的裝置。終端機輸出只送給完整介面(手機版沒有終端機)。 */
export function remotePush(u: Update): void {
  // 節點終止後,從各裝置的節點範圍裡拿掉
  if (u.removedId !== undefined) {
    let changed = false;
    for (const d of settings.devices) if (d.agents?.includes(u.removedId)) { d.agents = d.agents.filter(x => x !== u.removedId); changed = true; }
    if (changed) save();
  }
  if (!streams.size) return;
  let line = '';
  for (const s of streams) {
    const d = settings.devices.find(x => x.id === s.deviceId);
    if (!d) continue;
    const access = accessOf(d);
    // 完整角色看到全部;其他角色只收到範圍內節點的更新,終端機輸出一律不送
    if (access.role === 'full') { if (s.full || !u.term) s.write(line ||= `data: ${JSON.stringify(u)}\n\n`); continue; }
    if (u.term) continue;
    const part = filterUpdate(u, access, rootOf);
    if (part) s.write(`data: ${JSON.stringify(part)}\n\n`);
  }
}

/** 只有桌面畫面才顯示的更新(外部觀察節點),另外推給完整介面。 */
export function remotePushFull(u: Update): void {
  let line = '';
  for (const s of streams) {
    const d = s.full ? settings.devices.find(x => x.id === s.deviceId) : undefined;
    if (d && accessOf(d).role === 'full') s.write(line ||= `data: ${JSON.stringify(u)}\n\n`);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max = 256 * 1024): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

/** cookie 為 true 時也接受 cookie 裡的通行碼;只用在讀圖片(<img> 不能帶標頭),其他請求一律要標頭,其他網站才無法代送。 */
function deviceOf(req: IncomingMessage, cookie = false): Device | null {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? (cookie ? /(?:^|;\s*)nexus_token=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1] : undefined);
  if (!token) return null;
  const hash = Buffer.from(sha(token));
  const d = settings.devices.find(x => { const h = Buffer.from(x.hash); return h.length === hash.length && timingSafeEqual(h, hash); });
  if (d && Date.now() - d.lastSeen > 60000) { d.lastSeen = Date.now(); save(); }
  return d ?? null;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 只接受以我們聆聽的位址為主機名稱的請求,避免其他網站透過瀏覽器轉送請求進來
  // 除了位址本身,也接受這台電腦的名稱與 Tailscale 的 MagicDNS 名稱(*.ts.net 由 Tailscale 管理,外部網站無法把它指到這裡)
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!servers.has(host) && host !== 'localhost' && host !== hostname().toLowerCase() && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`Entropy Nexus:請改用主控台「手機」面板上顯示的位址連線(不接受 ${host.slice(0, 80).replace(/[^\w.:-]/g, '')} 這個名稱)。`);
    return;
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;

  if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/m' || path === '/full')) {
    // 手機的瀏覽器給手機版頁面,電腦的瀏覽器給和桌面視窗相同的完整介面;/m 與 /full 可以指定
    const mobile = path === '/m' || (path !== '/full' && /Mobi|Android|iPhone|iPod/i.test(req.headers['user-agent'] ?? ''));
    const full = mobile ? null : fullPage();
    if (full) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': FULL_CSP });
      res.end(full);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data: blob:",
    });
    res.end(page);
    return;
  }

  if (req.method === 'GET' && path === '/web-shim.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(shim);
    return;
  }
  // 畫面程式的靜態檔案(不含任何使用者資料):只給 assets 資料夾裡的單層檔名
  if (req.method === 'GET' && path.startsWith('/assets/')) {
    let name = '';
    try { name = decodeURIComponent(path.slice(8)); } catch { /* 編碼壞了就當成找不到 */ }
    const type = ASSET_TYPES[extname(name).toLowerCase()];
    let body: Buffer | null = null;
    if (type && /^[\w.-]+$/.test(name) && !name.includes('..')) { try { body = readFileSync(join(rendererDir, 'assets', name)); } catch { /* 找不到 */ } }
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
    return;
  }

  if (req.method === 'POST' && path === '/pair') {
    const body = await readBody(req);
    if (Date.now() > pair.expires) newPair();
    if (typeof body.code !== 'string' || body.code.toUpperCase() !== pair.code) {
      // 猜錯幾次就換一組配對碼
      if (++pair.fails >= 5) newPair();
      json(res, 403, { error: '配對碼不正確或已過期,請在電腦上重新產生。' });
      return;
    }
    const token = randomBytes(32).toString('hex');
    const device: Device = { id: randomBytes(6).toString('hex'), name: String(body.name || '手機').slice(0, 40), hash: sha(token), createdAt: Date.now(), lastSeen: Date.now(), role: pairAccess.role, agents: pairAccess.agents };
    settings.devices.push(device);
    save();
    audit(device, pairAccess.role, 'pair', { id: '', name: '' }, describeAccess(pairAccess), true);
    newPair();
    json(res, 200, { token, name: device.name });
    return;
  }

  if (!path.startsWith('/api/')) { res.writeHead(404).end(); return; }
  const device = deviceOf(req, req.method === 'GET' && (path === '/api/file' || path === '/api/portrait'));
  if (!device) { json(res, 401, { error: '尚未配對或配對已被撤銷。' }); return; }

  // ---------- 權限:每個請求先對照 access.ts 的規則;不通過就回 403,會改變狀態的嘗試寫進操作紀錄
  const access = accessOf(device);
  const allow = (rule: Rule, action: string, scopeId: string | null, input: Record<string, any> = {}): boolean => {
    const agentId = rule.scope === 'task' ? (scopeId ? core.taskAgent(scopeId) : null) : scopeId;
    const why = denial(access, rule, !rule.scope || visible(access, agentId ? rootOf(agentId) : null));
    if (!why) return true;
    if (rule.level !== 'read') audit(device, access.role, action, targetOf(agentId ?? scopeId), auditDetail(action, input), false);
    json(res, 403, { error: why });
    return false;
  };
  /** 非完整角色送出的指令,在節點的對話裡註明是哪支裝置送的。 */
  const mark = (agentId: string, queued: boolean): void => {
    if (access.role !== 'full') core.note(agentId, `以下指令由遠端裝置「${device.name}」(${ROLE_LABEL[access.role]}權限)${queued ? '排入佇列' : '送出'}。`);
  };
  /** 附件只接受剛才上傳到暫存資料夾裡的檔案(直接位在資料夾內,不能用 .. 跳出去),不讓遠端指定電腦上的任意路徑。 */
  const uploaded = (list: unknown): string[] => (Array.isArray(list) ? list : []).filter((x: unknown): x is string => typeof x === 'string' && inUploads(x) && existsSync(x)).slice(0, 6);
  if (req.method === 'GET') {
    const rule = httpRule('GET', path);
    if (!allow(rule, actionOf(path), rule.scope ? url.searchParams.get(rule.scope === 'task' ? 'task' : 'id') : null)) return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    const s = core.snapshot();
    const seen = filterSnapshot({ agents: s.agents, tasks: s.tasks, dashboard: s.dashboard }, access, rootOf);
    json(res, 200, { agents: seen.agents, tasks: seen.tasks.slice(-60), usage: s.usage, dashboard: seen.dashboard, maxActive: s.maxActive, quotaStop: s.quotaStop, device: device.name, access });
    return;
  }
  if (req.method === 'GET' && path === '/api/history') {
    const keep = new Set(['message', 'image', 'tool', 'error', 'note', 'approval_request', 'approval_resolved', 'question', 'question_resolved', 'subagent']);
    // 工具的細節只留開頭一段,避免手機一次載入太多
    json(res, 200, core.history(url.searchParams.get('id') ?? '').filter(e => keep.has(e.type)).slice(-200).map(e => (e.type === 'tool' && e.detail ? { ...e, detail: e.detail.slice(0, 1500) } : e)));
    return;
  }
  if (req.method === 'GET' && path === '/api/meta') {
    const s = core.snapshot();
    json(res, 200, { capabilities: s.capabilities.map(c => ({ backend: c.backend, available: c.available, simulated: c.simulated, approvals: c.approvals, models: c.models, note: c.note, attachments: c.attachments })), dirs: access.role === 'full' ? core.recentDirs() : [] });
    return;
  }
  // 對話裡的圖片:與桌面版相同的路徑限制(節點工作目錄或主控台的媒體資料夾,只限圖片),手機以 fetch 帶通行碼讀取
  if (req.method === 'GET' && path === '/api/file') {
    const cwd = core.agentCwd(url.searchParams.get('id') ?? '');
    const hit = cwd ? readAllowed(cwd, url.searchParams.get('path') ?? '') : null;
    if (!hit) { json(res, 404, { error: '找不到圖片或不允許讀取' }); return; }
    res.writeHead(200, { ...IMAGE_HEADERS, 'Content-Type': hit.mime, 'Content-Length': hit.body.length });
    res.end(hit.body);
    return;
  }
  // 立繪:角色必須在清單裡,表情必須是已知的名稱
  if (req.method === 'GET' && path === '/api/portrait') {
    const file = portraitFile(url.searchParams.get('c') ?? '', url.searchParams.get('mood') ?? '');
    let body: Buffer | null = null;
    if (file) { try { body = readFileSync(file); } catch { /* 讀不到 */ } }
    if (!file || !body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { ...IMAGE_HEADERS, 'Content-Type': PORTRAIT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && path === '/api/dirs') { json(res, 200, listDirs(url.searchParams.get('path') ?? '')); return; }
  if (req.method === 'GET' && path === '/api/inspect') { json(res, 200, await inspectDir(url.searchParams.get('cwd') ?? '')); return; }
  if (req.method === 'GET' && path === '/api/changes') { json(res, 200, await core.taskChanges(url.searchParams.get('task') ?? '')); return; }
  if (req.method === 'GET' && path === '/api/oldsessions') { json(res, 200, await core.listOldSessions()); return; }
  if (req.method === 'GET' && path === '/api/persona') {
    try { json(res, 200, core.getPersona(url.searchParams.get('character') ?? '')); } catch (e) { json(res, 400, { error: (e as Error).message }); }
    return;
  }
  if (req.method === 'GET' && path === '/api/worktree') { json(res, 200, { status: await core.worktreeStatus(url.searchParams.get('id') ?? '') }); return; }

  // 手機上傳圖片或 PDF:存成暫存檔,送指令時再把路徑交給後台
  if (req.method === 'POST' && path === '/api/upload') {
    if (!allow(httpRule('POST', path), 'upload', null)) return;
    const type = String(req.headers['content-type'] ?? '');
    const ext = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' } as Record<string, string>)[type];
    if (!ext) { json(res, 400, { error: '只接受 PNG、JPEG、WebP、GIF 圖片或 PDF' }); return; }
    const max = ext === 'pdf' ? 20 : 8;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > max * 1024 * 1024) { res.setHeader('Connection', 'close'); json(res, 413, { error: `${ext === 'pdf' ? 'PDF ' : '圖片'}超過 ${max} MB` }); return; } chunks.push(c as Buffer); }
    // 原檔名只留文字、數字、底線與連字號當成提示,副檔名由內容類型決定,不會跳出暫存資料夾
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { /* 檔名編碼壞了就不用 */ }
    const stem = name.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40);
    const file = join(uploads, `${Date.now()}-${randomBytes(4).toString('hex')}${stem ? `-${stem}` : ''}.${ext}`);
    writeFileSync(file, Buffer.concat(chunks));
    json(res, 200, { path: file });
    return;
  }
  // 完整介面的附件:使用者的檔案在另一台電腦上,先上傳到暫存資料夾再把路徑交給節點。類型不限,和桌面版的「附加」一樣
  if (req.method === 'POST' && path === '/api/attach') {
    if (!allow(httpRule('POST', path), 'attach', null)) return;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 50 * 1024 * 1024) { res.setHeader('Connection', 'close'); json(res, 413, { error: '檔案超過 50 MB' }); return; } chunks.push(c as Buffer); }
    let name = '';
    try { name = decodeURIComponent(String(req.headers['x-file-name'] ?? '')); } catch { /* 檔名編碼壞了就不用 */ }
    name = name.split(/[\\/]/).pop()!;
    // 副檔名只留英數字;沒有副檔名時依內容類型補上(貼上的截圖)
    const type = String(req.headers['content-type'] ?? '');
    const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1].toLowerCase() ?? ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf' } as Record<string, string>)[type] ?? 'bin';
    const stem = name.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60);
    const file = join(uploads, `${Date.now()}-${randomBytes(4).toString('hex')}${stem ? `-${stem}` : ''}.${ext}`);
    writeFileSync(file, Buffer.concat(chunks));
    // 登記之後畫面才能讀縮圖
    allowAttachments([file]);
    audit(device, access.role, 'attach', { id: '', name: '' }, name.slice(0, 120), true);
    json(res, 200, { path: file });
    return;
  }
  if (req.method === 'GET' && path === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(': ok\n\n');
    const stream: Stream = res;
    stream.deviceId = device.id;
    stream.full = url.searchParams.get('full') === '1';
    streams.add(stream);
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(beat); streams.delete(stream); });
    return;
  }

  // 完整介面呼叫和桌面畫面相同的那組函式
  if (req.method === 'POST' && path === '/api/rpc') {
    const b = await readBody(req, 2 * 1024 * 1024);
    const name = typeof b.method === 'string' ? b.method : '';
    const fn = Object.hasOwn(methods, name) ? methods[name] : null;
    if (!fn) { json(res, 404, { error: '沒有這個功能' }); return; }
    const args: any[] = Array.isArray(b.args) ? b.args : [];
    const first = typeof args[0] === 'string' ? args[0] : null;
    const rule = rpcRule(name);
    // 紀錄用的動作名稱與內容:和手機版端點用同一套
    const action = name === 'maxActive' || name === 'quotaStop' ? 'settings' : name;
    const input: Record<string, any> = name === 'send' || name === 'enqueue' ? { text: args[1] } : name === 'editQueued' ? { text: args[2] } : name === 'approval' ? { decision: args[2] }
      : name === 'answer' ? { answers: args[2] } : name === 'create' && args[0] && typeof args[0] === 'object' ? args[0] : name === 'updateAgent' && args[1] && typeof args[1] === 'object' ? args[1]
      : name === 'setPersona' ? { character: args[0] } : name === 'maxActive' ? { maxActive: args[0] } : name === 'quotaStop' ? { quotaStop: args[0] } : name === 'setDailyBudget' ? { backend: args[0], percent: args[1] } : name === 'commitTask' ? { message: args[1] } : {};
    if (!allow(rule, action, rule.scope ? first : null, input)) return;
    const target = targetOf(first);
    if (name === 'snapshot') { json(res, 200, { result: { ...filterSnapshot(await fn() as any, access, rootOf), access } }); return; }
    if (access.role !== 'full') {
      // 非完整角色:附件只能是自己上傳的,縮圖也只能讀上傳的檔案
      if (name === 'send' || name === 'enqueue') { args[2] = uploaded(args[2]); mark(String(first), name === 'enqueue'); }
      if (name === 'attachmentPreview' && !(first && inUploads(first))) { json(res, 200, { result: null }); return; }
    }
    const result = (await fn(...args)) ?? null;
    if (rule.log) audit(device, access.role, action, target, auditDetail(action, input), true);
    json(res, 200, { result });
    return;
  }

  if (req.method === 'POST') {
    const b = await readBody(req);
    const id = String(b.id ?? '');
    const rule = httpRule('POST', path);
    const action = actionOf(path);
    if (!allow(rule, action, rule.scope ? id : null, b)) return;
    const target = targetOf(id || (typeof b.taskId === 'string' ? b.taskId : null));
    const run = async (): Promise<void> => {
    switch (path) {
      case '/api/send':
        if (typeof b.text !== 'string' || !b.text.trim()) { json(res, 400, { error: '沒有內容' }); return; }
        mark(id, false);
        await core.send(id, b.text.trim().slice(0, 20000), uploaded(b.images), 'user', 'remote');
        break;
      case '/api/approve':
        if (!['allow', 'allow_session', 'deny'].includes(b.decision)) { json(res, 400, { error: '決定不正確' }); return; }
        core.respondApproval(id, String(b.requestId), b.decision as ApprovalDecision);
        break;
      case '/api/answer':
        core.answerQuestion(id, String(b.requestId), b.answers && typeof b.answers === 'object' ? b.answers : null);
        break;
      case '/api/interrupt': core.interrupt(id); break;
      case '/api/enqueue':
        if (typeof b.text !== 'string' || !b.text.trim()) { json(res, 400, { error: '沒有內容' }); return; }
        mark(id, true);
        core.enqueue(id, b.text.trim().slice(0, 20000), uploaded(b.images), 'remote');
        break;
      case '/api/cancelqueued': core.cancelQueued(id, String(b.queuedId ?? '')); break;
      case '/api/editqueued':
        if (typeof b.text !== 'string' || !b.text.trim()) { json(res, 400, { error: '沒有內容' }); return; }
        core.editQueued(id, String(b.queuedId ?? ''), b.text.trim().slice(0, 20000));
        break;
      case '/api/resumequeue': core.resumeQueue(id); break;
      case '/api/wake': await core.wake(id); break;
      case '/api/sleep': await core.sleep(id); break;
      case '/api/remove': await core.removeAgent(id); break;
      case '/api/update': json(res, 200, await core.updateAgent(id, { name: typeof b.name === 'string' ? b.name : undefined, model: typeof b.model === 'string' ? b.model : undefined })); return;
      case '/api/create': {
        if (!['claude', 'codex', 'antigravity'].includes(b.backend) || typeof b.cwd !== 'string' || !b.cwd.trim() || !existsSync(b.cwd)) { json(res, 400, { error: '後台或工作目錄不正確(資料夾必須存在)' }); return; }
        json(res, 200, await core.createAgent({ name: String(b.name || '手機新增').slice(0, 40), character: '', model: String(b.model ?? '').slice(0, 80), backend: b.backend as Backend, cwd: b.cwd.trim(), permissionMode: b.permissionMode === 'auto' ? 'auto' : 'ask', isolate: b.isolate === true }));
        return;
      }
      case '/api/opensession':
        json(res, 200, await core.openOldSession({ backend: b.backend, sessionId: String(b.sessionId), cwd: String(b.cwd), agentId: b.agentId ? String(b.agentId) : null, name: String(b.name || '舊對話').slice(0, 40), character: String(b.character ?? ''), model: String(b.model ?? '') }));
        return;
      case '/api/persona':
        if (typeof b.character !== 'string' || typeof b.text !== 'string') { json(res, 400, { error: '角色或內容不正確' }); return; }
        core.setPersona(b.character, b.text);
        break;
      case '/api/revert': json(res, 200, await core.revertTask(String(b.taskId), Array.isArray(b.paths) ? b.paths.map(String) : null)); return;
      case '/api/commit': json(res, 200, { commit: await core.commitTask(String(b.taskId), String(b.message ?? '')) }); return;
      case '/api/merge': json(res, 200, { commit: await core.mergeWorktree(id) }); return;
      case '/api/settings':
        if (Number.isInteger(b.maxActive)) core.setMaxActive(b.maxActive);
        if (Number.isInteger(b.quotaStop)) core.setQuotaStop(b.quotaStop);
        break;
      default: res.writeHead(404).end(); return;
    }
    json(res, 200, { ok: true });
    };
    await run();
    if (rule.log && res.statusCode === 200) audit(device, access.role, action, target, auditDetail(action, b), true);
    return;
  }
  res.writeHead(404).end();
}
