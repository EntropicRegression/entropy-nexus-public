/**
 * 節點 session 存點(docs/session存點規劃.md):終止節點時把那段對話在各家工具裡的原始檔複製一份進記憶庫,
 * 之後工具把原檔清掉(Claude Code 預設 30 天)時還能還原、續接。
 *
 * 存放:memory-vault/nodes/封存/_存點/<節點ID>/<YYYYMMDD-HHmmss>[-n]/{存點.json, files/<根目錄>/<相對位置>}
 * - 底線資料夾:主控台索引不收、memory_read 拒讀,寶庫的掃描也跳過;節點讀不到這些原始對話。
 * - 先寫進同一層的 .<名稱>.tmp 暫存資料夾,全部完成才改名,寫到一半失敗不會留下不完整的存點。
 * - 原始對話不能遮罩(遮了就無法續接),只複製、不改內容。
 * - 工具的資料夾只讀;不跟隨符號連結與 junction(資料夾本身與底下都一樣)。
 *
 * 純 Node(不依賴 Electron);各家工具的資料夾由 SessionRoots 傳入,測試可以指向暫存的假資料夾。
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Backend } from '../shared/types';
import { ARCHIVE_DIR } from './memory-archive';

/** 存點的資料夾(相對記憶庫,用 /)。 */
export const SAVEPOINT_DIR = `${ARCHIVE_DIR}/_存點`;
export const SAVEPOINT_MANIFEST = '存點.json';
/** 單一存點超過這個大小時仍然建立,但在結果裡提醒。 */
export const SAVEPOINT_WARN_BYTES = 500 * 1024 * 1024;

/** 各家工具存放 session 的根目錄。claude 是 ~/.claude、codex 是 ~/.codex、agy 是 ~/.gemini/antigravity-cli。 */
export interface SessionRoots { claude: string; codex: string; agy: string }
export type RootKey = keyof SessionRoots;

/**
 * 預設的根目錄。NEXUS_SESSION_HOME 指向一個資料夾時,改用它底下的 .claude、.codex、.gemini/antigravity-cli
 * (e2e 測試用,不碰真正的家目錄)。
 */
export function defaultSessionRoots(env: Record<string, string | undefined> = process.env): SessionRoots {
  const home = env.NEXUS_SESSION_HOME?.trim() || homedir();
  return { claude: join(home, '.claude'), codex: join(home, '.codex'), agy: join(home, '.gemini', 'antigravity-cli') };
}

export interface SavepointFile {
  /** 相對根目錄的位置(用 /),還原時放回 <根目錄>/<位置>。 */
  位置: string;
  根目錄: RootKey;
  大小: number;
  sha256: string;
}

export interface SavepointManifest {
  版本: 1;
  節點ID: string;
  節點: string;
  後台: string;
  後台ID: Backend;
  sessionId: string;
  工作目錄: string;
  建立時間: string;
  原因: '終止';
  檔案: SavepointFile[];
  總大小: number;
}

export interface SavepointNode { id: string; name: string; backend: Backend; backendLabel: string; sessionId: string | null; cwd: string }

export type SavepointResult =
  /** skipped:定位到、但複製時已經不見的附屬檔(例如 SQLite 關閉時刪掉的 -wal);主檔不見才算失敗。 */
  | { ok: true; path: string; size: number; files: number; warnLarge: boolean; skipped: number }
  | { ok: false; reason: string };

/** 節點 ID 與 sessionId 只接受英數字、底線、連字號(避免路徑跳出)。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SESSION_RE = /^[A-Za-z0-9_-]{8,128}$/;

const pad = (n: number) => String(n).padStart(2, '0');
/** 存點資料夾名稱:本機時間 YYYYMMDD-HHmmss。 */
export const savepointStamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
/** 帶時區位移的本機 ISO 時間(例如 2026-11-23T20:00:00+08:00)。 */
export function localIso(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const list = (dir: string): Dirent[] => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
/** 路徑本身是一般檔案(不是符號連結);lstat 不跟隨連結。 */
const isPlainFile = (p: string): boolean => { try { const s = lstatSync(p); return s.isFile() && !s.isSymbolicLink(); } catch { return false; } };
/** 路徑本身是一般資料夾(不是符號連結或 junction;Node 在 Windows 上把 junction 也當成符號連結)。 */
const isPlainDir = (p: string): boolean => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };

