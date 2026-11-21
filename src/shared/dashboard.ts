// 總覽儀表的資料型別與計算。主行程、畫面與手機版共用;只有型別匯入,不依賴 Electron,
// 單元測試(tests/dashboard.test.mjs)可以直接載入這個檔案。
import type { AgentState, Backend, BackendUsage, UsageWindow } from './types';

/** 本機日期(YYYY-MM-DD)。每日預算、花費與任務統計都以本機的日期分天。 */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 往前或往後移動幾天(以日曆日計算,不受日光節約時間影響)。 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + days, 12).getTime());
}

/** 這一天所在那一週的週一(「本週」從週一算起)。 */
export function weekStart(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(y, m - 1, d, 12).getDay();
  return shiftDate(date, -((dow + 6) % 7));
}

// ---------- 每週額度與每日預算

/** 每日預算依據的額度視窗;days 是這個視窗的長度(每週是 7)。 */
export interface BudgetWindow { window: UsageWindow; days: number }

const WEEKLY = /每週|每周|weekly|week/i;

/**
 * 找出每日預算要依據的額度視窗:
 * 1. 不分模型的「每週」額度(名稱剛好是「每週」的優先);
 * 2. 只有依模型分組的每週額度時(例如 Antigravity),取用量最高的那一組;
 * 3. 沒有每週額度,但有以天計算的額度(例如「3 天」)時,取最長的那一個;
 * 4. 只有以小時計算的額度、或完全沒有資料時回傳 null(這個後台不計算每日預算)。
 */
export function budgetWindow(windows: UsageWindow[] | undefined | null): BudgetWindow | null {
  const list = (windows ?? []).filter(w => w && typeof w.label === 'string' && Number.isFinite(w.used));
  const weekly = list.filter(w => WEEKLY.test(w.label));
  const plain = weekly.filter(w => !w.group);
  if (plain.length) return { window: plain.find(w => w.label.trim() === '每週') ?? plain[0], days: 7 };
  if (weekly.length) return { window: weekly.reduce((m, w) => (w.used > m.used ? w : m)), days: 7 };
  let best: BudgetWindow | null = null;
  for (const w of list) {
    const n = Number(/^\s*(\d+)\s*天\s*$/.exec(w.label)?.[1] ?? 0);
    if (n >= 2 && (!best || n > best.days || (n === best.days && !w.group && best.window.group))) best = { window: w, days: n };
  }
  return best;
}

/** 預設的每日預算(額度百分比):額度視窗長度的倒數,每週額度是 1/7,約 14.3%。 */
export function defaultDailyBudget(days = 7): number {
  return Math.round(1000 / Math.max(1, days)) / 10;
}

/** 整理使用者設定的每日預算:0 到 100、取到小數一位;不是數字時回傳 null(用預設值)。0 表示不提醒。 */
export function normalizeBudget(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 10) / 10;
}

/** 某個後台某一天的額度起點。base、last 是 0 到 1 的已用比例;今天的用量 = last − base。 */
export interface QuotaBaseline {
  date: string;
  backend: Backend;
  /** 今天的起點:今天第一次讀到的每週額度已用比例(昨天有讀數而且額度沒重置時,沿用昨天最後的讀數)。 */
  base: number;
  /** 最近一次讀到的已用比例。 */
  last: number;
  /** 最近一次讀到的重置時間(秒);後台沒有回報時是 null。 */
  resetsAt: number | null;
  /** 今天已經念過「超過每日預算」的語音提醒。 */
  warned: boolean;
}

export interface QuotaReading { date: string; used: number; resetsAt: number | null }

/** 兩次讀數之間,額度降了這麼多就視為額度視窗重置了(而不是讀數的小幅誤差)。 */
const RESET_DROP = 0.05;

/** 額度視窗在兩次讀數之間重置了嗎:已用比例明顯下降,或重置時間往後跳了一天以上而且已用比例沒有增加。 */
export function quotaReset(prev: Pick<QuotaBaseline, 'last' | 'resetsAt'>, next: Pick<QuotaReading, 'used' | 'resetsAt'>): boolean {
  if (next.used < prev.last - RESET_DROP) return true;
  return prev.resetsAt !== null && next.resetsAt !== null && next.resetsAt - prev.resetsAt > 86400 && next.used < prev.last;
}

