import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentInfo, AgentState, ObservedSession, ObserveStatus } from '../shared/types';
import type { Core } from './core';
import type { Store } from './store';

/**
 * 外部觀察(hooks 附掛模式):使用者在主控台以外執行的 Claude Code,透過 HTTP hooks 把事件送到這裡,
 * 面板上以「外部觀察節點」顯示它們的狀態。
 *
 * 設計:
 * - 純觀察:接收端只聽 127.0.0.1,收到就回 200 空內容,不做任何允許或拒絕的決定,也不讓外部 CLI 等待。
 * - 路徑含隨機權杖(存在主控台的設定裡),權杖不對一律拒絕;body 有大小上限。
 * - hooks 只在使用者按下「安裝」時才寫進 Claude Code 的使用者設定檔,啟動時不碰任何設定檔。
 * - 主控台自己啟動的 CLI 也會讀到同一份 hooks:主行程設定 NEXUS_HOOK_MANAGED=1 讓子行程繼承,
 *   hook 以標頭帶回這個值,接收端就略過;另外再用 session id 比對面板上的節點。
 * - Codex 的 hooks 只有 command 型,而且各版本在 Windows 上的支援不一,目前只做 Claude Code。
 */
const PORT = Number(process.env.NEXUS_HOOKS_PORT) || 47616;
/** 我們寫進設定檔的 hook 一律用這個路徑開頭,移除時靠它辨識,不動使用者自己的 hooks。 */
const MARK = '/entropy-nexus-hook/';
const MAX_BODY = 256 * 1024;
/** 多久沒有事件就標成閒置、再多久就移除;測試時可縮短。 */
const IDLE_MS = Number(process.env.NEXUS_OBSERVE_IDLE_MS) || 10 * 60 * 1000;
const DROP_MS = Number(process.env.NEXUS_OBSERVE_DROP_MS) || 60 * 60 * 1000;
const RECENT = 8;
/**
 * 要安裝的事件。官方文件註明 SessionStart 只支援 command 與 mcp_tool 型的 hook,不能用 http,所以不裝;
 * 外部 session 會在第一個事件(通常是送出指令)時出現。接收端仍認得 SessionStart,方便測試與日後改用 command 型。
 */
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
/** 需要使用者注意的通知種類。 */
const ATTENTION = new Set(['permission_prompt', 'elicitation_dialog']);

interface Options {
  /** 推送給畫面(不送手機)。 */
  push: (u: { observed?: ObservedSession; observedRemovedId?: string }) => void;
  /** 外部節點需要你時跳系統通知。 */
  notify: (title: string, body: string) => void;
}

let core: Core;
let store: Store;
let opts: Options;
let token = '';
let server: Server | null = null;
let listening = false;
let lastError = '';
let timer: NodeJS.Timeout | null = null;
const sessions = new Map<string, ObservedSession>();

const settingsPath = () => process.env.NEXUS_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json');
const hookUrl = () => `http://127.0.0.1:${PORT}${MARK}${token}`;

export function initObserver(c: Core, s: Store, o: Options): void {
  core = c;
  store = s;
  opts = o;
  // 主控台啟動的所有子行程都會繼承,hooks 以標頭帶回,接收端據此略過自己人
  process.env.NEXUS_HOOK_MANAGED = '1';
  try { token = JSON.parse(s.getSetting('observe') ?? '{}').token ?? ''; } catch { /* 設定壞了就重新產生 */ }
  if (!/^[0-9a-f]{32,}$/.test(token)) newToken();
  listen();
  timer = setInterval(sweep, Math.min(30000, Math.max(500, IDLE_MS / 4)));
}

export function stopObserver(): void {
  if (timer) clearInterval(timer);
  server?.close();
  server = null;
}

function newToken(): void {
  token = randomBytes(24).toString('hex');
  store.setSetting('observe', JSON.stringify({ token }));
}

function listen(): void {
  const srv = createServer((req, res) => handle(req, res));
  srv.on('error', err => {
    listening = false;
    lastError = (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
      ? `連接埠 ${PORT} 已被其他程式佔用,外部觀察無法接收事件。可以關掉佔用的程式,或用環境變數 NEXUS_HOOKS_PORT 改用其他連接埠後重新安裝 hooks。`
      : `接收端無法啟動:${err.message}`;
  });
  srv.listen(PORT, '127.0.0.1', () => { listening = true; lastError = ''; });
  server = srv;
}

export function observedList(): ObservedSession[] {
  return [...sessions.values()].map(copy);
}

const copy = (o: ObservedSession): ObservedSession => ({ ...o, recent: o.recent.map(r => ({ ...r })) });

/** 面板上的節點拿到 session id 時呼叫:同一個 session 不在外部區塊重複出現。 */
export function observerSawAgent(a: AgentInfo): void {
  if (a.sessionId && a.backend === 'claude') drop(a.sessionId);
}

function drop(id: string): void {
  if (sessions.delete(id)) opts.push({ observedRemovedId: id });
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  const done = (status: number) => { if (!res.headersSent) res.writeHead(status, { 'Content-Length': '0' }).end(); };
  const path = req.url ?? '';
  const given = path.startsWith(MARK) ? Buffer.from(path.slice(MARK.length)) : Buffer.alloc(0);
  const want = Buffer.from(token);
  if (req.method !== 'POST' || given.length !== want.length || !timingSafeEqual(given, want)) { done(403); req.resume(); return; }
  let size = 0;
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > MAX_BODY) { done(413); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    // 先回應再處理,外部 CLI 不必等主控台
    done(200);
    if (size > MAX_BODY) return;
    if (req.headers['x-nexus-managed'] === '1') return;
    try { onHook(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { /* 格式不對就略過 */ }
  });
  req.on('error', () => done(400));
}

const short = (s: unknown, n = 80) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 工具參數的一行摘要。 */
function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  return short(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? '', 60);
}

