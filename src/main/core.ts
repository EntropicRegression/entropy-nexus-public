import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BACKEND_LABEL, usageWindowsFor, type MeetingView, type MemoryEntry, type SpeechNotice, type SpeechSource, type UsageWindow } from '../shared/types';
import { summarizeForSpeech } from '../shared/speech-summary';
import { budgetStatus, budgetWindow, countTasks, FAULT_WARN_MS, localDate, nextBaseline, normalizeBudget, shiftDate, weekStart, type DashboardData } from '../shared/dashboard';
import { sameLinks, trimDispatches, DISPATCH_KEEP_MS, DISPATCH_MAX } from '../shared/collab';
import type {
  DispatchEntry, LinkInfo, TaskFrom,
  AdapterEvent, AgentInfo, AgentState, ApprovalDecision, Backend, BackendUsage, Capability, ChangeSet, CreateAgentInput, ForkAgentInput, NexusEvent, OldSession, OpenOldSessionInput, PermissionMode, QueuedPrompt, RevertResult, ReviewComment, Snapshot, TaskInfo, TaskStatus, TaskVerdict, Update, WorktreeInfo, WorktreeStatus,
} from '../shared/types';
import type { Adapter, AdapterSession, StartOptions } from './adapters/adapter';
import { AntigravityAdapter } from './adapters/antigravity';
import { ClaudeAdapter } from './adapters/claude';
import { CodexAdapter } from './adapters/codex';
import { FakeAdapter } from './adapters/fake';
import { changesFromEvents, commitChanges, diffTrees, revertChanges, snapshotTree, summarizeTrees } from './changes';
import { closeAllTerminals, closeTerminal, hasTerminal, openTerminal, resizeTerminal, terminalBuffer, writeTerminal } from './terminal';
import { createWorktree, mergeBack, openPullRequest, removeWorktree, worktreeStatus } from './worktree';
import { formatCommentsPrompt, formatReviewPrompt } from '../shared/review';
import { listCharacters, PERSONA_MAX, portraitsDir, readPersona, writePersona } from './portraits';
import { characterImages } from './vault-images';
import { readArchives, type MeetingRecord, type StatsInput } from './vault-stats';
import { removeMedia } from './media';
import { projectKindFromPath, projectOf } from './project';
import { wakeTargetOf, type WakeTarget } from './wake';
import { uniqueProjects, type KnownProject } from './project-choice';
import { parseChiefTerms, updateChiefTerms, type ChiefTerm } from './chief-tenure';
import { chiefStatsSection, computeNodeStats, isWorkTask, type StatsNode } from '../shared/node-stats';
import { normalizeAgyAllow } from '../shared/agy-allow';
import { caseNumber, chiefSummaryPrompt, decideSummarizer, extractSection, SELF_SUMMARY_PROMPT, splitReview, writeArchive, type SummarySource } from './memory-archive';
import { nodeProfilePath } from './memory-write';
import { writeMeetingRecord, type MeetingRecordInput } from './meeting-record';
import { isDraftRequest, isMemoirRequest, waitForMemoir, type PromptOrigin } from './memoir';
import type { Store } from './store';
import type { MemoryVault } from './memory-vault';
import { gitCommitsAhead, gitHead, readNodeStrengths, type MemoryCaller, type MemoryToolsDeps } from './memory-tools';

/** 執行中超過這段時間沒有任何事件就標成失聯;NEXUS_STALL_MS 可在測試時縮短。 */
const STALL_MS = Number(process.env.NEXUS_STALL_MS) || 10 * 60 * 1000;
const BUSY = new Set(['planning', 'working', 'awaiting']);
/** 子代理結束後,子節點留在面板上的時間。 */
const SUB_LINGER_MS = Number(process.env.NEXUS_SUB_LINGER_MS) || 20000;

/** 總管守則裡的節點統計最多隔這麼久才再通知一次(統計有變時);NEXUS_CHIEF_STATS_MS 可在測試時縮短。 */
const CHIEF_STATS_MS = Number(process.env.NEXUS_CHIEF_STATS_MS) || 10 * 60 * 1000;
/** 節點統計只看這段時間內交辦的任務,更舊的紀錄啟動時清掉。 */
const STATS_DAYS = 180;

/** 每個節點最多排幾筆指令。 */
const MAX_QUEUED = 50;
/** 節點出錯或失聯超過這段時間,儀表就提醒;NEXUS_FAULT_WARN_MS 可在測試時縮短。 */
const FAULT_MS = Number(process.env.NEXUS_FAULT_WARN_MS) || FAULT_WARN_MS;
/** 儀表的每日紀錄(花費、額度起點、任務統計)保留幾天。 */
const DAILY_KEEP_DAYS = 90;

const DEMO_PROMPTS = ['整理這個模組', '跑一次測試', '找出效能瓶頸', '更新說明文件', '修正型別錯誤'];

/** 刪除節點前寫回憶錄用的介面(由 memory-draft.ts 的 DraftService 提供)。 */
export interface MemoirHook {
  request(agentId: string): Promise<string>;
  pending(agentId: string): boolean;
  cancel(agentId: string): void;
  /** 最近一次成功提交回憶錄的時間(沒有是 0)。 */
  submittedAt(agentId: string): number;
  /** 節點的一個回合結束(title 是任務標題,origin 是任務來源):主控台送出的回憶錄或記憶草稿請求的回合結束了還沒提交,就清掉那份請求。 */
  turnEnded(agentId: string, title: string, origin: PromptOrigin): void;
  /** 節點被刪除:清掉它的回憶錄與記憶草稿請求。 */
  forget(agentId: string): void;
}

/**
 * 核心服務:管理節點與它們的 CLI session。
 * 所有事件先寫進資料庫再推送給畫面;節點狀態只由轉接器事件決定。
 */
export class Core {
  private agents = new Map<string, AgentInfo>();
  /** 主控台自己發出、等使用者回應的授權:request id → 所屬節點、回應後要恢復的狀態說明、回呼。 */
  private ownApprovals = new Map<string, { agentId: string; resume: string; resolve: (d: ApprovalDecision) => void }>();
  private interop: ((agentId: string) => StartOptions['interop']) | null = null;
  private sessions = new Map<string, AdapterSession>();
  /** 還沒告訴 agent 的變更(改名、換角色或角色卡被編輯),在下一則指令前面一起通知。 */
  private notices = new Map<string, Set<'name' | 'persona'>>();
  /** 總管節點(主控語音模式);存在設定的 chief。 */
  private chiefId: string | null = null;
  /** 協作連線(進行中的 ask_node 與會議)與分派紀錄;由 interop 更新。 */
  private links: LinkInfo[] = [];
  /** 進行中的會議(會議室虛擬節點);interop 推過來。 */
  private meetingViews: MeetingView[] = [];
  private dispatches: DispatchEntry[] = [];
  private capabilities = new Map<Backend, Capability>();
  private autopilot = true;
  private autopilotTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastEvent = new Map<string, number>();
  private maxActive = 4;
  private quotaStop = 0;
  /** 子代理 → 子節點的對應,鍵是「父節點 id:subId」。子節點只存在記憶體,不寫進 agents 資料表。 */
  private subs = new Map<string, string>();
  /** 任務面板的資料:每句指令一筆任務。current 記錄每個節點目前的任務。 */
  private tasks = new Map<string, TaskInfo>();
  private current = new Map<string, string>();
  /** 上一次送給總管的節點統計段落與時間;用來判斷下一則指令前要不要再通知。 */
  private chiefStatsSent = { text: '', at: 0 };
  private cases: { onTaskEnded(task: TaskInfo): unknown } | null = null;
  /** 回憶錄(刪除節點前可以先請它寫一章);啟動時由 index.ts 接上草稿服務。 */
  private memoir: MemoirHook | null = null;
  /** 正在刪除流程中的節點(等回憶錄、工作總結)。 */
  private removing = new Set<string>();
  /** 記憶庫(長期記憶);沒有設定時記憶工具不可用。 */
  private vault: MemoryVault | null = null;
  /** 要在下一則指令前告訴總管的記憶相關通知(例如專案知識超過上限)。 */
  /** Antigravity 的工具白名單(見 shared/agy-allow.ts)。 */
  private agyAllow: string[] = [];
  private chiefNotes: string[] = [];
  /** 記憶庫統計(.nexus-stats.json)需要重寫時通知;由 index.ts 接上限頻寫出。 */
  onStatsDirty: (() => void) | null = null;
  /** CLI 自己紀錄裡的 session(`<後台>:<sessionId>`)快取,最多每 5 分鐘重查一次。 */
  private cliSessions: Set<string> | null = null;
  private cliSessionsAt = 0;
  private cliSessionsBusy = false;
  /** 會議紀錄(只留 30 天、最多 200 筆),給 .nexus-stats.json 的同席與判例的參與節點用。 */
  private meetingLog: MeetingRecord[] | null = null;
  private interrupted = new Set<string>();
  /** 每個節點目前這個回合 agent 說的最後兩則文字,回合正常完成時拿來做語音摘要。 */
  private turnText = new Map<string, string[]>();
  /** 語音播報的通知只推給桌面畫面(index.ts 設定)。 */
  private speechOut: (n: SpeechNotice) => void = () => {};
  /** 任務的工作目錄;節點被移除後仍要能計算變更。 */
  private taskCwd = new Map<string, string>();
  /** 各家後台帳號的剩餘額度,最後一次取得的值會存進設定,重開後仍可顯示。 */
  private usage = new Map<Backend, BackendUsage>();
  /**
   * 分支出來、還沒拿到自己 session id 的節點 → 來源 session。收到新節點的 session 事件就刪掉,
   * 之後休眠、喚醒、換模型都用新的 session id 續接。Claude Code 要等第一句指令才會建立分支的 session,
   * 在那之前休眠或重開,下次啟動仍從來源分支。存在設定的 fork:<節點 id>,重開主控台後還在。
   */
  private forks = new Map<string, string>();
  /** 正在拍快照、還沒真正送出第一句的節點;算進同時執行數,也不會被佇列重複送出。 */
  private starting = new Set<string>();
  private pumpScheduled = false;
  /** 使用者調整過的每日預算(佔每週額度的百分比);沒有調整過的後台用預設值。存在設定的 dailyBudget。 */
  private budgets = new Map<Backend, number>();
  /** 儀表資料的推送:短時間內的多次變動合併成一次。 */
  private dashTimer: NodeJS.Timeout | null = null;
  private dayTimer: NodeJS.Timeout | null = null;
  private dashDate = localDate(Date.now());
  /** 各任務上次記進每日統計的狀態,狀態沒變就不必重算儀表。 */
  private taskStatus = new Map<string, string>();

  // 三家都已接上真正的 CLI。FakeAdapter 保留給開發時測試畫面用(NEXUS_FAKE=1 時全部改用假資料)
  private adapters: Record<Backend, Adapter> = {
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    antigravity: new AntigravityAdapter(),
  };

  constructor(private store: Store, private broadcast: (u: Update) => void) {
    if (process.env.NEXUS_FAKE === '1') {
      this.adapters = { claude: new FakeAdapter('claude'), codex: new FakeAdapter('codex'), antigravity: new FakeAdapter('antigravity') };
    }
  }

  async init(): Promise<void> {
    for (const adapter of Object.values(this.adapters)) {
      this.capabilities.set(adapter.backend, await adapter.probe());
    }
    // 重開後行程都不在了:還原成休眠,由使用者喚醒續接
    for (const a of this.store.loadAgents()) {
      a.state = 'sleeping';
      a.stateSince = Date.now();
      a.detail = '';
      a.simulated = this.isSimulated(a.backend);
      // 假資料時期留下的 session 不能拿去續接真正的 CLI
      if (!a.simulated && a.sessionId?.startsWith('fake-')) a.sessionId = null;
      const fork = this.store.getSetting(`fork:${a.id}`);
      if (fork && !a.sessionId && (a.simulated || !fork.startsWith('fake-'))) this.forks.set(a.id, fork);
      this.store.updateAgent(a);
      this.agents.set(a.id, a);
    }
    for (const backend of Object.keys(this.adapters) as Backend[]) {
      let saved: BackendUsage | null = null;
      try { saved = JSON.parse(this.store.getSetting(`usage:${backend}`) ?? 'null'); } catch { /* 存壞了就當作沒有 */ }
      this.usage.set(backend, saved?.windows ? { ...saved, backend, unsupported: false } : { backend, windows: [], unsupported: false, updatedAt: 0 });
    }
    this.store.pruneDispatches(Date.now() - DISPATCH_KEEP_MS);
    // 上次關閉時還在進行的交辦:這次開啟時標成失敗
    this.dispatches = this.store.loadDispatches(DISPATCH_MAX);
    for (const d of this.dispatches) if (d.status === 'running') { d.status = 'failed'; d.endedAt = Date.now(); this.store.saveDispatch(d); }
    this.store.pruneTasks(Date.now() - STATS_DAYS * 24 * 3600 * 1000);
    // 上次關閉時還沒結束的任務,這次開啟時一律標成已中斷
    for (const t of this.store.loadTasks(200)) {
      if (t.endedAt === null) {
        t.status = 'interrupted';
        t.note = '主控台關閉時仍在執行';
        t.endedAt = Date.now();
        for (const s of t.subs) if (s.status === 'running') s.status = 'done';
        this.store.saveTask(t);
        this.store.recordTask(t.id, localDate(t.startedAt), t.agentId, t.status);
      }
      this.taskStatus.set(t.id, t.status);
      this.tasks.set(t.id, t);
      const cwd = this.agents.get(t.agentId)?.cwd;
      if (cwd) this.taskCwd.set(t.id, cwd);
    }
    const chief = this.store.getSetting('chief');
    if (chief && this.agents.has(chief)) this.chiefId = chief;
    this.recordChief();
    try { this.agyAllow = normalizeAgyAllow(JSON.parse(this.store.getSetting('agyAllow') ?? '[]')).rules; } catch { /* 設定壞了就當作沒有 */ }
    const stop = Number(this.store.getSetting('quotaStop'));
    if (Number.isInteger(stop) && stop >= 0 && stop <= 100) this.quotaStop = stop;
    const saved = Number(this.store.getSetting('maxActive'));
    if (Number.isInteger(saved) && saved >= 1) this.maxActive = saved;
    try {
      const budgets = JSON.parse(this.store.getSetting('dailyBudget') ?? '{}') as Record<string, unknown>;
      for (const backend of Object.keys(this.adapters) as Backend[]) { const v = normalizeBudget(budgets?.[backend]); if (v !== null) this.budgets.set(backend, v); }
    } catch { /* 存壞了就用預設值 */ }
    this.store.pruneDaily(shiftDate(this.dashDate, -DAILY_KEEP_DAYS));
    this.dayTimer = setInterval(() => this.dayTick(), 30000);
    this.autopilotTimer = setInterval(() => this.autopilotTick(), 2500);
    this.watchdogTimer = setInterval(() => this.watchdogTick(), Math.min(30000, Math.max(1000, STALL_MS / 4)));
  }

