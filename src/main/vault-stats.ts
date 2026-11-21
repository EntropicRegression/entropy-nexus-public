import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend, DispatchEntry, MemoryEntry, TaskInfo } from '../shared/types';
import { BACKEND_LABEL } from '../shared/types.ts';
import { computeNodeStats, isWorkTask } from '../shared/node-stats.ts';
import { parseFrontMatter } from './memory-vault.ts';
import type { CharacterImages } from './vault-images.ts';

/**
 * .nexus-stats.json:寫在記憶庫根目錄、給記憶庫管理 app 讀的節點統計(設計見 docs/記憶設計討論.md「第二輪定案」10、11)。
 * 這個檔案不依賴 Electron:建構內容(buildVaultStats)是純函式,寫檔(atomicWriteJson)與限頻(StatsWriter)可以用假的時鐘與檔案系統測試。
 * 檔案格式:鍵名都是中文;時間用 ISO 字串(UTC);路徑都是絕對路徑或 null。內容見 buildVaultStats。
 */
export const STATS_FILE = '.nexus-stats.json';
export const STATS_MIN_INTERVAL_MS = 5000;
export const COLLAB_DAYS = 30;
const DAY = 24 * 3600 * 1000;

export interface MeetingRecord { id: string; startedAt: number; endedAt: number; /** 主持人加參與者的節點 id。 */ ids: string[] }
export interface NodeLite { id: string; name: string; character: string; backend: Backend | null; sessionId: string | null; cwd: string }
/** 從封存檔讀回來的資料(節點已經不在資料庫、或資料庫的任務紀錄已被清掉時的來源)。 */
export interface ArchiveInfo {
  nodeId: string; name: string; character: string; backend: Backend | null; sessionId: string | null; cwd: string;
  tasks: number; done: number; completionRate: number | null; accepted: number; rejected: number; cases: number;
  /** 圖像快照的絕對路徑;沒有就是 null。 */
  avatar: string | null; portrait: string | null; at: number;
}
export interface StatsInput {
  now: number;
  portraitsDir: string;
  live: Array<NodeLite & { state: string }>;
  removed: NodeLite[];
  archives: ArchiveInfo[];
  tasks: TaskInfo[];
  cases: MemoryEntry[];
  dispatches: DispatchEntry[];
  meetings: MeetingRecord[];
  /** CLI 自己紀錄裡的 session(`<後台>:<sessionId>`);還沒查到或查不了是 null。 */
  cliSessions: Set<string> | null;
  dirExists(p: string): boolean;
  images(character: string): CharacterImages;
}

const round2 = (r: number | null): number | null => (r === null ? null : Math.round(r * 100) / 100);

/**
 * 組出 .nexus-stats.json 的內容。
 * - 節點:面板上的(線上或休眠)、已終止還留著 session 的、只剩封存檔的;同一個節點ID 以前面的為準。
 *   統計用任務紀錄(排除封存與判例請求);任務紀錄已被清掉的封存節點改用封存檔裡的數字。專案是做過的專案名稱(最近的在前)。
 * - session.CLI有紀錄:session 出現在後台自己的紀錄清單裡;清單還沒查到時是 null。可接回:不在面板上、有 sessionId、工作目錄還在、而且有任一邊的紀錄。
 * - 協作:最近 30 天的交辦(ask_node),依 從→到 彙總;同席:最近 30 天的會議,依參與的節點組合彙總(含主持人)。
 */