/** 把一個 hook 事件整理進外部觀察節點。 */
function onHook(b: Record<string, unknown>): void {
  const id = typeof b.session_id === 'string' ? b.session_id : '';
  const ev = typeof b.hook_event_name === 'string' ? b.hook_event_name : '';
  if (!id || !ev || id.length > 200) return;
  if (core.hasSession('claude', id)) return;
  if (ev === 'SessionEnd') { drop(id); return; }
  // 子代理裡的工具也會觸發;狀態仍算在主 session 上,摘要標明是子代理
  const sub = typeof b.agent_id === 'string' && b.agent_id ? '(子代理)' : '';
  const now = Date.now();
  let o = sessions.get(id);
  const fresh = !o;
  if (!o) {
    o = { sessionId: id, backend: 'claude', cwd: '', state: 'idle', detail: '', tool: '', startedAt: now, lastAt: now, recent: [] };
    sessions.set(id, o);
  }
  if (typeof b.cwd === 'string' && b.cwd) o.cwd = b.cwd;
  const before = o.state;
  const set = (state: AgentState, detail: string, tool = '') => { o!.state = state; o!.detail = detail; o!.tool = tool; };
  let text = '';
  const tool = short(b.tool_name, 60);
  switch (ev) {
    case 'SessionStart': set('idle', '已啟動'); text = `啟動(${short(b.source, 20) || 'startup'})`; break;
    case 'UserPromptSubmit': set('planning', '收到指令'); text = `指令:${short(b.prompt)}`; break;
    case 'PreToolUse': set('working', `${tool}${sub}`, tool); text = `工具:${tool}${sub} ${toolSummary(b.tool_input)}`.trim(); break;
    case 'PostToolUse': set('working', '思考中'); text = `工具結束:${tool}${sub}`; break;
    case 'PermissionRequest': set('awaiting', `等待授權:${tool}`, tool); text = `請求授權:${tool} ${toolSummary(b.tool_input)}`.trim(); break;
    case 'Notification': {
      const kind = short(b.notification_type, 40);
      if (ATTENTION.has(kind)) set('awaiting', short(b.message, 60) || '需要你處理', o.tool);
      else if (kind === 'idle_prompt') set('idle', '等待輸入');
      text = `通知:${short(b.message)}`;
      break;
    }
    // Stop 只在主 session 的回合結束時觸發(子代理結束是 SubagentStop,沒有裝)
    case 'Stop': set('idle', '回合結束'); text = '回合結束'; break;
    case 'StopFailure': set('error', short(b.error, 60) || '回合失敗'); text = `失敗:${short(b.last_assistant_message ?? b.error)}`; break;
    default: text = ev;
  }
  o.lastAt = now;
  if (text) { o.recent.push({ ts: now, text }); if (o.recent.length > RECENT) o.recent.splice(0, o.recent.length - RECENT); }
  opts.push({ observed: copy(o) });
  if (o.state === 'awaiting' && (before !== 'awaiting' || fresh)) {
    const where = o.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '';
    opts.notify(`外部的 Claude Code${where ? `(${where})` : ''}需要你`, `${o.detail}。請到那個終端機處理;主控台只能觀看。`);
  }
}

/**
 * 太久沒有事件:先標成閒置,再久就移除(外部 CLI 可能被直接關掉,沒送出 SessionEnd)。
 * 待授權本來就是在等人,不因為安靜就改成閒置,只在超過移除時間時才拿掉。
 */
function sweep(): void {
  const now = Date.now();
  for (const o of [...sessions.values()]) {
    const quiet = now - o.lastAt;
    if (quiet >= DROP_MS) drop(o.sessionId);
    else if (quiet >= IDLE_MS && o.state !== 'idle' && o.state !== 'awaiting') { o.state = 'idle'; o.detail = '久無動靜'; o.tool = ''; opts.push({ observed: copy(o) }); }
  }
}

/** 接手:外部節點不再觀察,改用「開啟舊 session」的流程建立正式節點。 */
export async function observeTakeover(sessionId: string, name: string): Promise<AgentInfo> {
  const o = sessions.get(sessionId);
  if (!o) throw new Error('找不到這個外部 session,可能已經結束或被移除。');
  const agent = await core.openOldSession({ backend: o.backend, sessionId, cwd: o.cwd, agentId: null, name: name.trim() || '接手的對話', character: '', model: '' });
  drop(sessionId);
  return agent;
}