  isEmpty(): boolean {
    return this.agents.size === 0;
  }

  /** 第一次啟動時放幾個假資料節點,方便直接看到面板運作。 */
  seedDemo(cwd: string): void {
    const demo: Array<[string, Backend]> = [
      ['Atlas', 'claude'], ['Vega', 'claude'], ['Orion', 'codex'], ['Lyra', 'codex'], ['Nova', 'antigravity'], ['Echo', 'antigravity'],
    ];
    // 只放假資料後台的節點;真正的 CLI 節點一律由使用者自己新增
    for (const [name, backend] of demo) if (this.isSimulated(backend)) void this.createAgent({ name, character: '', model: '', backend, cwd, permissionMode: 'ask' });
  }

  snapshot(): Snapshot {
    return {
      agents: [...this.agents.values()],
      events: this.store.recentEvents(60),
      capabilities: [...this.capabilities.values()],
      autopilot: this.autopilot,
      maxActive: this.maxActive,
      quotaStop: this.quotaStop,
      tasks: [...this.tasks.values()],
      usage: [...this.usage.values()],
      characters: listCharacters(),
      portraitsDir: portraitsDir(),
      chiefId: this.chiefId,
      dashboard: this.dashboard(),
      links: this.links,
      meetings: this.meetingViews,
      dispatches: this.dispatches,
    };
  }

  /** 進行中的會議有變動時由 interop 呼叫;內容相同就不推送。 */
  setMeetings(meetings: MeetingView[]): void {
    if (JSON.stringify(meetings) === JSON.stringify(this.meetingViews)) return;
    this.meetingViews = meetings;
    this.broadcast({ meetings });
  }

  /** 協作連線有變時由 interop 呼叫;內容相同就不推送。 */
  setLinks(links: LinkInfo[]): void {
    if (sameLinks(this.links, links)) return;
    this.links = links;
    this.broadcast({ links });
  }

  /** 新增或更新一筆分派紀錄(寫進資料庫並推送給畫面)。 */
  recordDispatch(d: DispatchEntry): void {
    const i = this.dispatches.findIndex(x => x.id === d.id);
    if (i >= 0) this.dispatches[i] = d; else this.dispatches.unshift(d);
    this.dispatches = trimDispatches(this.dispatches, Date.now());
    this.store.saveDispatch(d);
    this.broadcast({ dispatches: this.dispatches });
  }

  /** 節點目前進行中的任務 id(沒有時為 undefined)。 */
  currentTaskId(agentId: string): string | undefined {
    return this.current.get(agentId);
  }

  /** 總覽儀表的資料:各後台今天的預算用量、本週的花費、今天的任務統計。額度本身在 usage,節點狀態在 agents。 */
  dashboard(): DashboardData {
    const now = Date.now();
    const date = localDate(now);
    const from = weekStart(date);
    return {
      date,
      weekStart: from,
      budgets: (Object.keys(this.adapters) as Backend[]).map(b => budgetStatus(b, this.usage.get(b), this.store.latestBaseline(b), this.budgets.get(b) ?? null, date, now)),
      spend: this.store.spendSince(from),
      tasks: countTasks(this.store.tasksOn(date)),
      faultWarnMs: FAULT_MS,
    };
  }

  /**
   * 設定某家後台的每日預算(佔每週額度的百分比,0 到 100;0 表示不提醒);null 表示改回預設值。
   * 超過預算只提醒(儀表上的警示與一次語音),不會擋下指令;擋下新指令是「額度上限」的事。
   */
  setDailyBudget(backend: Backend, percent: number | null): void {
    if (!Object.hasOwn(this.adapters, backend)) return;
    const value = percent === null ? null : normalizeBudget(percent);
    if (percent !== null && value === null) return;
    if (value === null) this.budgets.delete(backend); else this.budgets.set(backend, value);
    this.store.setSetting('dailyBudget', JSON.stringify(Object.fromEntries(this.budgets)));
    // 調高預算後回到預算內:之後再超過時要重新提醒
    const now = Date.now();
    const b = this.store.latestBaseline(backend);
    if (b?.warned && b.date === localDate(now) && budgetStatus(backend, this.usage.get(backend), b, value, b.date, now).level !== 'over') this.store.saveBaseline({ ...b, warned: false });
    this.pushDashboard();
  }

  private pushDashboard(): void {
    if (this.dashTimer) { clearTimeout(this.dashTimer); this.dashTimer = null; }
    this.broadcast({ dashboard: this.dashboard() });
  }

  private scheduleDashboard(): void {
    if (this.dashTimer) return;
    this.dashTimer = setTimeout(() => { this.dashTimer = null; this.pushDashboard(); }, 300);
  }

  /** 換日:今天的用量、花費與任務統計重新起算,畫面跟著更新;順便清掉太舊的每日紀錄。 */
  private dayTick(): void {
    const today = localDate(Date.now());
    if (today === this.dashDate) return;
    this.dashDate = today;
    this.store.pruneDaily(shiftDate(today, -DAILY_KEEP_DAYS));
    this.pushDashboard();
  }

  /** 讀到新的額度後更新今天的每週額度起點;今天的用量第一次超過每日預算時念一次提醒(只提醒,不擋指令)。 */
  private trackBudget(u: BackendUsage): void {
    const bw = budgetWindow(u.windows);
    if (!bw) return;
    const now = Date.now();
    const next = nextBaseline(this.store.latestBaseline(u.backend), u.backend, { date: localDate(now), used: bw.window.used, resetsAt: bw.window.resetsAt });
    if (!next.warned && budgetStatus(u.backend, u, next, this.budgets.get(u.backend) ?? null, next.date, now).level === 'over') {
      next.warned = true;
      this.speak({ kind: 'failed', reason: 'budget', agentId: `budget:${u.backend}`, agentName: BACKEND_LABEL[u.backend], ts: now, queuePaused: false });
    }
    this.store.saveBaseline(next);
    this.scheduleDashboard();
  }

  /**
   * 指定總管節點(null 表示解除)。新舊總管都會在下一則指令前收到更新後的身分設定(總管守則加上或拿掉)。
   * 只能指定面板上的最上層節點。
   */
  setChief(id: string | null): void {
    const next = id && this.agents.get(id) && !this.agents.get(id)!.parentId ? id : null;
    if (id && !next) throw new Error('找不到這個節點(子代理不能當總管)');
    if (next === this.chiefId) return;
    const prev = this.chiefId;
    this.chiefId = next;
    this.store.setSetting('chief', next ?? '');
    this.recordChief();
    for (const a of [prev, next]) if (a && this.agents.has(a)) {
      this.addNotice(a, 'persona');
      this.onAdapterEvent(a, { type: 'note', text: a === next ? '已指定為總管節點:使用者交代的事會由你判斷交給哪個節點。' : '已解除總管節點。' });
    }
    this.broadcast({ chiefId: next });
  }

  /** 總管任期(設定 chiefTerms);第一次讀時從設定載入。 */
  private chiefTerms: ChiefTerm[] | null = null;
  private terms(): ChiefTerm[] {
    if (!this.chiefTerms) this.chiefTerms = parseChiefTerms(this.store.getSetting('chiefTerms'));
    return this.chiefTerms;
  }

  /** 依現任總管更新任期紀錄:換人時結束舊任期、開新任期;沒有變化就不寫。 */
  private recordChief(): void {
    const now = this.chiefId ? this.agents.get(this.chiefId) : undefined;
    const before = this.terms();
    const after = updateChiefTerms(before, now ? { id: now.id, name: now.name } : null, Date.now());
    if (after.length === before.length && after.every((t, i) => t.to === before[i].to)) return;
    this.chiefTerms = after;
    this.store.setSetting('chiefTerms', JSON.stringify(after));
    this.onStatsDirty?.();
  }

  /** 主控台已知的專案:面板上每個節點的工作目錄所屬的專案,加上任務紀錄(保留期間內)裡出現過的專案。給 project 參數驗證用。 */
  async knownProjects(): Promise<KnownProject[]> {
    const live = [...this.agents.values()].filter(a => !a.parentId);
    const fromNodes = await Promise.all(live.map(a => projectOf(a.cwd).then(p => ({ id: p.id, name: p.name, git: p.isGit }), () => null)));
    const fromTasks = [...this.store.loadTasksForStats(0, 100000), ...this.tasks.values()]
      .flatMap(t => (t.project ? [{ id: t.project.id, name: t.project.name, git: t.project.git }] : []));
    return uniqueProjects([...fromNodes.filter((p): p is NonNullable<typeof p> => !!p), ...fromTasks]);
  }

  /** 這個節點現在是不是總管(交辦與會議紀錄在建立當下記下)。 */
  isChief(id: string): boolean { return !!id && id === this.chiefId; }

  /** 這個 session 是不是面板上的節點;外部觀察用來排除主控台自己啟動的 CLI。 */
  hasSession(backend: Backend, sessionId: string): boolean {
    return [...this.agents.values()].some(a => a.backend === backend && a.sessionId === sessionId);
  }

  history(id: string): NexusEvent[] {
    return this.store.agentEvents(id, 2000);
  }

  /** 節點的名稱與所屬的最上層節點(子代理跟著呼叫它的節點);遠端裝置的節點範圍以最上層節點為準。節點不存在時是 null。 */
  agentRef(id: string): { name: string; root: string } | null {
    let a = this.agents.get(id);
    if (!a) return null;
    const name = a.name;
    for (let i = 0; a.parentId && i < 8; i++) { const up = this.agents.get(a.parentId); if (!up) break; a = up; }
    return { name, root: a.id };
  }

  /** 任務屬於哪個節點;任務不存在時是 null。 */
  taskAgent(taskId: string): string | null {
    return this.tasks.get(taskId)?.agentId ?? null;
  }

  /** 在節點的對話裡留一則說明(例如指令是哪支遠端裝置送的)。 */
  note(id: string, text: string): void {
    if (this.agents.has(id)) this.onAdapterEvent(id, { type: 'note', text });
  }

  /** 節點的工作目錄,給圖片的受限讀取用;節點不存在時是 null。 */
  agentCwd(id: string): string | null {
    return this.agents.get(id)?.cwd ?? null;
  }

  /** 最近用過的工作目錄(目前的節點與終止過的節點),給手機版新增節點時挑選。 */
  recentDirs(): string[] {
    const dirs = [...this.agents.values()].filter(a => !a.parentId && !a.worktree).map(a => a.cwd);
    for (const { agent } of this.store.loadRemovedAgents()) if (!agent.worktree) dirs.push(agent.cwd);
    return [...new Set(dirs)].filter(d => existsSync(d)).slice(0, 15);
  }