/** 資料夾底下所有檔案(相對 base,用 /);資料夾本身與底下都不跟隨符號連結與 junction,最多 depth 層。 */
function filesUnder(base: string, rel: string, depth = 12): string[] {
  if (depth < 0 || !isPlainDir(join(base, ...rel.split('/')))) return [];
  const out: string[] = [];
  for (const e of list(join(base, ...rel.split('/')))) {
    const r = `${rel}/${e.name}`;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...filesUnder(base, r, depth - 1));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Codex 的對話檔:sessions/ 與 archived_sessions/ 底下(年/月/日 資料夾)檔名是 <id>.jsonl 或以 -<id>.jsonl 結尾的。 */
function codexFiles(root: string, sessionId: string): string[] {
  const out: string[] = [];
  const want = `${sessionId}.jsonl`.toLowerCase();
  // 要有邊界(整個檔名,或前面是 -),短 id 才不會誤中別的檔名結尾
  const hit = (name: string) => { const n = name.toLowerCase(); return n === want || n.endsWith(`-${want}`); };
  const walk = (rel: string, depth: number) => {
    if (depth < 0 || !isPlainDir(join(root, ...rel.split('/')))) return;
    for (const e of list(join(root, ...rel.split('/')))) {
      const r = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(r, depth - 1);
      else if (e.isFile() && hit(e.name)) out.push(r);
    }
  };
  walk('sessions', 4);
  walk('archived_sessions', 4);
  return out;
}

/**
 * 找出一段 session 在工具資料夾裡的檔案(根目錄 + 相對位置)。sessionId 格式不對或找不到時回傳空陣列。
 * - Claude Code:projects/<專案>/<id>.jsonl 與同名資料夾 projects/<專案>/<id>/(子代理紀錄等)
 * - Codex:sessions/**、archived_sessions/** 裡檔名是 <id>.jsonl 或以 -<id>.jsonl 結尾的
 * - Antigravity:conversations/<id>.db(與 -wal、-shm)與 brain/<id>/
 */
export function locateSessionFiles(backend: Backend, sessionId: string, roots: SessionRoots): Array<{ root: RootKey; rel: string }> {
  if (!SESSION_RE.test(sessionId)) return [];
  if (backend === 'claude') {
    const out: Array<{ root: RootKey; rel: string }> = [];
    if (!isPlainDir(join(roots.claude, 'projects'))) return out;
    for (const p of list(join(roots.claude, 'projects'))) {
      if (!p.isDirectory() || p.isSymbolicLink()) continue;
      const base = `projects/${p.name}`;
      const file = `${base}/${sessionId}.jsonl`;
      if (isPlainFile(join(roots.claude, ...file.split('/')))) out.push({ root: 'claude', rel: file });
      for (const f of filesUnder(roots.claude, `${base}/${sessionId}`)) out.push({ root: 'claude', rel: f });
    }
    return out;
  }
  if (backend === 'codex') return codexFiles(roots.codex, sessionId).map(rel => ({ root: 'codex' as const, rel }));
  if (backend === 'antigravity') {
    const out: Array<{ root: RootKey; rel: string }> = [];
    for (const suffix of ['.db', '.db-wal', '.db-shm']) {
      const rel = `conversations/${sessionId}${suffix}`;
      if (isPlainFile(join(roots.agy, ...rel.split('/')))) out.push({ root: 'agy', rel });
    }
    for (const f of filesUnder(roots.agy, `brain/${sessionId}`)) out.push({ root: 'agy', rel: f });
    return out;
  }
  return [];
}

/** 主檔:對話本身(Claude、Codex 的 <id>.jsonl,Antigravity 的 conversations/<id>.db);不見了就不算存點。 */
export function isMainFile(rel: string, sessionId: string): boolean {
  const n = rel.toLowerCase();
  const id = sessionId.toLowerCase();
  return n.endsWith(`${id}.jsonl`) || n === `conversations/${id}.db`;
}

/** 檔案的 sha256(串流讀,不整個載入記憶體)。 */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', d => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

const errCode = (e: unknown): string => String((e as NodeJS.ErrnoException)?.code ?? '');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * 佔用一個存點名稱:同一秒撞名加 -2、-3。暫存資料夾用不帶 recursive 的 mkdir 建立,已存在(EEXIST)就換下一個,
 * 兩個存點同時建立也不會寫進同一個資料夾。
 */
async function claimName(nodeDir: string, stamp: string): Promise<{ name: string; tmp: string }> {
  for (let k = 1; k < 1000; k++) {
    const name = k === 1 ? stamp : `${stamp}-${k}`;
    if (existsSync(join(nodeDir, name))) continue;
    const tmp = join(nodeDir, `.${name}.tmp`);
    try { await mkdir(tmp); return { name, tmp }; } catch (e) { if (errCode(e) !== 'EEXIST') throw e; }
  }
  throw new Error('同一秒建立了太多存點');
}

/** 改名;Windows 上防毒或同步軟體短暫開著檔案(EPERM、EACCES、EBUSY)時退避重試。目標已存在時不覆蓋。 */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    if (existsSync(to)) throw new Error('存點資料夾已經存在');
    try { await rename(from, to); return; } catch (e) {
      if (i >= 6 || !['EPERM', 'EACCES', 'EBUSY'].includes(errCode(e))) throw e;
      await sleep(100 * (i + 1));
    }
  }
}