/**
 * 讀到一筆新的每週額度後,算出新的起點紀錄。
 * - 今天還沒有紀錄:這筆讀數就是今天的起點。例外:昨天有讀數、而且額度沒有重置時,沿用昨天最後的讀數當起點,
 *   這樣今天第一個回合的用量(讀數是回合結束才回報的)才不會漏算。
 * - 今天已有紀錄:起點不變;額度在今天重置時起點歸零,從重置後重新累計。
 * - 讀數比起點還低但降幅很小(讀數誤差、滾動視窗):把起點壓到這筆讀數,今天的用量不會是負的。
 */
export function nextBaseline(prev: QuotaBaseline | null, backend: Backend, reading: QuotaReading): QuotaBaseline {
  const used = Math.max(0, Math.min(1, reading.used));
  const fresh: QuotaBaseline = { date: reading.date, backend, base: used, last: used, resetsAt: reading.resetsAt, warned: false };
  if (!prev) return fresh;
  const r = { used, resetsAt: reading.resetsAt };
  if (prev.date !== reading.date) {
    if (prev.date === shiftDate(reading.date, -1) && !quotaReset(prev, r) && used >= prev.last) return { ...fresh, base: prev.last };
    return fresh;
  }
  if (quotaReset(prev, r)) return { ...prev, base: 0, last: used, resetsAt: reading.resetsAt };
  return { ...prev, base: Math.min(prev.base, used), last: used, resetsAt: reading.resetsAt ?? prev.resetsAt };
}

/**
 * 今天用掉的額度百分比(0 到 100,取到小數一位)。今天還沒有讀數時:昨天有讀數而且額度還沒到重置時間,算 0;
 * 否則回傳 null(還不知道)。
 */
export function todayUsedPercent(b: QuotaBaseline | null, date: string, nowMs: number): number | null {
  if (!b) return null;
  if (b.date === date) return Math.round(Math.max(0, b.last - b.base) * 1000) / 10;
  if (b.date === shiftDate(date, -1) && (b.resetsAt === null || b.resetsAt * 1000 > nowMs)) return 0;
  return null;
}

/** none:沒有預算(設成 0 或沒有資料);ok:還在預算內;near:用到預算的八成以上;over:超過預算。 */
export type BudgetLevel = 'none' | 'ok' | 'near' | 'over';
export const BUDGET_NEAR = 0.8;

export function budgetLevel(usedPercent: number | null, budgetPercent: number): BudgetLevel {
  if (usedPercent === null || !(budgetPercent > 0)) return 'none';
  if (usedPercent > budgetPercent + 1e-9) return 'over';
  return usedPercent >= budgetPercent * BUDGET_NEAR - 1e-9 ? 'near' : 'ok';
}

/** 一家後台今天的預算狀況,送給畫面顯示。百分比都是「佔每週額度的百分比」。 */
export interface BudgetStatus {
  backend: Backend;
  /** 預算依據的額度視窗名稱(例如「每週」);這個後台沒有每週額度時是 null,不計算預算。 */
  window: string | null;
  /** 額度視窗的長度(天),預設預算是它的倒數。 */
  days: number;
  /** 生效中的每日預算(%);0 表示不提醒。 */
  budget: number;
  /** 使用者自己調整過(false 表示用預設值)。 */
  custom: boolean;
  /** 今天已用(%);還沒有讀數時是 null。 */
  used: number | null;
  level: BudgetLevel;
}

export function budgetStatus(backend: Backend, usage: BackendUsage | undefined, baseline: QuotaBaseline | null, custom: number | null, date: string, nowMs: number): BudgetStatus {
  const bw = usage && !usage.unsupported ? budgetWindow(usage.windows) : null;
  if (!bw) return { backend, window: null, days: 7, budget: custom ?? defaultDailyBudget(7), custom: custom !== null, used: null, level: 'none' };
  const budget = custom ?? defaultDailyBudget(bw.days);
  const used = todayUsedPercent(baseline, date, nowMs);
  return { backend, window: bw.window.group && !bw.window.label.includes(bw.window.group) ? `${bw.window.group} ${bw.window.label}` : bw.window.label, days: bw.days, budget, custom: custom !== null, used, level: budgetLevel(used, budget) };
}