  /** 可以接回來的舊 session:主控台終止過的節點,加上各家 CLI 自己紀錄裡的對話。已經在面板上的不列。 */
  async listOldSessions(): Promise<OldSession[]> {
    const key = (b: Backend, id: string) => `${b}:${id}`;
    const live = new Set([...this.agents.values()].filter(a => a.sessionId).map(a => key(a.backend, a.sessionId!)));
    const out = new Map<string, OldSession>();
    for (const { agent: a, removedAt } of this.store.loadRemovedAgents()) {
      const k = key(a.backend, a.sessionId!);
      if (live.has(k) || out.has(k) || a.sessionId!.startsWith('fake-')) continue;
      out.set(k, {
        backend: a.backend, sessionId: a.sessionId!, cwd: a.cwd, cwdExists: existsSync(a.cwd), updatedAt: removedAt, source: 'nexus', maybeActive: false, agentId: a.id,
        title: this.store.firstUserMessage(a.id).replace(/\s+/g, ' ').slice(0, 140) || '(沒有對話內容)',
        name: a.name, character: a.character, model: a.model,
      });
    }
    const lists = await Promise.all((Object.keys(this.adapters) as Backend[]).map(async backend => {
      const cap = this.capabilities.get(backend);
      if (!cap?.available || cap.simulated) return { backend, sessions: [] };
      try { return { backend, sessions: await this.adapters[backend].listSessions?.() ?? [] }; } catch { return { backend, sessions: [] }; }
    }));
    for (const { backend, sessions } of lists) {
      for (const s of sessions) {
        const k = key(backend, s.sessionId);
        if (live.has(k)) continue;
        const saved = out.get(k);
        if (saved) {
          // 主控台開過的:名稱以當時保存的為準,時間取較新的
          saved.updatedAt = Math.max(saved.updatedAt, s.updatedAt);
          continue;
        }
        out.set(k, {
          backend, sessionId: s.sessionId, title: s.title, cwd: s.cwd, cwdExists: existsSync(s.cwd), updatedAt: s.updatedAt, source: 'cli', maybeActive: Date.now() - s.updatedAt < 3 * 60 * 1000, agentId: null,
          name: s.suggestedName || s.title.replace(/^[\s(（]+/, '').slice(0, 10) || '舊對話', character: '', model: '',
        });
      }
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 接回一個舊 session。主控台開過的會復原原本的節點(對話紀錄也回來);否則建立新節點,名稱從此跟著這個 session 保存。 */
  async openOldSession(input: OpenOldSessionInput): Promise<AgentInfo> {
    if (!existsSync(input.cwd)) throw new Error('原本的工作目錄已經不存在,無法接回這個 session。');
    if ([...this.agents.values()].some(a => a.backend === input.backend && a.sessionId === input.sessionId)) throw new Error('這個 session 已經在面板上。');
    const cap = this.capabilities.get(input.backend);
    if (!cap?.available) throw new Error(cap?.note ?? '這個後台目前無法使用');
    const removed = input.agentId ? this.store.loadRemovedAgents().find(r => r.agent.id === input.agentId && r.agent.sessionId === input.sessionId) : undefined;
    if (removed) {
      const a = removed.agent;
      a.name = input.name.trim() || a.name;
      a.simulated = this.isSimulated(a.backend);
      this.store.restoreAgent(a.id, a.name);
      this.agents.set(a.id, a);
      this.broadcast({ agent: { ...a } });
      await this.wake(a.id);
      return a;
    }
    return this.createAgent({ name: input.name, character: input.character, model: input.model, backend: input.backend, cwd: input.cwd, permissionMode: 'ask' }, input.sessionId);
  }

  /**
   * 分支對話:從面板上的節點(用它目前的 session)或舊 session 分支出新節點。
   * 新節點用 CLI 原生的分支功能建立自己的 session,來源節點照常運作,也不佔用舊 session。
   * 來源是主控台的節點時,把到目前為止的對話紀錄複製過去;只存在於 CLI 紀錄裡的舊對話只加一則說明。
   */
  async forkAgent(input: ForkAgentInput): Promise<AgentInfo> {
    const src = input.source;
    let from: { backend: Backend; sessionId: string; cwd: string; copyFrom: string | null; label: string; model: string; character: string; permissionMode: PermissionMode };
    let busyNote = '';
    if (src.kind === 'agent') {
      const a = this.agents.get(src.agentId);
      if (!a || a.parentId) throw new Error('找不到這個節點(子代理不能分支)。');
      if (!a.sessionId) throw new Error('這個節點還沒有建立 session(還沒對話過),沒有可以分支的對話。');
      from = { backend: a.backend, sessionId: a.sessionId, cwd: a.cwd, copyFrom: a.id, label: `節點「${a.name}」`, model: a.model, character: a.character, permissionMode: a.permissionMode };
      // 來源還在執行:分支點是 CLI 目前已寫進紀錄的對話,進行中的回合可能只有一部分或不包含在內
      if (BUSY.has(a.state)) busyNote = '分支時來源節點仍在執行,分支點是當時已寫入紀錄的對話,進行中的回合可能不完整或沒有包含在內。';
    } else {
      if (!existsSync(src.cwd)) throw new Error('原本的工作目錄已經不存在,無法分支這個 session。');
      const removed = src.agentId ? this.store.loadRemovedAgents().find(r => r.agent.id === src.agentId && r.agent.sessionId === src.sessionId)?.agent : undefined;
      from = removed
        ? { backend: removed.backend, sessionId: src.sessionId, cwd: src.cwd, copyFrom: removed.id, label: `已終止的節點「${removed.name}」`, model: removed.model, character: removed.character, permissionMode: removed.permissionMode }
        : { backend: src.backend, sessionId: src.sessionId, cwd: src.cwd, copyFrom: null, label: `${BACKEND_LABEL[src.backend]} 的舊對話`, model: '', character: '', permissionMode: 'ask' };
    }
    const cap = this.capabilities.get(from.backend);
    if (!cap?.available) throw new Error(cap?.note ?? '這個後台目前無法使用');
    if (!cap.fork) throw new Error(`${BACKEND_LABEL[from.backend]} 不支援分支對話。`);
    const note = `從${from.label}的對話分支(來源 session ${from.sessionId})。`
      + (from.copyFrom ? '上面是分支當下為止的對話紀錄。' : '之前的對話內容保存在 CLI 的 session 裡,這裡不顯示。')
      + busyNote;
    return this.createAgent({
      name: input.name.trim() || '未命名', character: input.character ?? from.character, model: input.model ?? from.model,
      backend: from.backend, cwd: from.cwd, permissionMode: from.permissionMode, isolate: input.isolate,
    }, null, { from: from.sessionId, copyFrom: from.copyFrom, note });
  }

  async createAgent(input: CreateAgentInput, resumeSessionId: string | null = null, fork: { from: string; copyFrom: string | null; note: string } | null = null): Promise<AgentInfo> {
    const cap = this.capabilities.get(input.backend);
    if (!cap?.available) throw new Error(cap?.note ?? '這個後台目前無法使用');
    const id = randomUUID();
    let cwd = input.cwd;
    let worktree: WorktreeInfo | null = null;
    let setup = '';
    if (input.isolate) {
      // 獨立工作區:在自己的 worktree 與分支上工作,不會和其他節點互相覆寫
      const made = await createWorktree(input.cwd, input.name, id);
      cwd = made.cwd;
      worktree = made.info;
      setup = made.setup;
    }
    const agent: AgentInfo = {
      id,
      name: input.name.trim() || '未命名',
      character: input.character ?? '',
      model: (input.model ?? '').trim(),
      context: null,
      parentId: null,
      backend: input.backend,
      cwd,
      permissionMode: input.permissionMode,
      sessionId: resumeSessionId,
      state: 'planning',
      stateSince: Date.now(),
      detail: resumeSessionId ? '續接中' : fork ? '分支中' : '啟動中',
      pendingApproval: null,
      pendingQuestion: null,
      worktree: null,
      spent: { tokens: 0, usd: 0 },
      terminal: false,
      simulated: this.isSimulated(input.backend),
      createdAt: Date.now(),
      queued: [],
      queuePaused: null,
    };
    agent.worktree = worktree;
    this.store.insertAgent(agent);
    this.agents.set(agent.id, agent);
    this.broadcast({ agent });
    if (fork) {
      // 先記下分支來源與複製對話紀錄,再啟動 session
      this.forks.set(agent.id, fork.from);
      this.store.setSetting(`fork:${agent.id}`, fork.from);
      if (fork.copyFrom) this.store.copyConversation(fork.copyFrom, agent.id);
      this.onAdapterEvent(agent.id, { type: 'note', text: fork.note });
    }
    // 環境初始化做了什麼(複製的環境檔、連結的 node_modules、失敗項目)顯示在節點對話裡;分支時排在複製來的紀錄與分支說明之後
    if (setup) this.onAdapterEvent(agent.id, { type: 'note', text: setup });
    // 要在啟動 session 之前指定,第一個身分設定就會帶著總管守則
    if (input.chief) { this.chiefId = agent.id; this.store.setSetting('chief', agent.id); this.recordChief(); this.broadcast({ chiefId: agent.id }); }
    this.startSession(agent);
    return agent;
  }

  /**
   * 刪除最上層節點前先歸檔進記憶庫(長期記憶階段 4)。mode:summary 先請節點寫工作總結(不行就請總管代寫),stats 只存統計。
   * 歸檔失敗不會擋住刪除:失敗的原因回傳給畫面,節點照樣移除。
   */
  async removeWithArchive(id: string, mode: 'summary' | 'stats', memoir = false): Promise<{ archive: string | null; note: string }> {
    const agent = this.agents.get(id);
    let out: { archive: string | null; note: string } = { archive: null, note: '' };
    // 已經在刪除流程中(例如連點兩次):不重跑一次
    if (this.removing.has(id)) return { archive: null, note: '這個節點已經在刪除中。' };
    this.removing.add(id);
    try {
      // 先寫回憶錄(使用者選了才寫),再寫工作總結:兩份都要節點本人有空才寫得出來,回憶錄等完節點才會回到待命
      const memoirNote = memoir && agent && !agent.parentId ? await this.askForMemoir(agent) : '';
      if (agent && !agent.parentId && this.vault) {
        try { out = await this.archiveNode(agent, mode === 'stats' ? 'stats' : 'summary'); }
        catch (e) { out = { archive: null, note: `歸檔失敗,節點仍已刪除:${String((e as Error)?.message ?? e)}` }; console.error('歸檔節點失敗', e); }
      }
      await this.removeAgent(id);
      return memoirNote ? { ...out, note: [memoirNote, out.note].filter(Boolean).join(' ') } : out;
    } finally {
      this.removing.delete(id);
    }
  }

  /** 這個節點是不是正在刪除流程中(等回憶錄、工作總結);對話視窗依這個停用「寫回憶錄」「儲存這段記憶」。 */
  isRemoving(id: string): boolean { return this.removing.has(id); }

  /**
   * 刪除節點前請它寫一章回憶錄,等它提交(或這個請求的回合結束、逾時)。回傳給使用者看的一句說明。流程在 memoir.ts 的 waitForMemoir:
   * 已經有回憶錄請求在進行就等那一份;回合結束卻沒有提交就取消請求;逾時就取消請求、拿掉佇列裡的提示、中斷正在寫的回合。都不擋刪除。
   */
  private async askForMemoir(agent: AgentInfo): Promise<string> {
    const hook = this.memoir;
    if (!hook) return '';
    const id = agent.id;
    return waitForMemoir({
      pending: () => hook.pending(id),
      submittedAt: () => hook.submittedAt(id),
      queuedId: () => this.memoirQueuedId(id),
      running: () => this.memoirRunning(id),
      endedSince: since => [...this.tasks.values()].some(t => t.agentId === id && t.endedAt !== null && t.endedAt >= since && isMemoirRequest(t.title, t)),
      request: () => hook.request(id),
      cancel: () => hook.cancel(id),
      cancelQueued: q => this.cancelQueued(id, q),
      interrupt: () => { void Promise.resolve(this.interrupt(id)).catch(() => {}); },
      now: () => Date.now(),
      sleep: ms => new Promise(r => setTimeout(r, ms)),
      timeoutMs: Number(process.env.NEXUS_ARCHIVE_TIMEOUT_MS) || 3 * 60 * 1000,
      settleMs: 15000,
    });
  }

  /** 佇列裡還沒送出的回憶錄提示的 id(依提示開頭辨識,不會和「儲存這段記憶」的草稿請求混淆);沒有是 null。 */
  memoirQueuedId(id: string): string | null { return this.agents.get(id)?.queued.find(q => isMemoirRequest(q.text, q))?.id ?? null; }
  /** 這個節點有沒有正在進行的回憶錄回合。 */
  memoirRunning(id: string): boolean { return [...this.tasks.values()].some(t => t.agentId === id && t.endedAt === null && isMemoirRequest(t.title, t)); }
  /** 這個節點的記憶草稿請求是不是還在進行:草稿提示還在佇列,或節點正在跑草稿的回合。 */
  draftActive(id: string): boolean {
    return !!this.agents.get(id)?.queued.some(q => isDraftRequest(q.text, q))
      || [...this.tasks.values()].some(t => t.agentId === id && t.endedAt === null && isDraftRequest(t.title, t));
  }

  /** 等這個節點交辦出去的歸檔提示結束,回傳它的最後一則回覆;逾時、失敗或沒有回覆就是 null。 */
  private async askForSummary(id: string, prompt: string, timeoutMs: number): Promise<string | null> {
    const t0 = Date.now();
    try { await this.send(id, prompt, [], 'user', 'archive'); } catch { return null; }
    const find = () => [...this.tasks.values()].find(t => t.agentId === id && t.source === 'archive' && t.startedAt >= t0);
    while (Date.now() - t0 < timeoutMs) {
      const t = find();
      if (t && t.endedAt !== null) {
        if (t.status !== 'done') return null;
        const reply = this.store.agentEvents(id, 40).filter(e => e.type === 'message' && e.role === 'agent' && e.ts >= t.startedAt).map(e => (e as { text: string }).text).pop();
        return reply?.trim() || null;
      }
      await new Promise(r => setTimeout(r, 250));
    }
    void Promise.resolve(this.interrupt(id)).catch(() => {});
    return null;
  }

  private async archiveNode(agent: AgentInfo, mode: 'summary' | 'stats'): Promise<{ archive: string | null; note: string }> {
    const vault = this.vault!;
    const timeout = Number(process.env.NEXUS_ARCHIVE_TIMEOUT_MS) || 3 * 60 * 1000;
    const tasks = this.store.loadTasksForStats(0, 100000).filter(t => t.agentId === agent.id && isWorkTask(t));
    const stats = computeNodeStats(tasks, isWorkTask).get(agent.id);
    const selfOk = agent.state === 'idle' && !agent.terminal && this.sessions.has(agent.id);
    const chief = this.chiefId && this.chiefId !== agent.id ? this.agents.get(this.chiefId) : undefined;
    const chiefOk = !!chief && chief.state === 'idle' && !chief.terminal && this.sessions.has(chief.id);
    let summary = '';
    let review = '';
    let source: SummarySource = '無';
    let reason = mode === 'stats' ? '使用者選擇只存統計' : '';
    let plan = decideSummarizer({ mode, selfAvailable: selfOk, selfFailed: false, chiefAvailable: chiefOk });
    if (plan === 'self') {
      const r = await this.askForSummary(agent.id, SELF_SUMMARY_PROMPT, timeout);
      if (r) { ({ summary, review } = splitReview(r)); source = '節點自己'; }
      else plan = decideSummarizer({ mode, selfAvailable: selfOk, selfFailed: true, chiefAvailable: chiefOk });
    }
    if (!summary && plan === 'chief' && chief) {
      const events = this.store.agentEvents(agent.id, 200);
      const titles = [...tasks].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20).map(t => t.title.slice(0, 120));
      const replies = events.filter(e => e.type === 'message' && e.role === 'agent').slice(-6).map(e => (e as { text: string }).text.slice(0, 600));
      const r = await this.askForSummary(chief.id, chiefSummaryPrompt(agent.name, titles, replies), timeout);
      if (r) { ({ summary, review } = splitReview(r)); source = '總管'; }
    }
    if (!summary && mode === 'summary') {
      reason = !selfOk
        ? (chief ? (chiefOk ? '節點無法回覆,總管也沒有寫出來' : '節點無法回覆,總管目前忙碌或無法使用') : '節點無法回覆,也沒有總管可以代寫')
        : (chiefOk ? '節點沒有在時限內回覆,總管也沒有寫出來' : '節點沒有在時限內回覆,也沒有可用的總管代寫');
    }
    const cases = vault.list().filter(e => e.kind === 'case' && e.nodeId === agent.id).map(caseNumber);
    const r = writeArchive(vault.dir, {
      node: { id: agent.id, name: agent.name, backend: agent.backend, backendLabel: BACKEND_LABEL[agent.backend], model: agent.model, character: agent.character, createdAt: agent.createdAt, sessionId: agent.sessionId, cwd: agent.cwd },
      stats, tasks, traits: readLiveTraits(vault.dir, agent), summary, summarySource: source, noSummaryReason: reason, cases, review, now: new Date(),
      images: agent.character ? characterImages(portraitsDir(), agent.character) : undefined,
    });
    // 馬上更新索引:不等資料夾監看(有去抖動),緊接著的查詢(例如新增同名節點時找封存)才讀得到
    vault.rescan();
    return { archive: r.path, note: summary ? `已封存(工作總結由${source}撰寫):${r.path}` : `已封存,但沒有工作總結(${reason}):${r.path}` };
  }

  async removeAgent(id: string): Promise<void> {
    if (this.agents.get(id)?.parentId) { this.dropSub(id); return; }
    // 終止節點時排隊的指令一併丟棄;先清掉,停止 session 的期間才不會又被送出
    const doomed = this.agents.get(id);
    if (doomed && (doomed.queued.length || doomed.queuePaused)) { doomed.queued = []; doomed.queuePaused = null; this.store.updateQueue(doomed); }
    this.dropSubsOf(id);
    this.finishTask(id, 'interrupted', '節點已終止');
    // 回憶錄與記憶草稿請求不留在設定裡
    try { this.memoir?.forget(id); } catch (e) { console.error('清除記憶請求失敗', e); }
    this.leaveTerminal(id);
    await this.stopSession(id);
    const wt = this.agents.get(id)?.worktree;
    if (wt) {
      // 工作區乾淨且已合併才自動移除;否則保留,之後可從「開啟舊 session」接回來
      const removed = await removeWorktree(wt, false).catch(() => false);
      if (!removed) this.onAdapterEvent(id, { type: 'note', text: `獨立工作區還有未提交或未合併的修改,已保留在 ${wt.path}(分支 ${wt.branch})。` });
    }
    // 停止期間正在拍快照的那筆可能又被放回佇列,這裡再清一次,接回舊 session 時才不會冒出來
    const left = this.agents.get(id);
    if (left?.queued.length) { left.queued = []; left.queuePaused = null; this.store.updateQueue(left); }
    // 還能從「開啟舊 session」接回的節點保留圖片(對話紀錄會用到),接不回的一併刪掉
    if (!this.agents.get(id)?.sessionId) removeMedia(id);
    this.store.markRemoved(id);
    this.agents.delete(id);
    if (this.chiefId === id) { this.chiefId = null; this.store.setSetting('chief', ''); this.recordChief(); this.broadcast({ chiefId: null }); }
    this.broadcast({ removedId: id });
    this.schedulePump();
  }

  /** origin 是佇列項目時表示由佇列自動送出:送不出去就放回佇列開頭,不會丟掉。 */
  /** source:指令是從哪裡送出的(語音播報用);佇列送出時沿用排入時記下的來源。 */
  async send(id: string, text: string, images: string[] = [], origin: 'user' | 'autopilot' | QueuedPrompt = 'user', source: SpeechSource = 'desktop', from?: TaskFrom): Promise<void> {
    const agent = this.agents.get(id);
    const session = this.sessions.get(id);
    const fromQueue = typeof origin === 'object' ? origin : null;
    if (fromQueue) { source = fromQueue.source ?? 'desktop'; from = fromQueue.from; }
    else if (origin === 'autopilot') source = 'autopilot';
    if (!agent || !session) { if (fromQueue && agent) this.requeue(agent, fromQueue); return; }
    // 額度上限:這家後台的額度用到設定的百分比就不再送出新指令
    if (!BUSY.has(agent.state) && this.quotaStop > 0) {
      const worst = usageWindowsFor(agent.model, this.usage.get(agent.backend)?.windows ?? []).reduce<UsageWindow | null>((m, w) => (!m || w.used > m.used ? w : m), null);
      if (worst && worst.used * 100 >= this.quotaStop) {
        const what = `${BACKEND_LABEL[agent.backend]} 的${worst.group ? `「${worst.group}」` : ''}${worst.label}額度已用 ${Math.round(worst.used * 100)}%,達到你設定的上限 ${this.quotaStop}%`;
        if (fromQueue) {
          // 佇列送出時被擋:這筆留在佇列開頭並暫停,等使用者調整後按佇列的「繼續」
          this.requeue(agent, fromQueue);
          if (this.pauseQueue(agent, `額度已達上限 ${this.quotaStop}%`) && source === 'desktop') this.speak({ kind: 'failed', agentId: id, agentName: agent.name, ts: Date.now(), reason: 'quota', queuePaused: true });
          this.onAdapterEvent(id, { type: 'note', text: `${what},佇列已暫停,排隊的指令都還在。調高額度上限或等額度重置後,按佇列的「繼續」。` });
          return;
        }
        if (origin === 'autopilot') return;
        this.onAdapterEvent(id, { type: 'error', message: `${what},這句指令沒有送出。可以在頂部調高額度上限,或等額度重置。` });
        return;
      }
    }
    // 使用者親自送出下一句,視為要繼續:解除佇列暫停(被額度上限擋下的不算)
    if (origin === 'user' && !BUSY.has(agent.state) && agent.queuePaused) { agent.queuePaused = null; this.saveQueue(agent); }
    // 同時執行上限:避免一次開太多節點把訂閱額度用完。超過時改成排隊,有名額時自動送出
    if (!BUSY.has(agent.state) && this.activeCount(id) >= this.maxActive) {
      if (fromQueue) { this.requeue(agent, fromQueue); return; }
      if (origin === 'autopilot') return;
      this.pushQueue(agent, text, images, source, from);
      this.onAdapterEvent(id, { type: 'note', text: `已達同時執行上限(${this.maxActive} 個),指令已排隊,有名額時會自動送出。` });
      return;
    }
    if (!BUSY.has(agent.state)) {
      // 送出前先拍下工作目錄的快照,任務結束後才算得出這個任務改了什麼
      this.starting.add(id);
      try {
        // 專案在交辦的這一刻依節點目前的工作目錄決定,之後不再重算
        // 交辦者明確指定的專案優先(ask_node / start_meeting 的 project);沒有就用節點的工作目錄所屬的專案
        const project = from?.project ?? await projectOf(agent.cwd).catch(() => null);
        const git = from?.project ? from.project.git : (project as { isGit?: boolean } | null)?.isGit;
        const task = this.startTask(agent, text, source, project ? { id: project.id, name: project.name, ...(typeof git === 'boolean' ? { git } : {}) } : undefined, from);
        await this.captureBase(agent, task);
      } finally {
        this.starting.delete(id);
      }
      // 等快照期間節點被終止、休眠或切到終端機:佇列來的這筆放回去
      if (this.sessions.get(id) !== session) { if (fromQueue && this.agents.has(id)) this.requeue(agent, fromQueue); return; }
    } else if (source === 'desktop') {
      // 節點在跑別人交辦的回合時,使用者從桌面插話:這個回合改算使用者發起的,完成時要念
      const task = this.tasks.get(this.current.get(id) ?? '');
      if (task && task.source !== 'desktop') task.source = 'desktop';
    }
    this.onAdapterEvent(id, { type: 'message', role: 'user', text });
    // 改名、換角色之後的第一則指令順便告訴 agent;紀錄裡仍只留使用者原本的文字
    session.send(this.takeNotice(agent) + this.takeChiefNotes(agent) + this.takeStatsNotice(agent) + text, images);
  }

  /** 讓 agent 知道自己在主控台裡的身分:節點名稱,加上所選角色的角色卡(有的話)。 */
  private persona(agent: AgentInfo): string {
    const name = `你在 Entropy Nexus 主控台中的名字是「${agent.name}」。使用者會用這個名字稱呼你;被問到你的名字或你是誰時,以這個名字回答。使用者之後可能替你改名,屆時會以「主控台通知」開頭的訊息告訴你,請以最新通知的名字為準。`;
    const card = this.personaCard(agent);
    const parts = [name, this.chiefRules(agent), card].filter(Boolean);
    return parts.join('\n\n');
  }

  /** 總管節點的工作守則;不是總管時回傳空字串。 */
  private chiefRules(agent: AgentInfo): string {
    if (agent.id !== this.chiefId) return '';
    // 守則送出時一併帶上最新的節點統計,並記下內容與時間,之後的通知才知道有沒有變
    const stats = this.chiefStats();
    this.chiefStatsSent = { text: stats, at: Date.now() };
    return `你是這個主控台的「總管」節點。使用者交代給你的事(常常是用語音說的、由語音辨識轉成的文字,可能有錯字或同音字)是要分派出去的工作:
- 先用 list_nodes 看面板上有哪些節點、各自的後台、模型、狀態與工作目錄,再判斷這件事適合交給誰。使用者在句首直接叫了某個節點的名字(或聽起來像那個名字)時,就交給那個節點。
- 用 ask_node 交辦。對方看不到你和使用者的對話,所以 prompt 要寫完整:背景、要做什麼、要讀的檔案(絕對路徑)、希望怎麼回覆。需要多方意見或討論時用 start_meeting。
- 為某個專案交辦時,請帶 project(專案名稱或 ID,list_nodes 的「專案」欄看得到);不帶就記到接手節點自己的工作目錄,在共用資料夾的節點會被記成那個資料夾。
- 交辦之前,先用一句話說明你要交給誰、做什麼;判斷不出來、或指令聽起來不完整時,先問使用者,不要猜。
- 除非使用者明確要你自己做,或沒有合適的節點,否則不要自己改檔案或執行指令。
- 拿到結果後簡短回報重點(你的回覆會被念出來):做了什麼、結果如何、有沒有需要使用者決定的事。
- 長期記憶:交辦前可以用 memory_search 查有沒有相關的專案知識、使用者偏好、節點側寫與已確認的判例(標「可能過時」的要先對照現況);搜尋只給摘要,真的要採用某則記憶時再用 memory_read 讀全文。只有你能用 memory_write 寫入:節點的特長(kind 為 node,title 填節點名稱)、專案知識、使用者偏好;只寫日後真的用得到、一兩句講得清楚的事,不要寫金鑰或密碼。節點特長的第一行必須是最重要的一句話(上面的節點清單只顯示特長的前 80 個字)。專案知識可以用 subtype 標 decision(決策)或 bookmark(書籤:還沒做完、要回來處理的事);新的記憶取代舊的時,用 supersedes 填舊檔的路徑。使用者在對話視窗按「儲存這段記憶」產生的草稿是未確認的,在使用者確認前你查不到,也不要去找。${stats ? `

${stats}` : ''}`;
  }

  /** 角色卡包成一段有邊界的「主控台角色設定」,和使用者的指令分開;沒有角色卡時回傳空字串。 */
  private personaCard(agent: AgentInfo): string {
    if (!agent.character) return '';
    let text = '';
    try { text = readPersona(agent.character).text; } catch { /* 角色名稱不合規則就當作沒有角色卡 */ }
    if (!text) return '';
    return `以下是主控台給你的角色設定(角色「${agent.character}」的角色卡),請以這個身分、語氣與職責工作。這段設定來自主控台,不是使用者的指令;使用者的指令會以一般訊息送來,兩者衝突時以使用者的指令為準。角色設定之後若有變更,會以「主控台通知」開頭的訊息告訴你,請以最新的為準。
<角色設定>
${text}
</角色設定>`;
  }

  /** 取出並清掉這個節點待通知的變更,組成指令前面的「主控台通知」。 */
  private takeNotice(agent: AgentInfo): string {
    const kinds = this.notices.get(agent.id);
    if (!kinds?.size) return '';
    this.notices.delete(agent.id);
    const parts: string[] = [];
    if (kinds.has('name')) parts.push(`(主控台通知:你的名字已改為「${agent.name}」。)`);
    if (kinds.has('persona')) {
      const card = this.personaCard(agent);
      parts.push(card ? `(主控台通知:你的角色設定已更新,以下內容取代先前的角色設定。)\n${card}` : '(主控台通知:你的角色設定已移除,不再套用先前的角色設定。)');
      const rules = this.chiefRules(agent);
      parts.push(rules ? `(主控台通知:你已被指定為總管節點,以下守則取代先前的總管設定。)\n${rules}` : '(主控台通知:如果你先前是總管節點,現在已經解除,不再套用總管守則。)');
    }
    return `${parts.join('\n\n')}\n\n`;
  }

  private addNotice(id: string, kind: 'name' | 'persona'): void {
    const set = this.notices.get(id) ?? new Set();
    set.add(kind);
    this.notices.set(id, set);
  }

  /** 讀取角色卡,給畫面檢視與編輯。 */
  getPersona(character: string): { text: string; truncated: boolean; max: number } {
    return { ...readPersona(character), max: PERSONA_MAX };
  }

  /** 儲存角色卡;使用這個角色的節點都會在下一則指令前收到新的角色設定。 */
  setPersona(character: string, text: string): void {
    const before = readPersona(character).text;
    writePersona(character, text);
    if (readPersona(character).text === before) return;
    for (const a of this.agents.values()) if (!a.parentId && a.character === character.trim()) this.addNotice(a.id, 'persona');
  }

  respondApproval(id: string, requestId: string, decision: ApprovalDecision): void {
    // 主控台自己發出的授權(例如節點互相呼叫)不經過 CLI
    const own = this.ownApprovals.get(requestId);
    if (own) {
      this.ownApprovals.delete(requestId);
      this.onAdapterEvent(id, { type: 'approval_resolved', requestId, decision });
      if (this.agents.get(id)?.state === 'awaiting') this.onAdapterEvent(id, { type: 'state', state: 'working', detail: own.resume });
      own.resolve(decision);
      return;
    }
    this.sessions.get(id)?.respondApproval(requestId, decision);
  }

  /** 啟動節點的 CLI 時要掛上的工具服務;由 index.ts 在 init 之前設定。 */
  setSpeech(out: (n: SpeechNotice) => void): void {
    this.speechOut = out;
  }

  private speak(n: SpeechNotice): void {
    try { this.speechOut(n); } catch { /* 播報失敗不影響節點 */ }
  }

  setInterop(provider: (agentId: string) => StartOptions['interop']): void {
    this.interop = provider;
  }

  /**
   * 由主控台(不是 CLI)在節點上發出一個授權請求,等使用者允許或拒絕。用在節點互相呼叫:
   * 呼叫方是「每次詢問」模式時,先問使用者要不要把指令交給另一個節點。節點停止、被中斷或被終止時視為拒絕。
   */
  requestApproval(id: string, tool: string, summary: string, detail: string): Promise<ApprovalDecision> {
    const agent = this.agents.get(id);
    if (!agent) return Promise.resolve('deny');
    const requestId = `nexus:${randomUUID()}`;
    return new Promise(resolve => {
      this.ownApprovals.set(requestId, { agentId: id, resume: agent.detail, resolve });
      this.onAdapterEvent(id, { type: 'approval_request', requestId, tool, summary, detail, canAllowSession: false });
      this.onAdapterEvent(id, { type: 'state', state: 'awaiting', detail: `${tool} · ${summary}`.slice(0, 120) });
    });
  }

  /** 節點停下來時,主控台自己發出、還沒回應的授權一律當成拒絕。 */
  private dropOwnApprovals(id: string): void {
    for (const [requestId, own] of this.ownApprovals) {
      if (own.agentId !== id) continue;
      this.ownApprovals.delete(requestId);
      if (this.agents.has(id)) this.onAdapterEvent(id, { type: 'approval_resolved', requestId, decision: 'deny' });
      own.resolve('deny');
    }
  }

  answerQuestion(id: string, requestId: string, answers: Record<string, string[]> | null): void {
    this.sessions.get(id)?.answerQuestion(requestId, answers);
  }

  interrupt(id: string): void {
    this.dropOwnApprovals(id);
    if (this.current.has(id)) this.interrupted.add(id);
    this.sessions.get(id)?.interrupt();
  }

  /**
   * 把指令排到節點佇列的尾端。節點待命(或喚醒後待命)且有執行名額時依序自動送出。回傳佇列項目的 id。
   * from 是交辦者(協作流程的交辦用它標明 from.flow,任務才認得出是哪個流程交辦)。
   */
  enqueue(id: string, text: string, images: string[] = [], source: SpeechSource = 'desktop', from?: TaskFrom): string {
    const agent = this.agents.get(id);
    if (!agent || agent.parentId) throw new Error('找不到這個節點');
    if (!text.trim()) throw new Error('沒有內容');
    return this.pushQueue(agent, text, images, source, from);
  }

  /**
   * 協作流程停機或需裁示時通知總管(使用者裁示第 4 點):只在總管的對話裡留言,並在總管下一次回合時附上,不自動讓總管跑回合。
   * 沒有指定總管時什麼都不做。
   */
  notifyChief(text: string): void {
    const id = this.chiefId;
    if (!id || !this.agents.has(id)) return;
    this.note(id, text);
    this.chiefNotes.push(text);
  }

  cancelQueued(id: string, queuedId: string): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    agent.queued = agent.queued.filter(q => q.id !== queuedId);
    // 佇列清空就沒有暫停的意義了
    if (!agent.queued.length) agent.queuePaused = null;
    this.saveQueue(agent);
  }

  editQueued(id: string, queuedId: string, text: string): void {
    const agent = this.agents.get(id);
    const item = agent?.queued.find(q => q.id === queuedId);
    if (!agent || !item) throw new Error('這筆指令已經送出或被取消了');
    if (!text.trim()) throw new Error('沒有內容');
    item.text = text;
    this.saveQueue(agent);
  }

  resumeQueue(id: string): void {
    const agent = this.agents.get(id);
    if (!agent?.queuePaused) return;
    agent.queuePaused = null;
    this.saveQueue(agent);
    this.schedulePump();
  }

  async sleep(id: string): Promise<void> {
    if (!this.agents.has(id) || this.agents.get(id)?.parentId) return;
    this.dropSubsOf(id);
    this.leaveTerminal(id);
    await this.stopSession(id);
    this.onAdapterEvent(id, { type: 'state', state: 'sleeping', detail: '' });
  }

  async wake(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent || agent.parentId) return;
    if (this.sessions.has(id)) {
      // 行程還在就不必喚醒;失聯的先清掉舊 session 再重新啟動
      if (agent.state !== 'lost') return;
      await this.stopSession(id);
    }
    this.onAdapterEvent(id, { type: 'state', state: 'planning', detail: '續接中' });
    this.startSession(agent);
  }