/** 清掉超過 maxAgeMs 的暫存資料夾(當機或強制關閉時留下的 .<名稱>.tmp);回傳清掉幾個。 */
export async function cleanStaleSavepointTemps(vaultDir: string, maxAgeMs = 60 * 60 * 1000, now = Date.now()): Promise<number> {
  const root = join(vaultDir, ...SAVEPOINT_DIR.split('/'));
  let n = 0;
  for (const node of await readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[])) {
    if (!node.isDirectory() || node.isSymbolicLink()) continue;
    for (const e of await readdir(join(root, node.name), { withFileTypes: true }).catch(() => [] as Dirent[])) {
      if (!e.isDirectory() || e.isSymbolicLink() || !/^\..+\.tmp$/.test(e.name)) continue;
      const p = join(root, node.name, e.name);
      const st = await stat(p).catch(() => null);
      if (!st || now - st.mtimeMs < maxAgeMs) continue;
      if (await rm(p, { recursive: true, force: true }).then(() => true, () => false)) n++;
    }
  }
  return n;
}

/**
 * 建立存點。失敗(沒有 sessionId、找不到檔案、主檔不見、複製失敗)時回傳原因,不丟出例外;呼叫端照樣刪除節點。
 * 回傳的 path 相對記憶庫根目錄(nodes/封存/_存點/<節點ID>/<時間>)。
 */