// ---------- 花費與任務統計

/** 某一天、某個後台、某個節點的花費累計。 */
export interface SpendRow { date: string; backend: Backend; agentId: string; agentName: string; tokens: number; usd: number }
export interface Cost { tokens: number; usd: number }
export interface SpendSummary {
  total: Cost;
  byBackend: Array<{ backend: Backend } & Cost>;
  byAgent: Array<{ agentId: string; agentName: string; backend: Backend } & Cost>;
}

/** 把 from 到 to(含)這段日期的花費依後台與節點加總;節點依 token 數由多到少排。 */
export function sumSpend(rows: SpendRow[], from: string, to: string): SpendSummary {
  const total: Cost = { tokens: 0, usd: 0 };
  const backends = new Map<Backend, Cost>();
  const agents = new Map<string, { agentId: string; agentName: string; backend: Backend } & Cost>();
  for (const r of rows) {
    if (r.date < from || r.date > to) continue;
    total.tokens += r.tokens; total.usd += r.usd;
    const b = backends.get(r.backend) ?? { tokens: 0, usd: 0 };
    b.tokens += r.tokens; b.usd += r.usd;
    backends.set(r.backend, b);
    const a = agents.get(r.agentId) ?? { agentId: r.agentId, agentName: r.agentName, backend: r.backend, tokens: 0, usd: 0 };
    a.tokens += r.tokens; a.usd += r.usd;
    // 節點改過名字時用最新一天的名字
    if (r.agentName) a.agentName = r.agentName;
    agents.set(r.agentId, a);
  }
  return {
    total,
    byBackend: [...backends].map(([backend, c]) => ({ backend, ...c })),
    byAgent: [...agents.values()].sort((x, y) => y.tokens - x.tokens || y.usd - x.usd || x.agentName.localeCompare(y.agentName)),
  };
}

/** 某個節點今天的任務數:交辦(今天開始的任務)、完成、失敗、中斷;running 是還沒結束的。 */
export interface TaskStatRow { agentId: string; assigned: number; done: number; failed: number; interrupted: number; running: number }
export type TaskCount = Omit<TaskStatRow, 'agentId'>;

export function countTasks(rows: Array<{ agentId: string; status: string }>): TaskStatRow[] {
  const out = new Map<string, TaskStatRow>();
  for (const r of rows) {
    const s = out.get(r.agentId) ?? { agentId: r.agentId, assigned: 0, done: 0, failed: 0, interrupted: 0, running: 0 };
    s.assigned++;
    if (r.status === 'done') s.done++;
    else if (r.status === 'failed') s.failed++;
    else if (r.status === 'interrupted') s.interrupted++;
    else s.running++;
    out.set(r.agentId, s);
  }
  return [...out.values()];
}

export function totalTasks(rows: TaskStatRow[]): TaskCount {
  const t: TaskCount = { assigned: 0, done: 0, failed: 0, interrupted: 0, running: 0 };
  for (const r of rows) { t.assigned += r.assigned; t.done += r.done; t.failed += r.failed; t.interrupted += r.interrupted; t.running += r.running; }
  return t;
}

/** 主行程推給畫面的儀表資料(額度本身在 usage,節點狀態在 agents;這裡是需要資料庫才算得出來的部分)。 */
export interface DashboardData {
  /** 今天的本機日期。 */
  date: string;
  /** 本週的第一天(週一)。 */
  weekStart: string;
  budgets: BudgetStatus[];
  /** 本週到今天的花費,每天、每個後台、每個節點一筆。 */
  spend: SpendRow[];
  /** 今天的任務統計,每個節點一筆。 */
  tasks: TaskStatRow[];
  /** 節點出錯或失聯超過這段時間(毫秒)就提醒。 */
  faultWarnMs: number;
}

// ---------- 狀態數字與提醒

interface StatusAgent { id: string; state: AgentState; parentId: string | null; queued: unknown[] }

/**
 * 儀表的四個狀態數字各自包含哪些節點:
 * running 執行中(規劃中或執行中的最上層節點)、waiting 等你處理(等待授權或回答,子代理也算)、
 * queued 排隊(有排隊指令的節點)、fault 異常(出錯或失聯的最上層節點)。
 */