export function buildVaultStats(i: StatsInput) {
  const stats = computeNodeStats(i.tasks, isWorkTask);
  const caseCount = new Map<string, number>();
  for (const c of i.cases) if (c.kind === 'case' && c.nodeId) caseCount.set(c.nodeId, (caseCount.get(c.nodeId) ?? 0) + 1);
  const latest = new Map<string, ArchiveInfo>();
  for (const a of i.archives) { const o = latest.get(a.nodeId); if (!o || a.at >= o.at) latest.set(a.nodeId, a); }

  const nodes: Record<string, unknown> = {};
  const add = (n: NodeLite, status: '線上' | '休眠' | '封存', onBoard: boolean, known: boolean) => {
    if (nodes[n.id]) return;
    const s = stats.get(n.id);
    const a = latest.get(n.id);
    const fromTasks = !!s?.tasks;
    const imgs = status === '封存' ? { avatar: a?.avatar ?? null, portrait: a?.portrait ?? null } : i.images(n.character);
    const sessionId = n.sessionId || a?.sessionId || null;
    const backend = n.backend ?? a?.backend ?? null;
    const dirOk = !!n.cwd && i.dirExists(n.cwd);
    const cli = !sessionId || !backend ? false : i.cliSessions ? i.cliSessions.has(`${backend}:${sessionId}`) : null;
    nodes[n.id] = {
      名稱: n.name, 角色: n.character || null, 狀態: status,
      任務數: fromTasks ? s!.tasks : a?.tasks ?? 0,
      完成數: fromTasks ? s!.done : a?.done ?? 0,
      完成率: fromTasks ? round2(s!.completionRate) : round2(a?.completionRate ?? null),
      驗收數: fromTasks ? s!.accepted : a?.accepted ?? 0,
      退回數: fromTasks ? s!.rejected : a?.rejected ?? 0,
      判例數: caseCount.get(n.id) || a?.cases || 0,
      專案: (s?.projects ?? []).map(p => p.name),
      頭像路徑: imgs.avatar, 立繪路徑: imgs.portrait,
      session: {
        後台: backend, sessionId, 主控台有紀錄: known, CLI有紀錄: cli, 工作目錄存在: dirOk,
        可接回: !onBoard && !!sessionId && dirOk && (known || cli === true),
      },
    };
  };
  for (const n of i.live) add(n, n.state === 'sleeping' ? '休眠' : '線上', true, !!n.sessionId);
  for (const n of i.removed) add(n, '封存', false, true);
  for (const a of latest.values()) {
    add({ id: a.nodeId, name: a.name, character: a.character, backend: a.backend, sessionId: a.sessionId, cwd: a.cwd }, '封存', false, false);
  }

  const since = i.now - COLLAB_DAYS * DAY;
  const collab = new Map<string, { 從: string; 到: string; 次數: number; last: number }>();
  for (const d of i.dispatches) {
    if (d.startedAt < since) continue;
    const k = `${d.fromId}\n${d.toId}`;
    const c = collab.get(k) ?? { 從: d.fromId, 到: d.toId, 次數: 0, last: 0 };
    c.次數++; c.last = Math.max(c.last, d.startedAt);
    collab.set(k, c);
  }
  const seats = new Map<string, { 節點: string[]; 次數: number }>();
  for (const m of i.meetings) {
    if (m.startedAt < since) continue;
    const ids = [...new Set(m.ids)].sort();
    if (ids.length < 2) continue;
    const k = ids.join('\n');
    const e = seats.get(k) ?? { 節點: ids, 次數: 0 };
    e.次數++;
    seats.set(k, e);
  }
  return {
    更新時間: new Date(i.now).toISOString(),
    圖像目錄: i.portraitsDir,
    節點: nodes,
    協作: [...collab.values()].sort((a, b) => b.last - a.last).map(c => ({ 從: c.從, 到: c.到, 次數: c.次數, 最後: new Date(c.last).toISOString() })),
    同席: [...seats.values()].sort((a, b) => b.次數 - a.次數),
  };
}

const ARCHIVE_RE = /^nodes\/封存\/.+\.md$/;
const num = (v: unknown): number => { const n = Number(Array.isArray(v) ? v[0] : v); return Number.isFinite(n) ? n : 0; };
const str = (v: unknown): string => (Array.isArray(v) ? v.join('、') : String(v ?? ''));