export async function createSavepoint(vaultDir: string, node: SavepointNode, roots: SessionRoots, now: Date = new Date()): Promise<SavepointResult> {
  if (!node.sessionId) return { ok: false, reason: '這個節點沒有對話紀錄(sessionId),不建立存點' };
  if (!ID_RE.test(node.id)) return { ok: false, reason: '節點 ID 格式不正確,不建立存點' };
  if (!SESSION_RE.test(node.sessionId)) return { ok: false, reason: 'sessionId 格式不正確,不建立存點' };
  const sessionId = node.sessionId;
  const found = locateSessionFiles(node.backend, sessionId, roots);
  if (!found.some(f => isMainFile(f.rel, sessionId))) return { ok: false, reason: `在 ${node.backendLabel} 的資料夾裡找不到這段對話的檔案(可能已被清除)` };
  const nodeDir = join(vaultDir, ...SAVEPOINT_DIR.split('/'), node.id);
  let tmp = '';
  try {
    await mkdir(nodeDir, { recursive: true });
    const claimed = await claimName(nodeDir, savepointStamp(now));
    tmp = claimed.tmp;
    const files: SavepointFile[] = [];
    let total = 0;
    let skipped = 0;
    for (const f of found) {
      const src = join(roots[f.root], ...f.rel.split('/'));
      const dst = join(tmp, 'files', f.root, ...f.rel.split('/'));
      await mkdir(dirname(dst), { recursive: true });
      try { await copyFile(src, dst); } catch (e) {
        // 定位之後才不見的附屬檔(SQLite 關閉時刪掉 -wal、-shm 等)略過;主檔不見就整個失敗
        if (errCode(e) === 'ENOENT' && !isMainFile(f.rel, sessionId)) { skipped++; continue; }
        throw e;
      }
      // 檢查碼算複製出來的那一份:還原時拿它比對,確認存點沒有損壞
      const size = statSync(dst).size;
      files.push({ 位置: f.rel, 根目錄: f.root, 大小: size, sha256: await sha256File(dst) });
      total += size;
    }
    const manifest: SavepointManifest = {
      版本: 1, 節點ID: node.id, 節點: node.name, 後台: node.backendLabel, 後台ID: node.backend, sessionId,
      工作目錄: node.cwd, 建立時間: localIso(now), 原因: '終止', 檔案: files, 總大小: total,
    };
    await writeFile(join(tmp, SAVEPOINT_MANIFEST), JSON.stringify(manifest, null, 1));
    await renameRetry(tmp, join(nodeDir, claimed.name));
    tmp = '';
    return { ok: true, path: `${SAVEPOINT_DIR}/${node.id}/${claimed.name}`, size: total, files: files.length, warnLarge: total > SAVEPOINT_WARN_BYTES, skipped };
  } catch (e) {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: `建立存點失敗:${errCode(e) || String((e as Error)?.message ?? e)}` };
  }
}

/** 讀一個存點的說明檔;不存在、格式不對時回傳 null。dir 是相對記憶庫的路徑。 */
export function readSavepoint(vaultDir: string, dir: string): SavepointManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(vaultDir, ...dir.split('/'), SAVEPOINT_MANIFEST), 'utf8')) as SavepointManifest;
    if (m?.版本 !== 1 || typeof m.sessionId !== 'string' || !Array.isArray(m.檔案)) return null;
    return m;
  } catch {
    return null;
  }
}

/** 一個節點的所有存點(相對記憶庫的路徑,新的在前);暫存資料夾(.xxx.tmp)不列。 */
export function listSavepoints(vaultDir: string, nodeId: string): string[] {
  if (!ID_RE.test(nodeId)) return [];
  return list(join(vaultDir, ...SAVEPOINT_DIR.split('/'), nodeId))
    .filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
    .map(e => e.name)
    // 新的在前;同一秒的 -2、-10 依數字比較
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    .map(n => `${SAVEPOINT_DIR}/${nodeId}/${n}`);
}

/** 用在刪除結果的說明文字。 */
export function savepointNote(r: SavepointResult): string {
  if (!r.ok) return `沒有建立對話存點:${r.reason}。`;
  const mb = (r.size / 1024 / 1024).toFixed(1);
  return `已建立對話存點(${r.files} 個檔案,${mb} MB):${r.path}${r.skipped ? `(${r.skipped} 個附屬檔在複製前已經不見,略過)` : ''}${r.warnLarge ? '。這個存點超過 500 MB,記憶庫會變大' : ''}。`;
}