  /** 修改節點的名稱、角色、模型或權限模式。換模型或權限模式要重新啟動 session,對話內容由 CLI 的續接功能保留。 */
  async updateAgent(id: string, patch: { name?: string; character?: string; model?: string; permissionMode?: PermissionMode }): Promise<AgentInfo> {
    const agent = this.agents.get(id);
    if (!agent || agent.parentId) throw new Error('找不到這個節點');
    const model = patch.model !== undefined ? patch.model.trim() : agent.model;
    const modelChanged = model !== agent.model;
    if (patch.permissionMode !== undefined && patch.permissionMode !== 'ask' && patch.permissionMode !== 'auto') throw new Error('不正確的權限模式');
    const mode = patch.permissionMode ?? agent.permissionMode;
    const modeChanged = mode !== agent.permissionMode;
    if (modeChanged && this.capabilities.get(agent.backend)?.approvals === false) throw new Error(`${BACKEND_LABEL[agent.backend]} 在主控台不支援在視窗內授權,切換權限模式沒有作用。`);
    if ((modelChanged || modeChanged) && (BUSY.has(agent.state) || agent.terminal)) throw new Error(`節點還在執行或在終端機模式,等它停下來再換${modelChanged ? '模型' : '權限模式'}。`);
    if (patch.name !== undefined && patch.name.trim() && patch.name.trim() !== agent.name) { agent.name = patch.name.trim(); this.addNotice(id, 'name'); }
    if (patch.character !== undefined && patch.character !== agent.character) {
      // 新舊角色都沒有角色卡時只是換立繪,不必通知 agent
      const had = this.personaCard(agent);
      agent.character = patch.character;
      if (had || this.personaCard(agent)) this.addNotice(id, 'persona');
    }
    agent.model = model;
    agent.permissionMode = mode;
    this.store.updateAgentMeta(agent);
    // 任務面板上這個節點的任務也跟著改名
    for (const t of this.tasks.values()) {
      if (t.agentId === id && (t.agentName !== agent.name || t.model !== agent.model)) { t.agentName = agent.name; if (t.endedAt === null) t.model = agent.model; this.pushTask(t); }
    }
    this.broadcast({ agent: { ...agent } });
    if (modeChanged) this.onAdapterEvent(id, { type: 'note', text: `權限模式改為「${mode === 'auto' ? '自動執行' : '每次詢問'}」。` });
    if ((modelChanged || modeChanged) && this.sessions.has(id)) {
      await this.stopSession(id);
      this.onAdapterEvent(id, { type: 'note', text: modelChanged ? `模型改為 ${agent.model || '預設'},重新啟動 session。` : '重新啟動 session 套用新的權限模式,對話內容保留。' });
      this.onAdapterEvent(id, { type: 'state', state: 'planning', detail: '續接中' });
      this.startSession(agent);
    }
    return agent;
  }