/** 讀封存檔的屬性(只讀檔頭);圖像路徑解析成絕對路徑,檔案不在就是 null。 */
export function readArchives(vaultDir: string, entries: MemoryEntry[]): ArchiveInfo[] {
  const out: ArchiveInfo[] = [];
  const labelToId = new Map(Object.entries(BACKEND_LABEL).map(([id, label]) => [label, id as Backend]));
  for (const e of entries) {
    if (e.kind !== 'node' || e.status !== '封存' || !e.nodeId || !ARCHIVE_RE.test(e.path)) continue;
    let meta;
    try { meta = parseFrontMatter(readFileSync(join(vaultDir, ...e.path.split('/')), 'utf8').slice(0, 64 * 1024)).meta; } catch { continue; }
    const dir = e.path.split('/').slice(0, -1);
    const abs = (v: unknown): string | null => {
      const rel = str(v).trim();
      if (!rel || rel.split('/').includes('..')) return null;
      const p = join(vaultDir, ...dir, ...rel.split('/'));
      return existsSync(p) ? p : null;
    };
    const idRaw = str(meta.get('後台ID'));
    const backend = (idRaw in BACKEND_LABEL ? idRaw : labelToId.get(str(meta.get('後台')))) as Backend | undefined;
    const rate = meta.get('完成率');
    const character = str(meta.get('角色'));
    out.push({
      nodeId: e.nodeId, name: str(meta.get('節點')) || e.title, character: character === '(無)' ? '' : character, backend: backend ?? null,
      sessionId: str(meta.get('sessionId')) || null, cwd: str(meta.get('工作目錄')),
      tasks: num(meta.get('任務數')), done: num(meta.get('完成數')), completionRate: rate === undefined || rate === '' ? null : num(rate),
      accepted: num(meta.get('驗收數')), rejected: num(meta.get('退回數')), cases: num(meta.get('判例數')),
      avatar: abs(meta.get('頭像')), portrait: abs(meta.get('立繪')), at: e.updatedAt,
    });
  }
  return out;
}

export interface AtomicOptions {
  attempts?: number;
  delayMs?: number;
  rename?: (from: string, to: string) => void;
  write?: (file: string, data: string) => void;
  sleep?: (ms: number) => Promise<void>;
}
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * 原子寫入 JSON:先寫 <file>.tmp 再改名取代;Windows 上管理 app 正在讀、改名被拒(EPERM、EBUSY、EACCES)時短暫重試,
 * 仍然失敗就清掉暫存檔、回傳 false(留到下一輪)。其他錯誤也回傳 false,不丟出例外。
 */
// 非同步版本:統計每 5 秒最多寫一次,重試時用 setTimeout 等待,不卡住主行程。主控台關閉前要同步寫完的場合用 vault-sidecar.ts 的 writeJsonAtomic。
export async function atomicWriteJson(file: string, data: unknown, o: AtomicOptions = {}): Promise<boolean> {
  const attempts = o.attempts ?? 5, delay = o.delayMs ?? 60;
  const rename = o.rename ?? renameSync, write = o.write ?? ((f, d) => writeFileSync(f, d));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const tmp = `${file}.tmp`;
  try { write(tmp, JSON.stringify(data, null, 1)); } catch { return false; }
  for (let k = 0; k < attempts; k++) {
    try { rename(tmp, file); return true; }
    catch (e) {
      if (!RETRY_CODES.has((e as NodeJS.ErrnoException)?.code ?? '') || k === attempts - 1) break;
      await sleep(delay * (k + 1));
    }
  }
  try { unlinkSync(tmp); } catch { /* 暫存檔不在就算了 */ }
  return false;
}

/** 限頻寫出:request() 可以隨時呼叫,距離上次寫入不到 minMs 就延後到時間到再寫一次(多次呼叫合併成一次)。 */
export class StatsWriter {
  private last = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private again = false;
  private build: () => unknown;
  private write: (data: unknown) => Promise<boolean>;
  private minMs: number;
  private clock: () => number;
  constructor(build: () => unknown, write: (data: unknown) => Promise<boolean>, minMs = STATS_MIN_INTERVAL_MS, clock: () => number = Date.now) {
    this.build = build; this.write = write; this.minMs = minMs; this.clock = clock;
  }

  request(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.minMs - this.clock());
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, wait);
  }

  async flush(): Promise<boolean> {
    if (this.busy) { this.again = true; return false; }
    this.busy = true;
    this.last = this.clock();
    let ok = false;
    try { ok = await this.write(this.build()); } catch { ok = false; }
    this.busy = false;
    if (!ok || this.again) { this.again = false; this.request(); }
    return ok;
  }

  stop(): void { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}