// ---- hooks 的安裝與移除 ----

type Json = Record<string, any>;

/** 讀取設定檔;不存在回傳空物件,格式錯誤就丟出錯誤(絕不覆寫)。 */
function readSettings(): Json {
  const p = settingsPath();
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return {};
  let data: unknown;
  try { data = JSON.parse(raw); } catch (err) { throw new Error(`無法解析 ${p}:${(err as Error).message}。為了不破壞你的設定,沒有做任何修改。`); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${p} 的內容不是 JSON 物件,沒有做任何修改。`);
  return data as Json;
}

const isOurs = (h: unknown) => !!h && typeof h === 'object' && typeof (h as Json).url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/entropy-nexus-hook\//.test((h as Json).url);

function ourHook(): Json {
  // 外部 CLI 只等 3 秒;主控台沒開時連線會立刻被拒,不會拖慢。依官方文件,http hook 的非 2xx、連線失敗與逾時都是
  // 不阻擋的錯誤,動作照常進行;回 200 空內容等於「沒有意見」,PermissionRequest 會照常跳出原本的授權提示
  return { type: 'http', url: hookUrl(), timeout: 3, headers: { 'X-Nexus-Managed': '$NEXUS_HOOK_MANAGED' }, allowedEnvVars: ['NEXUS_HOOK_MANAGED'] };
}

/** 從設定裡拿掉我們加的 hook;拿掉後變空的群組與事件一併清掉。回傳是否有變動。 */
function strip(data: Json): boolean {
  const hooks = data.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
  let changed = false;
  for (const ev of Object.keys(hooks)) {
    const groups = hooks[ev];
    if (!Array.isArray(groups)) continue;
    const kept: unknown[] = [];
    let here = false;
    for (const g of groups) {
      if (!g || typeof g !== 'object' || !Array.isArray(g.hooks) || !g.hooks.some(isOurs)) { kept.push(g); continue; }
      here = true;
      const rest = g.hooks.filter((h: unknown) => !isOurs(h));
      if (rest.length) kept.push({ ...g, hooks: rest });
    }
    if (!here) continue;
    changed = true;
    if (kept.length) hooks[ev] = kept; else delete hooks[ev];
  }
  if (changed && !Object.keys(hooks).length) delete data.hooks;
  return changed;
}

function writeSettings(data: Json): void {
  const p = settingsPath();
  mkdirSync(dirname(p), { recursive: true });
  // 改之前先備份一份;先寫暫存檔再換名,寫到一半當掉也不會留下壞掉的設定檔
  if (existsSync(p)) copyFileSync(p, `${p}.entropy-nexus-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
  const tmp = `${p}.entropy-nexus.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}

export function observeInstall(): ObserveStatus {
  const data = readSettings();
  // 先拿掉舊的(連接埠或權杖可能已經改變),再加上目前的;重複安裝不會重複新增
  strip(data);
  if (data.hooks !== undefined && (typeof data.hooks !== 'object' || Array.isArray(data.hooks) || data.hooks === null)) throw new Error('設定檔裡的 hooks 不是物件,沒有做任何修改。');
  data.hooks ??= {};
  for (const ev of EVENTS) {
    if (data.hooks[ev] !== undefined && !Array.isArray(data.hooks[ev])) throw new Error(`設定檔裡的 hooks.${ev} 不是陣列,沒有做任何修改。`);
  }
  for (const ev of EVENTS) (data.hooks[ev] ??= []).push({ hooks: [ourHook()] });
  writeSettings(data);
  return observeStatus();
}

export function observeUninstall(): ObserveStatus {
  const data = readSettings();
  if (strip(data)) writeSettings(data);
  return observeStatus();
}

export function observeNewToken(): ObserveStatus {
  newToken();
  return observeStatus();
}

export function observeStatus(): ObserveStatus {
  let installed: ObserveStatus['installed'] = 'none';
  let settingsError = '';
  try {
    const hooks = readSettings().hooks;
    const ours = hooks && typeof hooks === 'object' ? Object.values(hooks).flatMap(g => (Array.isArray(g) ? g : [])).flatMap((g: any) => (Array.isArray(g?.hooks) ? g.hooks : [])).filter(isOurs) : [];
    if (ours.length) {
      const covered = EVENTS.every(ev => (hooks[ev] ?? []).some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: Json) => isOurs(h) && h.url === hookUrl())));
      installed = covered && ours.every((h: Json) => h.url === hookUrl()) ? 'current' : 'stale';
    }
  } catch (err) { settingsError = (err as Error).message; }
  const preview = JSON.stringify({ hooks: Object.fromEntries(EVENTS.map(ev => [ev, [{ hooks: [{ ...ourHook(), url: hookUrl().replace(token, '<權杖>') }] }]])) }, null, 2);
  return { listening, port: PORT, error: lastError, settingsPath: settingsPath(), installed, settingsError, events: EVENTS, preview };
}