  /** 進入終端機模式:停下結構化 session,在虛擬終端機裡執行原生 CLI 並接回同一個 session。 */
  async openTerminal(id: string, cols: number, rows: number): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent || agent.parentId) throw new Error('找不到這個節點');
    if (agent.terminal) return;
    if (BUSY.has(agent.state)) throw new Error('節點還在執行,等它停下來再切換到終端機模式。');
    const command = this.adapters[agent.backend].terminalCommand?.(agent.sessionId, agent.model);
    if (!command || agent.simulated) throw new Error('這個後台不支援終端機模式。');
    if (!agent.sessionId && this.forks.has(id)) throw new Error('分支的 session 還沒建立,先在對話模式送出一句指令,再切換到終端機模式。');
    this.dropSubsOf(id);
    await this.stopSession(id);
    agent.terminal = true;
    this.onAdapterEvent(id, { type: 'state', state: 'sleeping', detail: '終端機模式' });
    try {
      openTerminal(id, command, agent.cwd, cols, rows,
        data => this.broadcast({ term: { agentId: id, data } }),
        () => { void this.closeTerminal(id); });
    } catch (err) {
      agent.terminal = false;
      this.broadcast({ agent: { ...agent } });
      throw new Error(`無法啟動終端機:${(err as Error).message}`);
    }
  }

  /** 離開終端機模式並回到一般的對話模式。 */
  async closeTerminal(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent?.terminal) return;
    this.leaveTerminal(id);
    await this.wake(id);
  }

  private leaveTerminal(id: string): void {
    const agent = this.agents.get(id);
    if (hasTerminal(id)) closeTerminal(id);
    if (agent?.terminal) { agent.terminal = false; this.broadcast({ agent: { ...agent } }); }
  }

  termAttach(id: string): string { return terminalBuffer(id); }
  termWrite(id: string, data: string): void { writeTerminal(id, data); }
  termResize(id: string, cols: number, rows: number): void { resizeTerminal(id, cols, rows); }

  /** Antigravity 的工具白名單(所有 Antigravity 節點共用);改了之後,節點要重新啟動才會套用。 */
  getAgyAllow(): string[] { return [...this.agyAllow]; }
  setAgyAllow(input: unknown): { rules: string[]; invalid: string[] } {
    const r = normalizeAgyAllow(input);
    if (r.invalid.length) throw new Error(`這些規則的格式不對:${r.invalid.join('、')}。格式是「工具名稱」或「工具名稱(目標)」,例如 mcp(StitchMCP/*)。`);
    this.agyAllow = r.rules;
    this.store.setSetting('agyAllow', JSON.stringify(r.rules));
    return r;
  }

  setQuotaStop(n: number): void {
    if (!Number.isInteger(n) || n < 0 || n > 100) return;
    this.quotaStop = n;
    this.store.setSetting('quotaStop', String(n));
    this.broadcast({ quotaStop: n });
  }

  setMaxActive(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 32) return;
    this.maxActive = n;
    this.store.setSetting('maxActive', String(n));
    this.broadcast({ maxActive: n });
    this.schedulePump();
  }

  setAutopilot(on: boolean): void {
    this.autopilot = on;
    this.broadcast({ autopilot: on });
  }

  async shutdown(): Promise<void> {
    if (this.autopilotTimer) clearInterval(this.autopilotTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    if (this.dayTimer) clearInterval(this.dayTimer);
    if (this.dashTimer) { clearTimeout(this.dashTimer); this.dashTimer = null; }
    closeAllTerminals();
    await Promise.all([...this.sessions.keys()].map(id => this.stopSession(id)));
  }

  private isSimulated(backend: Backend): boolean {
    return this.capabilities.get(backend)?.simulated ?? false;
  }

  private startSession(agent: AgentInfo): void {
    const session = this.adapters[agent.backend].start(
      { agentId: agent.id, cwd: agent.cwd, permissionMode: agent.permissionMode, model: agent.model, sessionId: agent.sessionId, forkFrom: agent.sessionId ? null : this.forks.get(agent.id) ?? null, interop: agent.parentId ? null : this.interop?.(agent.id) ?? null, persona: this.persona(agent), ...(agent.backend === 'antigravity' ? { agyAllow: [...this.agyAllow] } : {}) },
      (e, subId) => this.onAdapterEvent(agent.id, e, subId),
    );
    this.sessions.set(agent.id, session);
  }

  private async stopSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    this.dropOwnApprovals(id);
    await session?.stop();
    const agent = this.agents.get(id);
    if (agent) { agent.pendingApproval = null; agent.pendingQuestion = null; }
  }

  /** 唯一會改變節點狀態的地方:先寫資料庫,再更新記憶體,最後推送。 */
  private onAdapterEvent(agentId: string, e: AdapterEvent, subId?: string): void {
    // 子代理自己的事件記到子節點上;子節點已經不在就略過
    if (subId && e.type === 'usage') return;
    if (subId && e.type !== 'subagent') {
      const childId = this.subs.get(`${agentId}:${subId}`);
      if (childId) this.onAdapterEvent(childId, e);
      return;
    }
    const agent = this.agents.get(agentId);
    if (!agent) return;
    // 用量更新很頻繁,不寫進事件紀錄,只更新目前的數字
    if (e.type === 'usage') { this.onUsage(agent, e); return; }
    // 生成中的片段只即時推送給畫面,不寫進資料庫
    if (e.type === 'delta') { this.lastEvent.set(agentId, Date.now()); this.broadcast({ delta: { agentId, text: e.text } }); return; }
    if (e.type === 'subagent') {
      if (e.phase === 'start') this.addSub(agent, e.subId, e.name);
      else this.finishSub(agentId, e.subId, e.failed === true);
    }
    this.lastEvent.set(agentId, Date.now());
    const event = this.store.appendEvent(agentId, e);
    switch (e.type) {
      case 'state':
        if (agent.state !== e.state || !agent.stateSince) agent.stateSince = event.ts;
        agent.state = e.state;
        agent.detail = e.detail ?? '';
        // 要在 trackTask 清掉中斷標記之前判斷
        if (!agent.parentId) this.queueOnState(agent, e.state);
        break;
      case 'approval_request':
        agent.pendingApproval = { requestId: e.requestId, tool: e.tool, summary: e.summary, detail: e.detail ?? '', canAllowSession: e.canAllowSession ?? false };
        this.speak({ kind: 'approval', agentId, agentName: agent.name, ts: Date.now(), requestId: e.requestId });
        break;
      case 'approval_resolved':
        if (agent.pendingApproval?.requestId === e.requestId) agent.pendingApproval = null;
        break;
      case 'session':
        agent.sessionId = e.sessionId;
        // 分支的新 session 已建立:分支來源只用這一次
        if (this.forks.delete(agentId)) this.store.setSetting(`fork:${agentId}`, '');
        break;
      case 'question':
        agent.pendingQuestion = { requestId: e.requestId, questions: e.questions };
        this.speak({ kind: 'question', agentId, agentName: agent.name, ts: Date.now(), requestId: e.requestId });
        break;
      case 'message':
        if (e.role === 'agent' && !agent.parentId && this.current.has(agentId)) {
          const list = this.turnText.get(agentId) ?? [];
          list.push(e.text);
          this.turnText.set(agentId, list.slice(-2));
        }
        break;
      case 'question_resolved':
        if (agent.pendingQuestion?.requestId === e.requestId) agent.pendingQuestion = null;
        break;
    }
    if (!agent.parentId) { this.store.updateAgent(agent); this.trackTask(agent, e); }
    this.broadcast({ agent: { ...agent }, event });
  }

  /** 執行中的頂層節點數(不含 except);正在送出第一句的也算。 */
  private activeCount(except?: string): number {
    return [...this.agents.values()].filter(a => a.id !== except && !a.parentId && (BUSY.has(a.state) || this.starting.has(a.id))).length;
  }

  private saveQueue(agent: AgentInfo): void {
    this.store.updateQueue(agent);
    this.broadcast({ agent: { ...agent, queued: agent.queued.map(q => ({ ...q })) } });
  }

  private pushQueue(agent: AgentInfo, text: string, images: string[], source: SpeechSource, from?: TaskFrom): string {
    if (agent.queued.length >= MAX_QUEUED) throw new Error(`佇列已滿(最多 ${MAX_QUEUED} 筆)`);
    const id = randomUUID();
    agent.queued.push({ id, text, images: [...images], createdAt: Date.now(), source, ...(from ? { from } : {}) });
    this.saveQueue(agent);
    this.schedulePump();
    return id;
  }

  /** 送不出去的佇列項目放回開頭,保留原本的排入時間。 */
  private requeue(agent: AgentInfo, item: QueuedPrompt): void {
    if (agent.queued.some(q => q.id === item.id)) return;
    agent.queued.unshift(item);
    this.saveQueue(agent);
  }

  /** 只在還有排隊的指令時暫停。回傳是否真的暫停了。 */
  private pauseQueue(agent: AgentInfo, reason: string): boolean {
    if (!agent.queued.length || agent.queuePaused) return false;
    agent.queuePaused = reason;
    this.saveQueue(agent);
    return true;
  }

  /** 節點狀態改變時決定佇列要暫停還是繼續。這時還在處理事件,說明與送出都排到之後才做,避免重入。 */
  private queueOnState(agent: AgentInfo, state: AgentState): void {
    const reason = state === 'idle' && this.interrupted.has(agent.id) ? '回合被中斷' : state === 'error' ? '回合出錯' : state === 'lost' ? '節點失聯' : '';
    if (reason && this.pauseQueue(agent, reason)) {
      const n = agent.queued.length;
      queueMicrotask(() => { if (this.agents.has(agent.id)) this.onAdapterEvent(agent.id, { type: 'note', text: `${reason},佇列已暫停(還有 ${n} 筆)。手動送出下一句或按佇列的「繼續」後恢復。` }); });
    }
    // 任何節點停下來都可能空出名額
    if (!BUSY.has(state)) this.schedulePump();
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => { this.pumpScheduled = false; this.pump(); });
  }

  /**
   * 依排入時間先後,把可以送出的節點佇列開頭送出,直到用完同時執行名額。
   * 只送給待命(或出錯後已按繼續)的節點;休眠、失聯、終端機模式的節點等它回到待命再送。
   */
  private pump(): void {
    const ready = [...this.agents.values()]
      .filter(a => !a.parentId && a.queued.length > 0 && !a.queuePaused && !a.terminal && (a.state === 'idle' || a.state === 'error') && this.sessions.has(a.id) && !this.starting.has(a.id))
      .sort((x, y) => x.queued[0].createdAt - y.queued[0].createdAt);
    for (const a of ready) {
      if (this.activeCount() >= this.maxActive) break;
      const item = a.queued.shift()!;
      this.saveQueue(a);
      // send 在第一個 await 之前就把節點標成 starting,下一輪計算名額時已經算進去
      void this.send(a.id, item.text, item.images, item);
    }
  }

  private onUsage(agent: AgentInfo, e: Extract<AdapterEvent, { type: 'usage' }>): void {
    if (e.windows?.length) {
      const u: BackendUsage = {
        backend: agent.backend,
        windows: e.windows.map(w => ({ label: w.label, used: Math.max(0, Math.min(1, w.used)), resetsAt: w.resetsAt, ...(w.group ? { group: w.group, match: w.match ?? [] } : {}) })),
        unsupported: false,
        updatedAt: Date.now(),
      };
      this.usage.set(agent.backend, u);
      this.store.setSetting(`usage:${agent.backend}`, JSON.stringify(u));
      this.broadcast({ usage: u });
      this.trackBudget(u);
    }
    if (e.spent && (e.spent.tokens > 0 || (e.spent.usd ?? 0) > 0)) {
      const add = { tokens: Math.max(0, e.spent.tokens), usd: Math.max(0, e.spent.usd ?? 0) };
      agent.spent = { tokens: agent.spent.tokens + add.tokens, usd: agent.spent.usd + add.usd };
      this.store.updateAgent(agent);
      // 依日期累計,儀表才算得出今天與本週的花費
      this.store.addSpend(localDate(Date.now()), agent.backend, agent.id, agent.name, add.tokens, add.usd);
      this.scheduleDashboard();
      const task = this.tasks.get(this.current.get(agent.id) ?? '') ?? [...this.tasks.values()].filter(t => t.agentId === agent.id).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (task) {
        task.cost = { tokens: (task.cost?.tokens ?? 0) + add.tokens, usd: (task.cost?.usd ?? 0) + add.usd };
        this.pushTask(task);
      }
      if (!e.context) this.broadcast({ agent: { ...agent } });
    }
    if (e.context && e.context.max > 0) {
      agent.context = { used: e.context.used, max: e.context.max };
      this.broadcast({ agent: { ...agent } });
    }
  }

  private taskRepo(taskId: string): { task: TaskInfo; cwd: string; base: string; end: string } {
    const task = this.tasks.get(taskId);
    const cwd = task && (this.taskCwd.get(task.id) ?? this.agents.get(task.agentId)?.cwd);
    const c = task?.changes;
    if (!task || !cwd || !c?.git || !c.base || !c.end) throw new Error('這個任務沒有可用的變更快照(工作目錄不是 git 版本庫,或任務還沒結束)。');
    if (BUSY.has(this.agents.get(task.agentId)?.state ?? 'idle')) throw new Error('節點還在執行,等它停下來再操作。');
    return { task, cwd, base: c.base, end: c.end };
  }

  /** 還原任務的修改。之後又被改過的檔案會跳過。 */
  async revertTask(taskId: string, paths: string[] | null): Promise<RevertResult> {
    const { task, cwd, base, end } = this.taskRepo(taskId);
    const result = await revertChanges(cwd, base, end, paths ?? undefined);
    // 還原後重新計算這個任務還剩下哪些變更
    const now = await snapshotTree(cwd).catch(() => null);
    if (now && task.changes) Object.assign(task.changes, await summarizeTrees(cwd, base, now), { end: now });
    this.pushTask(task);
    return result;
  }

  /** 把任務改過的檔案提交成一筆 commit。 */
  async commitTask(taskId: string, message: string): Promise<string> {
    const { task, cwd, base, end } = this.taskRepo(taskId);
    const sha = await commitChanges(cwd, base, end, message.trim() || task.title.slice(0, 72));
    if (task.changes) task.changes.committed = sha;
    this.pushTask(task);
    return sha;
  }

  /** 評論與審查請求要送往的節點:必須存在、不是子代理、有結構化 session 可以收指令。 */
  private reviewTarget(id: string, who: string, strict: boolean): AgentInfo {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`${who}已不存在。`);
    if (agent.parentId) throw new Error(`${who}是子代理,不能直接送指令。`);
    if (agent.terminal) throw new Error(`${who}在終端機模式,先回到對話再送。`);
    if (agent.state === 'sleeping' || !this.sessions.has(id)) throw new Error(`${who}休眠中,先喚醒再送。`);
    if (strict && (agent.state === 'error' || agent.state === 'lost')) throw new Error(`${who}目前異常,選其他節點。`);
    return agent;
  }

  /** 把變更檢視的評論整理成一則指令,送回產生這個任務的節點修改。 */
  async sendReviewComments(taskId: string, comments: ReviewComment[], source: SpeechSource = 'desktop'): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('找不到這個任務');
    const list = comments.filter(c => c && typeof c.text === 'string' && c.text.trim());
    if (!list.length) throw new Error('還沒有任何評論。');
    this.reviewTarget(task.agentId, '產生這個任務的節點', false);
    const set = await this.taskChanges(taskId);
    await this.send(task.agentId, formatCommentsPrompt({ title: task.title, comments: list, files: set.files }), [], 'user', source);
    // 使用者把評論送回去修改,等於這次的結果沒有通過:自動標成退回(使用者之後仍可在任務卡改成驗收)
    task.verdict = 'rejected';
    this.pushTask(task);
  }

  /** 判例服務(長期記憶階段 3):任務完成時由它判斷要不要請節點寫判例。啟動時由 index.ts 接上。 */
  attachCases(svc: { onTaskEnded(task: TaskInfo): unknown }): void { this.cases = svc; }
  /** 回憶錄服務:刪除節點前選擇寫回憶錄時用。啟動時由 index.ts 接上。 */
  attachMemoir(hook: MemoirHook): void { this.memoir = hook; }

  taskById(id: string): TaskInfo | undefined { return this.tasks.get(id); }

  private meetings(): MeetingRecord[] {
    if (!this.meetingLog) {
      try { this.meetingLog = JSON.parse(this.store.getSetting('meetingLog') ?? '[]') as MeetingRecord[]; } catch { this.meetingLog = []; }
      if (!Array.isArray(this.meetingLog)) this.meetingLog = [];
    }
    return this.meetingLog;
  }

  /** interop 會議結束時記下:主持人與參與者的節點 id(只留 30 天、200 筆)。 */
  recordMeeting(m: MeetingRecord): void {
    const keep = Date.now() - DISPATCH_KEEP_MS;
    this.meetingLog = [...this.meetings().filter(x => x.startedAt >= keep && x.id !== m.id), m].slice(-200);
    this.store.setSetting('meetingLog', JSON.stringify(this.meetingLog));
    this.onStatsDirty?.();
  }

  /**
   * interop 會議結束時呼叫:把逐字紀錄寫進記憶庫的 meetings/(狀態「未確認」,使用者確認後節點才查得到;格式見 meeting-record.ts)。
   * 主持人沒指定專案時記到主持人工作目錄所屬的專案。沒有記憶庫或寫入失敗只在主持人的對話裡留一則說明,不影響會議本身。
   */
  saveMeetingRecord(input: MeetingRecordInput): void {
    const vault = this.vault;
    if (!vault) return;
    const host = this.agents.get(input.hostId);
    void (async () => {
      let rec = input;
      if (!rec.projectId && host?.cwd) {
        const p = await projectOf(host.cwd).catch(() => null);
        if (p) rec = { ...rec, projectId: p.id, projectName: p.name };
      }
      const r = writeMeetingRecord(vault.dir, rec);
      // 不只靠資料夾監看(網路磁碟可能監看不到):寫完立刻重新索引
      if (r) { try { vault.rescan(); } catch { /* 下次掃描會補上 */ } }
      if (r) this.note(input.hostId, `會議紀錄已存進記憶庫:${r.path}(未確認,使用者在記憶庫確認後其他節點才查得到)。`);
    })().catch(err => this.note(input.hostId, `會議紀錄沒有存進記憶庫:${String((err as Error)?.message ?? err)}`));
  }

  /**
   * 判例的「參與節點ID」:承辦節點、交辦它的節點(task.from);從會議交辦的再加上同一場會議(時間涵蓋這個任務、承辦與主持人都在)的所有參與者。
   * 沒有會議紀錄(舊資料、重開機前)時只有前兩者。
   */
  caseParticipants(task: TaskInfo): string[] {
    const ids = new Set<string>([task.agentId]);
    // 協作流程的交辦者是流程本身(flow:<流程 id>),不是節點
    if (task.from?.id && !task.from.id.startsWith('flow:')) ids.add(task.from.id);
    if (task.from?.meeting) {
      const m = this.meetings().find(x => x.ids.includes(task.agentId) && x.ids.includes(task.from!.id) && task.startedAt >= x.startedAt - 1000 && task.startedAt <= x.endedAt + 1000);
      for (const id of m?.ids ?? []) ids.add(id);
    }
    return [...ids];
  }

  /** CLI 紀錄的 session 快取:回傳目前的內容(可能是 null),過期了就在背景重查,查完通知統計重寫。 */
  private cliSessionKeys(): Set<string> | null {
    if (!this.cliSessionsBusy && Date.now() - this.cliSessionsAt > 5 * 60 * 1000) {
      this.cliSessionsBusy = true;
      void (async () => {
        try {
          const keys = new Set<string>();
          await Promise.all((Object.keys(this.adapters) as Backend[]).map(async b => {
            const cap = this.capabilities.get(b);
            if (!cap?.available || cap.simulated) return;
            try { for (const s of await this.adapters[b].listSessions?.() ?? []) keys.add(`${b}:${s.sessionId}`); } catch { /* 這家查不到就當作沒有 */ }
          }));
          this.cliSessions = keys;
        } finally {
          this.cliSessionsAt = Date.now();
          this.cliSessionsBusy = false;
          this.onStatsDirty?.();
        }
      })();
    }
    return this.cliSessions;
  }

  /** .nexus-stats.json 的原料(純資料);組成內容由 vault-stats.ts 的 buildVaultStats 負責。 */
  statsInput(): StatsInput | null {
    const vault = this.vault;
    if (!vault) return null;
    const entries = vault.list();
    const lite = (a: AgentInfo) => ({ id: a.id, name: a.name, character: a.character, backend: a.backend, sessionId: a.sessionId, cwd: a.cwd });
    const live = [...this.agents.values()].filter(a => !a.parentId);
    const liveIds = new Set(live.map(a => a.id));
    return {
      now: Date.now(), portraitsDir: portraitsDir(),
      live: live.map(a => ({ ...lite(a), state: a.state })),
      removed: this.store.loadRemovedAgents().map(r => r.agent).filter(a => !liveIds.has(a.id)).map(lite),
      archives: readArchives(vault.dir, entries),
      tasks: this.store.loadTasksForStats(0, 100000),
      cases: entries.filter(e => e.kind === 'case'),
      dispatches: this.store.loadDispatches(100000),
      meetings: this.meetings(),
      cliSessions: this.cliSessionKeys(),
      dirExists: p => existsSync(p),
      images: c => (c ? characterImages(portraitsDir(), c) : { avatar: null, portrait: null }),
      chiefId: this.chiefId,
      chiefTerms: this.terms(),
      projectKind: id => projectKindOf(id),
    };
  }

  /** wake 網址用:節點在面板上、或是已終止還能接回(回傳要接回的 session 資料);都不是就是 null。 */
  wakeTarget(id: string): WakeTarget {
    // 和統計檔的「可接回」用同一份已終止節點清單(loadRemovedAgents)與同一個判斷(canResume)
    return wakeTargetOf(id, [...this.agents.values()], this.store.loadRemovedAgents().map(r => r.agent), p => existsSync(p));
  }
  agentById(id: string): AgentInfo | undefined { return this.agents.get(id); }

  /** 記錄任務寫成了哪份判例、或正在等節點撰寫。 */
  patchTaskCase(taskId: string, patch: { caseId?: string; casePending?: boolean }): void {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (patch.caseId !== undefined) task.caseId = patch.caseId;
    if (patch.casePending !== undefined) { if (patch.casePending) task.casePending = true; else delete task.casePending; }
    this.pushTask(task);
  }

  /** 判例的偵測與填欄位用:任務期間節點說了幾則話、失敗幾次(錯誤事件,加上這次是重試上一次失敗的同一句指令)。 */
  caseFacts(task: TaskInfo): { agentMessages: number; failures: number } {
    const events = this.store.agentEventsBetween(task.agentId, task.startedAt, task.endedAt ?? Date.now());
    const prev = [...this.tasks.values()].filter(t => t.agentId === task.agentId && t.startedAt < task.startedAt).sort((a, b) => b.startedAt - a.startedAt)[0];
    return {
      agentMessages: events.filter(e => e.type === 'message' && e.role === 'agent').length,
      failures: events.filter(e => e.type === 'error').length + (prev && prev.status === 'failed' && prev.title === task.title ? 1 : 0),
    };
  }

  /** 使用者驗收或退回一個已結束的任務;null 清除判斷。還在執行的任務不能驗收。 */
  setTaskVerdict(taskId: string, verdict: TaskVerdict): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('找不到這個任務');
    if (verdict !== null && verdict !== 'accepted' && verdict !== 'rejected') throw new Error('不正確的驗收結果');
    if (task.endedAt === null) throw new Error('任務還沒結束,結束後才能驗收。');
    if ((task.verdict ?? null) === verdict) return;
    task.verdict = verdict;
    this.pushTask(task);
  }

  setMemoryVault(v: MemoryVault): void { this.vault = v; }

  /** 記憶工具用:呼叫者的身分(是不是總管、名稱、工作目錄);找不到節點回傳 null。 */
  memoryCaller(agentId: string): MemoryCaller | null {
    const a = this.agents.get(agentId);
    return a ? { id: a.id, name: a.name, cwd: a.cwd, isChief: a.id === this.chiefId } : null;
  }

  /** 記憶工具用的相依項目;記憶庫還沒啟動時回傳 null。 */
  memoryDeps(): MemoryToolsDeps | null {
    const vault = this.vault;
    if (!vault) return null;
    return {
      vaultDir: vault.dir,
      list: () => vault.list(),
      rescan: () => { vault.rescan(); },
      nodes: () => [...this.agents.values()].filter(a => !a.parentId).map(a => ({ id: a.id, name: a.name, backendLabel: BACKEND_LABEL[a.backend], model: a.model, character: a.character })),
      project: cwd => projectOf(cwd),
      head: gitHead,
      commitsAhead: gitCommitsAhead,
      noteChief: text => { this.chiefNotes.push(text); },
      now: () => Date.now(),
    };
  }

  /** 取出並清掉給總管的記憶通知。 */
  private takeChiefNotes(agent: AgentInfo): string {
    if (agent.id !== this.chiefId || !this.chiefNotes.length) return '';
    const out = this.chiefNotes.join('\n\n');
    this.chiefNotes = [];
    return `${out}\n\n`;
  }

  /** 總管守則用:每個最上層節點(不含總管自己)的統計。資料取自資料庫,包含任務面板已清除的任務。 */
  private chiefStats(): string {
    const stats = computeNodeStats(this.store.loadTasksForStats(Date.now() - STATS_DAYS * 24 * 3600 * 1000), isWorkTask);
    const nodes: StatsNode[] = [...this.agents.values()].filter(a => !a.parentId && a.id !== this.chiefId)
      .map(a => ({ id: a.id, name: a.name, backendLabel: BACKEND_LABEL[a.backend], model: a.model }));
    const strengths = new Map<string, string>();
    if (this.vault) for (const n of nodes) { const t = readNodeStrengths(this.vault.dir, n); if (t) strengths.set(n.id, t); }
    return chiefStatsSection(nodes, stats, Date.now(), undefined, strengths);
  }

  /**
   * 總管在平常的指令前補充統計:統計有變、而且離上次告知超過 CHIEF_STATS_MS 才附上(每個任務結束都通知會太吵)。
   * session 啟動與守則更新時,守則本身就帶了最新的統計(見 chiefRules),這裡不會重複。
   */
  private takeStatsNotice(agent: AgentInfo): string {
    if (agent.id !== this.chiefId || Date.now() - this.chiefStatsSent.at < CHIEF_STATS_MS) return '';
    const section = this.chiefStats();
    if (!section || section === this.chiefStatsSent.text) return '';
    this.chiefStatsSent = { text: section, at: Date.now() };
    return `(主控台通知:各節點的統計已更新,以下內容取代先前的節點近況。)
${section}

`;
  }

  /** 把任務的變更送交另一個節點審查。提示詞在這裡組合,diff 由 taskChanges() 取得完整內容。 */
  async requestReview(taskId: string, reviewerId: string, note = '', source: SpeechSource = 'desktop'): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('找不到這個任務');
    if (reviewerId === task.agentId) throw new Error('不能送給產生這個任務的節點自己審查。');
    const reviewer = this.reviewTarget(reviewerId, '審查節點', true);
    const set = await this.taskChanges(taskId);
    if (!set.files.length) throw new Error('這個任務沒有修改任何檔案,沒有東西可以審查。');
    const author = this.agents.get(task.agentId);
    const prompt = formatReviewPrompt({
      title: task.title,
      author: { name: task.agentName, backend: BACKEND_LABEL[task.backend], model: task.model },
      changeCwd: this.taskCwd.get(task.id) ?? author?.cwd ?? '',
      reviewerCwd: reviewer.cwd,
      set,
      note,
    });
    await this.send(reviewerId, prompt, [], 'user', source);
    const title = task.title.length > 40 ? `${task.title.slice(0, 40)}…` : task.title;
    this.onAdapterEvent(reviewerId, { type: 'note', text: `上面是 ${task.agentName} 的任務「${title}」的審查請求(${set.files.length} 個檔案),只需回覆審查意見。` });
    if (author) this.onAdapterEvent(task.agentId, { type: 'note', text: `已把任務「${title}」的變更送交 ${reviewer.name} 審查。` });
  }

  private worktreeOf(id: string): { agent: AgentInfo; wt: WorktreeInfo } {
    const agent = this.agents.get(id);
    if (!agent?.worktree) throw new Error('這個節點沒有獨立工作區。');
    if (BUSY.has(agent.state)) throw new Error('節點還在執行,等它停下來再操作。');
    return { agent, wt: agent.worktree };
  }

  async worktreeStatus(id: string): Promise<WorktreeStatus | null> {
    const wt = this.agents.get(id)?.worktree;
    return wt ? worktreeStatus(wt) : null;
  }

  private lastTitle(id: string, fallback: string): string {
    const t = [...this.tasks.values()].filter(x => x.agentId === id).sort((a, b) => b.startedAt - a.startedAt)[0];
    return (t?.title ?? fallback).slice(0, 72);
  }

  /** 把節點工作區的成果合併回原本的分支。 */
  async mergeWorktree(id: string): Promise<string> {
    const { agent, wt } = this.worktreeOf(id);
    const sha = await mergeBack(wt, this.lastTitle(id, `${agent.name} 的工作`));
    this.onAdapterEvent(id, { type: 'note', text: `已把分支 ${wt.branch} 合併回 ${wt.base}(${sha})。` });
    return sha;
  }

  async openPullRequest(id: string): Promise<string> {
    const { agent, wt } = this.worktreeOf(id);
    const url = await openPullRequest(wt, this.lastTitle(id, `${agent.name} 的工作`));
    this.onAdapterEvent(id, { type: 'note', text: `已推送分支 ${wt.branch} 並開啟 PR:${url}` });
    return url;
  }

  clearFinishedTasks(): void {
    for (const [id, t] of this.tasks) if (t.endedAt !== null) { this.tasks.delete(id); this.taskStatus.delete(id); }
    this.store.deleteFinishedTasks();
    this.broadcast({ tasks: [...this.tasks.values()] });
  }

  private startTask(agent: AgentInfo, text: string, source: SpeechSource, project?: TaskInfo['project'], from?: TaskFrom): TaskInfo {
    const task: TaskInfo = {
      id: randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      backend: agent.backend,
      model: agent.model,
      title: text.replace(/\s+/g, ' ').trim().slice(0, 200),
      status: 'running',
      note: '',
      startedAt: Date.now(),
      endedAt: null,
      steps: [],
      subs: [],
      changes: null,
      source,
      ...(from ? { from } : {}),
      ...(project ? { project } : {}),
    };
    this.interrupted.delete(agent.id);
    this.turnText.delete(agent.id);
    this.taskCwd.set(task.id, agent.cwd);
    this.tasks.set(task.id, task);
    this.current.set(agent.id, task.id);
    this.pushTask(task);
    return task;
  }

  private async captureBase(agent: AgentInfo, task: TaskInfo): Promise<void> {
    // 假資料節點不拍快照;NEXUS_FAKE_SNAPSHOT=1 時照拍,讓測試能在假資料模式看到真正的差異
    if (agent.simulated && process.env.NEXUS_FAKE_SNAPSHOT !== '1') return;
    // 很大的資料夾可能要掃很久;超過時間就不等了,這個任務改用工具回報的修改
    const base = await Promise.race([snapshotTree(agent.cwd).catch(() => null), new Promise<null>(r => setTimeout(() => r(null), 8000))]);
    task.changes = { git: base !== null, base, end: null, files: 0, added: 0, removed: 0 };
    this.pushTask(task);
  }

  private async captureEnd(task: TaskInfo): Promise<void> {
    const c = task.changes;
    const cwd = this.taskCwd.get(task.id);
    if (!c || !cwd) return;
    if (c.git && c.base) {
      const end = await snapshotTree(cwd).catch(() => null);
      if (!end) return;
      // 摘要算完再一起寫入,避免畫面看到「已有結束快照但數字還是 0」的中間狀態
      const sum = await summarizeTrees(cwd, c.base, end);
      Object.assign(c, sum, { end });
    } else {
      const set = changesFromEvents(this.store.agentEventsBetween(task.agentId, task.startedAt, task.endedAt ?? Date.now()));
      c.files = new Set(set.files.map(f => f.path)).size;
      c.added = set.files.reduce((n, f) => n + f.added, 0);
      c.removed = set.files.reduce((n, f) => n + f.removed, 0);
    }
    this.pushTask(task);
  }

  /** 變更檢視用:任務期間的完整差異。任務還在執行時,以現在的工作區當作結束點。 */
  async taskChanges(taskId: string): Promise<ChangeSet> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error('找不到這個任務');
    const cwd = this.taskCwd.get(task.id) ?? this.agents.get(task.agentId)?.cwd;
    const c = task.changes;
    if (c?.git && c.base && cwd) {
      const end = c.end ?? await snapshotTree(cwd).catch(() => null);
      if (end) return diffTrees(cwd, c.base, end);
    }
    return changesFromEvents(this.store.agentEventsBetween(task.agentId, task.startedAt, task.endedAt ?? Date.now()));
  }

  private pushTask(task: TaskInfo): void {
    this.store.saveTask(task);
    // 今天的任務統計:狀態有變才重算
    if (this.taskStatus.get(task.id) !== task.status) {
      this.taskStatus.set(task.id, task.status);
      this.store.recordTask(task.id, localDate(task.startedAt), task.agentId, task.status);
      this.scheduleDashboard();
    }
    this.broadcast({ task: { ...task, steps: [...task.steps], subs: task.subs.map(s => ({ ...s })) } });
  }

  /** 回傳這次結束的任務;任務不存在或已經結束時是 null。 */
  private finishTask(agentId: string, status: TaskStatus, note = '', keepCurrent = false): TaskInfo | null {
    const task = this.tasks.get(this.current.get(agentId) ?? '');
    if (!task || task.endedAt !== null) return null;
    task.status = status;
    task.endedAt = Date.now();
    if (note) task.note = note;
    // 預設驗收:正常完成的工作任務直接算驗收,使用者按「退回」才改(主控台自己發出的封存、判例、草稿請求不算工作)
    if (status === 'done' && !task.verdict && isWorkTask(task)) task.verdict = 'accepted';
    for (const s of task.subs) if (s.status === 'running') s.status = status === 'failed' ? 'failed' : 'done';
    if (!keepCurrent) this.current.delete(agentId);
    this.interrupted.delete(agentId);
    this.pushTask(task);
    void this.captureEnd(task);
    // 回憶錄或記憶草稿請求的回合結束了還沒提交:清掉那份請求(之後不能再被叫去補交)
    try { this.memoir?.turnEnded(agentId, task.title, task); } catch (e) { console.error('清除記憶請求失敗', e); }
    return task;
  }

  /** 回合結束時的語音播報:只播使用者從桌面發起的回合(舊任務沒有來源,當成桌面)。 */
  private speakEnd(agent: AgentInfo, task: TaskInfo | null, failed?: 'error' | 'lost'): void {
    if (!task || (task.source ?? 'desktop') !== 'desktop') return;
    const base = { agentId: agent.id, agentName: agent.name, ts: Date.now() };
    if (failed) this.speak({ ...base, kind: 'failed', reason: failed, queuePaused: !!agent.queuePaused, taskId: task.id });
    else if (task.status === 'done') this.speak({ ...base, kind: 'done', taskId: task.id, summary: summarizeForSpeech(this.turnText.get(agent.id) ?? []) });
    this.turnText.delete(agent.id);
  }

  /** 依節點的事件更新它目前的任務;任務的狀態只由事件決定。 */
  private trackTask(agent: AgentInfo, e: AdapterEvent): void {
    const task = this.tasks.get(this.current.get(agent.id) ?? '');
    if (!task) return;
    switch (e.type) {
      case 'state':
        if (e.state === 'planning' || e.state === 'working' || e.state === 'awaiting') {
          const status: TaskStatus = e.state === 'awaiting' ? 'awaiting' : 'running';
          // 被標成失聯後又收到事件:任務其實還在跑,恢復成進行中
          if (task.endedAt !== null) { task.endedAt = null; task.note = ''; }
          else if (task.status === status) return;
          task.status = status;
          this.pushTask(task);
        } else if (e.state === 'idle') {
          // 後台自己取消的回合(Codex、ACP)也會回到待命,由轉接器以 outcome 標明
          const ended = this.finishTask(agent.id, this.interrupted.has(agent.id) || e.outcome === 'interrupted' ? 'interrupted' : 'done');
          this.speakEnd(agent, ended);
          // 判例:正常完成的任務是不是困難任務,是的話請承辦節點把解法寫下來。
          // 協作流程的交辦不偵測:否則判例服務會在流程中途對節點排入「撰寫判例」的指令
          if (ended?.status === 'done' && !ended.from?.flow) this.cases?.onTaskEnded(ended);
        } else if (e.state === 'error') {
          this.speakEnd(agent, this.finishTask(agent.id, 'failed', e.detail ?? ''), 'error');
        } else if (e.state === 'lost') {
          this.speakEnd(agent, this.finishTask(agent.id, 'failed', e.detail || '失聯', true), 'lost');
        } else if (e.state === 'sleeping') {
          this.finishTask(agent.id, 'interrupted', '節點休眠');
        }
        return;
      case 'plan':
        task.steps = e.steps;
        this.pushTask(task);
        return;
      case 'subagent': {
        if (e.phase === 'start') {
          if (!task.subs.some(s => s.id === e.subId)) task.subs.push({ id: e.subId, name: e.name.slice(0, 40), status: 'running' });
        } else {
          const sub = task.subs.find(s => s.id === e.subId);
          if (sub) sub.status = e.failed ? 'failed' : 'done';
        }
        this.pushTask(task);
        return;
      }
      case 'error':
        if (task.endedAt === null) task.note = e.message.slice(0, 160);
        return;
      default:
        return;
    }
  }

  /** 節點呼叫子代理時,自動在面板上加一個子節點。 */
  private addSub(parent: AgentInfo, subId: string, name: string): void {
    const key = `${parent.id}:${subId}`;
    if (this.subs.has(key)) return;
    const child: AgentInfo = {
      id: randomUUID(),
      name: (name.trim() || '子代理').slice(0, 40),
      character: parent.character,
      backend: parent.backend,
      cwd: parent.cwd,
      permissionMode: parent.permissionMode,
      model: '',
      context: null,
      parentId: parent.id,
      sessionId: null,
      state: 'working',
      detail: '啟動中',
      pendingApproval: null,
      pendingQuestion: null,
      worktree: null,
      spent: { tokens: 0, usd: 0 },
      terminal: false,
      simulated: parent.simulated,
      createdAt: Date.now(),
      queued: [],
      queuePaused: null,
    };
    this.subs.set(key, child.id);
    this.agents.set(child.id, child);
    this.broadcast({ agent: { ...child } });
  }

  /** 子代理結束:子節點先回到待命顯示結果,過一會兒自動移除。 */
  private finishSub(parentId: string, subId: string, failed: boolean): void {
    const childId = this.subs.get(`${parentId}:${subId}`);
    if (!childId || !this.agents.has(childId)) return;
    this.onAdapterEvent(childId, { type: 'state', state: failed ? 'error' : 'idle', detail: failed ? '失敗' : '已完成' });
    setTimeout(() => this.dropSub(childId), SUB_LINGER_MS).unref?.();
  }

  private dropSub(childId: string): void {
    if (!this.agents.delete(childId)) return;
    for (const [key, id] of this.subs) if (id === childId) this.subs.delete(key);
    this.broadcast({ removedId: childId });
  }

  private dropSubsOf(parentId: string): void {
    for (const a of [...this.agents.values()]) if (a.parentId === parentId) this.dropSub(a.id);
  }

  /** 失聯偵測:行程還在但太久沒有任何事件。之後若又收到事件,狀態會自然恢復。 */
  private watchdogTick(): void {
    const now = Date.now();
    for (const agent of this.agents.values()) {
      if (agent.state !== 'planning' && agent.state !== 'working') continue;
      if (!this.sessions.has(agent.id)) continue;
      const quiet = now - (this.lastEvent.get(agent.id) ?? now);
      if (quiet < STALL_MS) continue;
      const mins = Math.max(1, Math.round(STALL_MS / 60000));
      this.onAdapterEvent(agent.id, { type: 'error', message: `超過 ${mins} 分鐘沒有收到任何回應。可以繼續等待,或按「重新連線」重啟這個節點。` });
      this.onAdapterEvent(agent.id, { type: 'state', state: 'lost', detail: '久未回應' });
    }
  }

  /** 假資料節點在待命時偶爾自己收到一句指令,讓面板持續有動靜。 */
  private autopilotTick(): void {
    if (!this.autopilot) return;
    for (const agent of this.agents.values()) {
      // 有排隊指令的節點交給佇列,不插入示範指令;達到上限時也不排隊
      if (agent.simulated && agent.state === 'idle' && this.sessions.has(agent.id) && !agent.queued.length && !this.starting.has(agent.id) && Math.random() < 0.3) {
        void this.send(agent.id, DEMO_PROMPTS[Math.floor(Math.random() * DEMO_PROMPTS.length)], [], 'autopilot');
      }
    }
  }
}

/** 專案類型的快取(只有專案ID、任務沒記下類型時用);程式執行期間不重算。 */
const projectKinds = new Map<string, 'git' | '資料夾'>();
function projectKindOf(id: string): 'git' | '資料夾' {
  let kind = projectKinds.get(id);
  if (!kind) { kind = projectKindFromPath(id); projectKinds.set(id, kind); }
  return kind;
}

/** 節點目前側寫(依節點 ID 找,見 nodeProfilePath)裡「特長」一段;沒有側寫或讀不到就是空字串。 */
function readLiveTraits(vaultDir: string, node: { id: string; name: string }): string {
  try { return extractSection(readFileSync(join(vaultDir, ...nodeProfilePath(vaultDir, node).split('/')), 'utf8'), '特長'); } catch { return ''; }
}