export function statusGroups<T extends StatusAgent>(agents: T[]): { running: T[]; waiting: T[]; queued: T[]; fault: T[] } {
  const top = agents.filter(a => !a.parentId);
  return {
    running: top.filter(a => a.state === 'planning' || a.state === 'working'),
    waiting: agents.filter(a => a.state === 'awaiting'),
    queued: top.filter(a => a.queued.length > 0),
    fault: top.filter(a => a.state === 'error' || a.state === 'lost'),
  };
}

/** 額度用到幾 % 開始提醒「快滿了」:90%,或設了額度上限時是上限的前 5%(取較低的)。 */
export function quotaWarnPercent(quotaStop: number): number {
  return quotaStop > 0 ? Math.min(90, Math.max(0, quotaStop - 5)) : 90;
}

/** 預設:節點出錯或失聯超過 10 分鐘就提醒。 */
export const FAULT_WARN_MS = 10 * 60 * 1000;

export type DashWarning =
  | { kind: 'budget'; level: 'near' | 'over'; backend: Backend; used: number; budget: number }
  | { kind: 'quota'; backend: Backend; label: string; group?: string; used: number; resetsAt: number | null }
  | { kind: 'fault'; agentId: string; agentName: string; state: 'error' | 'lost'; minutes: number };

export interface WarningInput {
  usage: BackendUsage[];
  budgets: BudgetStatus[];
  quotaStop: number;
  agents: Array<{ id: string; name: string; state: AgentState; parentId: string | null; stateSince?: number }>;
  now: number;
  faultWarnMs?: number;
}

/** 儀表要顯示的提醒,嚴重的排前面:超過預算、額度快滿、節點異常太久、預算快用完。 */
export function dashWarnings(input: WarningInput): DashWarning[] {
  const out: DashWarning[] = [];
  for (const b of input.budgets) if (b.level === 'over' && b.used !== null) out.push({ kind: 'budget', level: 'over', backend: b.backend, used: b.used, budget: b.budget });
  const at = quotaWarnPercent(input.quotaStop);
  for (const u of input.usage) {
    if (u.unsupported) continue;
    for (const w of u.windows) if (w.used * 100 >= at - 1e-9) out.push({ kind: 'quota', backend: u.backend, label: w.label, ...(w.group ? { group: w.group } : {}), used: Math.round(w.used * 100), resetsAt: w.resetsAt });
  }
  const limit = input.faultWarnMs ?? FAULT_WARN_MS;
  for (const a of input.agents) {
    if (a.parentId || (a.state !== 'error' && a.state !== 'lost') || !a.stateSince) continue;
    const ms = input.now - a.stateSince;
    if (ms >= limit) out.push({ kind: 'fault', agentId: a.id, agentName: a.name, state: a.state, minutes: Math.floor(ms / 60000) });
  }
  for (const b of input.budgets) if (b.level === 'near' && b.used !== null) out.push({ kind: 'budget', level: 'near', backend: b.backend, used: b.used, budget: b.budget });
  return out;
}

export const percentText = (n: number): string => `${Number.isInteger(n) ? n : n.toFixed(1)}%`;

/** 提醒的文字。labels 是後台的顯示名稱(BACKEND_LABEL)。 */
export function warningText(w: DashWarning, labels: Record<Backend, string>): string {
  switch (w.kind) {
    case 'budget':
      return w.level === 'over'
        ? `${labels[w.backend]} 今天已用 ${percentText(w.used)},超過每日預算 ${percentText(w.budget)}`
        : `${labels[w.backend]} 今天已用 ${percentText(w.used)},快到每日預算 ${percentText(w.budget)}`;
    case 'quota':
      return `${labels[w.backend]} 的${w.group && !w.label.includes(w.group) ? `「${w.group}」` : ''}${w.label}額度已用 ${w.used}%,快滿了`;
    case 'fault':
      return `${w.agentName} ${w.state === 'lost' ? '失聯' : '出錯'}已經 ${w.minutes < 1 ? '一陣子' : `${w.minutes} 分鐘`}`;
  }
}

export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

export function formatUsd(n: number): string {
  if (!(n > 0)) return '—';
  return `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
}
