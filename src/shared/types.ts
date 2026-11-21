// 主行程、preload 與畫面共用的型別。畫面只認這裡定義的狀態與事件。

import type { DashboardData } from './dashboard';

export type Backend = 'claude' | 'codex' | 'antigravity';

/** 統一的七種狀態;三家 CLI 的事件都由轉接器翻譯成這一組。 */
export type AgentState = 'idle' | 'planning' | 'working' | 'awaiting' | 'error' | 'lost' | 'sleeping';

/** 主面板的區塊。chief(總管)不對應任何狀態:被指定為總管的節點固定放在這裡。 */
export type Zone = 'standby' | 'planning' | 'active' | 'auth' | 'fault' | 'chief';

export const STATE_ZONE: Record<AgentState, Exclude<Zone, 'chief'>> = {
  idle: 'standby',
  sleeping: 'standby',
  planning: 'planning',
  working: 'active',
  awaiting: 'auth',
  error: 'fault',
  lost: 'fault',
};

export const STATE_LABEL: Record<AgentState, string> = {
  idle: '待命',
  planning: '規劃中',
  working: '執行中',
  awaiting: '待授權',
  error: '出錯',
  lost: '失聯',
  sleeping: '休眠',
};

export const BACKEND_LABEL: Record<Backend, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
};

export type PermissionMode = 'ask' | 'auto';
export type ApprovalDecision = 'allow' | 'allow_session' | 'deny';

export interface PendingApproval {
  requestId: string;
  tool: string;
  summary: string;
  /** 完整的工具參數,給對話視窗展開檢視。 */
  detail: string;
  /** 後台是否支援「本次 session 都允許」。 */
  canAllowSession: boolean;
}

/** 節點的獨立工作區(git worktree)。 */
export interface WorktreeInfo { repoRoot: string; path: string; branch: string; base: string }
export interface WorktreeStatus { exists: boolean; dirty: boolean; ahead: number; branch: string; base: string }
export interface DirInfo { exists: boolean; isRepo: boolean; branch: string; hasCommit: boolean }
export interface RevertResult { reverted: string[]; skipped: Array<{ path: string; reason: string }> }
/** 累計花費。usd 只有 Claude Code 會回報,而且在訂閱制下只是估算值。 */
export interface Spent { tokens: number; usd: number }

export interface QuestionOption { label: string; description: string }
export interface AgentQuestion { id: string; header: string; question: string; options: QuestionOption[]; multi: boolean }
/** agent 用提問工具問使用者的問題,等待作答。 */
export interface PendingQuestion { requestId: string; questions: AgentQuestion[] }

export interface AgentInfo {
  id: string;
  name: string;
  /** 立繪資料夾裡的角色名稱;空字串表示使用內建的 [REDACTED] 預設圖。 */
  character: string;
  backend: Backend;
  cwd: string;
  permissionMode: PermissionMode;
  /** 指定的模型;空字串表示使用該 CLI 的預設。 */
  model: string;
  /** 這個 session 的記憶空間(context)用量;還沒有資料時是 null。 */
  context: { used: number; max: number } | null;
  /** 子代理節點才有:呼叫它的節點。子節點由系統自動建立與移除,只能觀看。 */
  parentId: string | null;
  /** 後台 CLI 的 session 識別碼,用來續接。 */
  sessionId: string | null;
  state: AgentState;
  /** 進入目前這個狀態的時間;儀表用來提醒「異常太久」。重開主控台後從還原的時間算起,舊資料沒有這個欄位。 */
  stateSince?: number;
  /** 一行狀態讀數,例如目前的工具或錯誤原因。 */
  detail: string;
  pendingApproval: PendingApproval | null;
  pendingQuestion: PendingQuestion | null;
  /** 有值表示這個節點在自己的 git worktree 與分支上工作。 */
  worktree: WorktreeInfo | null;
  spent: Spent;
  /** 終端機模式:結構化 session 已停下,改在虛擬終端機裡執行原生 CLI。 */
  terminal: boolean;
  /** 這個節點目前由假資料轉接器驅動。 */
  simulated: boolean;
  createdAt: number;
  /** 排隊中的指令,依序在節點待命時自動送出;重開主控台後仍保留。 */
  queued: QueuedPrompt[];
  /** 佇列暫停的原因(例如回合出錯、被中斷、達到額度上限);null 表示沒有暫停。 */
  queuePaused: string | null;
}

/** 排在節點佇列裡、還沒送出的一句指令。 */
/**
 * 指令是從哪裡送出的(語音播報用):desktop 是桌面畫面、remote 是手機或瀏覽器版、interop 是節點互相呼叫或會議、
 * autopilot 是假資料的自動運作。只有 desktop 發起的回合完成時會念出摘要。
 */
export type SpeechSource = 'desktop' | 'remote' | 'interop' | 'autopilot' | 'archive' | 'case' | 'draft';

/** source 是後來才加的;舊佇列沒有這個欄位,當成 desktop。 */
export interface QueuedPrompt { id: string; text: string; images: string[]; createdAt: number; source?: SpeechSource; from?: TaskFrom }

/** 節點互相呼叫(或會議)時,指令是哪個節點交辦的;meeting 為 true 表示是會議裡的發言回合。 */
export interface TaskFrom { id: string; name: string; meeting?: boolean }

/** 一個額度視窗(例如 5 小時、每週)。used 是 0 到 1 的已用比例。 */
export interface UsageWindow {
  label: string;
  used: number;
  resetsAt: number | null;
  /** 額度依模型分組的後台(Antigravity)才有:這個額度所屬的模型群組名稱。 */
  group?: string;
  /** 屬於這個群組的模型名稱片段(小寫、以空白分隔),用來判斷節點的模型算哪一組。 */
  match?: string[];
}

/**
 * 挑出與這個節點的模型有關的額度:沒有分組的額度一律算,有分組的只算模型所屬的那一組。
 * 全部都有分組(Antigravity)而判斷不出模型屬於哪一組時(例如使用預設模型),算第一組。
 */
export function usageWindowsFor(model: string, windows: UsageWindow[]): UsageWindow[] {
  if (!windows.some(w => w.group)) return windows;
  const id = model.toLowerCase().replace(/[-._]+/g, ' ');
  const hit = id ? windows.find(w => w.match?.some(m => id.startsWith(m))) : undefined;
  const group = hit?.group ?? (windows.every(w => w.group) ? windows[0].group : undefined);
  return windows.filter(w => !w.group || w.group === group);
}

/** 一家後台帳號的剩餘額度。額度是帳號共用的,不是每個節點各自一份。 */
export interface BackendUsage {
  backend: Backend;
  windows: UsageWindow[];
  /** 這家 CLI 不提供額度資訊。 */
  unsupported: boolean;
  updatedAt: number;
}

export type TaskStatus = 'running' | 'awaiting' | 'done' | 'failed' | 'interrupted';
export interface TaskStep { text: string; status: 'pending' | 'active' | 'done' }
export interface TaskSub { id: string; name: string; status: 'running' | 'done' | 'failed' }

/** 變更檢視裡的一個檔案。 */
export interface ChangedFile { path: string; status: 'A' | 'M' | 'D'; added: number; removed: number; binary: boolean; patch: string }

/** 一個任務期間的檔案變更。source 是 git 表示由前後快照相減得到;tools 表示只能列出編輯工具回報的修改。 */
export interface ChangeSet { source: 'git' | 'tools'; note: string; files: ChangedFile[]; truncated: boolean }

/**
 * 變更檢視裡的一則評論。path 為 null 是不綁定特定行的整體意見。
 * side 是 new 表示新增行或上下文行,line 是新檔行號;old 表示被刪除的行,line 是舊檔行號。
 * 差異沒有行號資訊(例如不是 git 版本庫)時 line 為 null。row 是這一行在該檔案 patch 裡的位置(從 0 起算)。
 */
export interface ReviewComment { path: string | null; row: number | null; side: 'new' | 'old' | null; line: number | null; text: string }

/** 任務的變更摘要。base 與 end 是任務前後的工作區快照(git tree);不是 git 版本庫時 git 為 false。 */
export interface TaskChanges { git: boolean; base: string | null; end: string | null; files: number; added: number; removed: number; committed?: string }

/** 任務面板上的一筆任務:使用者對某個節點下的一句指令。由核心服務依事件自動建立與更新。 */
export interface TaskInfo {
  id: string;
  agentId: string;
  agentName: string;
  backend: Backend;
  model: string;
  title: string;
  status: TaskStatus;
  /** 補充說明,例如失敗原因。 */
  note: string;
  startedAt: number;
  endedAt: number | null;
  /** 後台回報的計畫步驟(目前只有 Codex 會回報)。 */
  steps: TaskStep[];
  /** 這個任務期間呼叫的子代理。 */
  subs: TaskSub[];
  /** 這個任務的花費。 */
  cost?: Spent;
  /** 檔案變更摘要;假資料節點或舊資料沒有這個欄位。 */
  changes?: TaskChanges | null;
  /** 這個任務的指令是從哪裡送出的;舊資料沒有這個欄位。 */
  source?: SpeechSource;
  /** source 為 interop 時:是哪個節點交辦的(任務卡顯示「由 … 交辦」);舊資料沒有這個欄位。 */
  from?: TaskFrom;
  /** 交辦當下節點所在的專案(之後不會依節點目前的工作目錄重算);舊資料沒有這個欄位。 */
  project?: { id: string; name: string; /** 專案根目錄是不是 git 版本庫(交辦當下記下);舊資料沒有這個欄位。 */ git?: boolean };
  /**
   * 使用者驗收:accepted 已驗收、rejected 退回、null 或沒有 = 尚未判斷。和 status 分開:
   * status 只代表回合有沒有正常結束,驗收才代表結果對不對。使用者按任務卡的按鈕、或把審查評論送回節點時(自動退回)會設定。
   */
  verdict?: TaskVerdict;
  /** 這個任務寫成的判例案號(例如 2026-0003);有值就不會再請節點撰寫。 */
  caseId?: string;
  /** 已請承辦節點撰寫判例、還在等它提交。 */
  casePending?: boolean;
}
export type TaskVerdict = 'accepted' | 'rejected' | null;

/** 記憶庫裡一筆記憶(一個 .md 檔)在資料庫索引中的樣子。 */
export interface MemoryEntry {
  /** 相對於記憶庫資料夾的路徑,一律用 /。 */
  path: string;
  kind: 'node' | 'case' | 'knowledge' | 'preference';
  scope: '全域' | '專案';
  projectId: string;
  nodeId: string;
  title: string;
  /** 記憶自己標的更新時間(front matter 的「更新時間」),沒有就用檔案修改時間。 */
  updatedAt: number;
  /** 檔案修改時間(毫秒),用來判斷檔案有沒有被改過。 */
  mtime: number;
  size: number;
  /** 例如 未確認 / 已確認 / 退回;沒寫就是空字串。 */
  status: string;
  /** 子類:knowledge 的 決策 / 書籤(屬性「子類」);沒寫就是空字串。 */
  subtype: string;
  /** 這筆取代的舊檔路徑(屬性「取代」,去掉 [[ ]]);沒寫就是空字串。 */
  supersedes: string;
}

/** 轉接器送給核心服務的事件。 */
export type AdapterEvent =
  /** outcome:回合是被中斷才回到待命的(包括後台自己取消),不是正常完成。 */
  | { type: 'state'; state: AgentState; detail?: string; outcome?: 'interrupted' }
  | { type: 'message'; role: 'user' | 'agent'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; name: string; summary: string; detail?: string; failed?: boolean }
  /** 工具結果或 agent 產生的圖片。path 是本機檔案(工作目錄內或主控台的媒體資料夾),圖片內容不進事件紀錄。 */
  | { type: 'image'; path: string; caption?: string }
  | { type: 'approval_request'; requestId: string; tool: string; summary: string; detail?: string; canAllowSession?: boolean }
  | { type: 'approval_resolved'; requestId: string; decision: ApprovalDecision }
  | { type: 'session'; sessionId: string }
  | { type: 'subagent'; phase: 'start' | 'end'; subId: string; name: string; failed?: boolean }
  | { type: 'plan'; steps: TaskStep[] }
  | { type: 'question'; requestId: string; questions: AgentQuestion[] }
  | { type: 'question_resolved'; requestId: string; answers: Record<string, string[]> | null }
  /** 回覆生成中的片段;只即時推送,不寫進事件紀錄。 */
  | { type: 'delta'; text: string }
  | { type: 'usage'; windows?: UsageWindow[]; context?: { used: number; max: number }; spent?: { tokens: number; usd?: number } }
  /** 主控台自己產生的說明訊息,例如合併結果。 */
  | { type: 'note'; text: string }
  | { type: 'error'; message: string };

/** 寫進資料庫並推送給畫面的事件。 */
export type NexusEvent = AdapterEvent & { seq: number; agentId: string; ts: number };

/** 啟動時探測到的後台能力;不支援的功能在畫面上反灰。 */
export interface Capability {
  backend: Backend;
  available: boolean;
  simulated: boolean;
  version: string | null;
  approvals: boolean;
  interrupt: boolean;
  resume: boolean;
  /** 能從既有的 session 分支出新的 session(分支對話)。 */
  fork: boolean;
  note: string;
  /** 可選的模型建議清單;使用者也可以自行輸入。 */
  models: string[];
  /** 可以直接內嵌給模型看的附件類型;其他類型只會把路徑寫進指令。 */
  attachments: AttachmentKind[];
}

export type AttachmentKind = 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'other';

const ATTACHMENT_EXT: Record<string, AttachmentKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
  pdf: 'pdf',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', flac: 'audio', aac: 'audio', opus: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  txt: 'text', md: 'text', json: 'text', csv: 'text', tsv: 'text', log: 'text', xml: 'text', yaml: 'text', yml: 'text', toml: 'text', ini: 'text', html: 'text', css: 'text',
  js: 'text', ts: 'text', tsx: 'text', jsx: 'text', py: 'text', rs: 'text', go: 'text', java: 'text', c: 'text', h: 'text', cpp: 'text', cs: 'text', sh: 'text', ps1: 'text', sql: 'text',
};

/**
 * 依副檔名判斷附件類型。image 只包含模型普遍能直接看的四種格式(PNG、JPEG、GIF、WebP),
 * 其他圖片格式(BMP、SVG、HEIC 等)算 other,只傳路徑。
 */
export function attachmentKind(path: string): AttachmentKind {
  const m = /\.([a-z0-9]+)$/i.exec(path);
  return (m && ATTACHMENT_EXT[m[1].toLowerCase()]) || 'other';
}

/** 附件類型的中文名稱,顯示在附件標籤上。 */
export const ATTACHMENT_LABEL: Record<AttachmentKind, string> = { image: '圖片', pdf: 'PDF', audio: '音訊', video: '影片', text: '文字', other: '檔案' };

export interface Snapshot {
  agents: AgentInfo[];
  events: NexusEvent[];
  capabilities: Capability[];
  autopilot: boolean;
  /** 同時執行中的節點數上限。 */
  maxActive: number;
  /** 某後台的額度用到這個百分比就不再送出新指令;0 表示不限制。 */
  quotaStop: number;
  tasks: TaskInfo[];
  usage: BackendUsage[];
  /** 立繪資料夾裡可用的角色。 */
  characters: string[];
  portraitsDir: string;
  /** 外部觀察節點(由 hooks 回報、不是主控台啟動的 CLI)。由主行程在取快照時另外附上。 */
  observed?: ObservedSession[];
  /** 只有遠端裝置拿到的快照才有:這支裝置的權限。 */
  access?: RemoteAccess;
  /** 總管節點(主控語音模式):使用者對它說的話由它分派給其他節點;null 表示沒有指定。 */
  chiefId: string | null;
  /** 總覽儀表的資料:每日預算、花費與今天的任務統計。 */
  dashboard: DashboardData;
  /** 目前進行中的協作連線(節點呼叫節點、會議);面板上畫成連線。 */
  links: LinkInfo[];
  /** 分派紀錄:最近的節點交辦(新的在前,最多 50 筆)。 */
  dispatches: DispatchEntry[];
}

/** 一條進行中的協作連線:ask 是 from 呼叫 to[0];meeting 是主持人 from 與每位參與者 to。 */
export interface LinkInfo {
  id: string;
  kind: 'ask' | 'meeting';
  from: string;
  to: string[];
  label?: string;
  startedAt: number;
  active: boolean;
  /** 會議:目前正在發言的參與者。 */
  speaker?: string;
}

export type DispatchStatus = 'running' | 'done' | 'failed' | 'timeout';

/** 分派紀錄的一筆:一次 ask_node。 */
export interface DispatchEntry {
  id: string;
  startedAt: number;
  endedAt: number | null;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  /** 指令的簡短標題。 */
  title: string;
  status: DispatchStatus;
  /** 被呼叫節點因此產生的任務(花費從任務查);沒有時為空。 */
  taskId?: string;
  /** 交辦當下發起者是不是總管;舊資料沒有這個欄位。 */
  fromChief?: boolean;
}

/**
 * 外部觀察節點:使用者在主控台以外(例如 VS Code 的終端機)執行的 CLI,經由 hooks 回報狀態。
 * 只能觀看,不能操作;要操作得先「接手」成為正式節點。不寫進資料庫。
 */
export interface ObservedSession {
  sessionId: string;
  backend: Backend;
  cwd: string;
  state: AgentState;
  /** 一行狀態讀數,例如目前的工具。 */
  detail: string;
  /** 正在執行(或等待授權)的工具名稱。 */
  tool: string;
  startedAt: number;
  lastAt: number;
  /** 最近幾筆事件的摘要,新的在後面。 */
  recent: Array<{ ts: number; text: string }>;
}

/** 外部觀察(hooks 接收端與安裝狀態),給設定面板顯示。 */
export interface ObserveStatus {
  listening: boolean;
  port: number;
  /** 接收端的錯誤,例如連接埠被佔用。 */
  error: string;
  /** 要修改的 Claude Code 使用者設定檔。 */
  settingsPath: string;
  /** none:沒有裝;current:已裝且與目前的連接埠、權杖相符;stale:裝過但連接埠或權杖已改變,需要重新安裝。 */
  installed: 'none' | 'current' | 'stale';
  /** 讀取設定檔失敗的原因(例如 JSON 格式錯誤)。 */
  settingsError: string;
  /** 會加入的 hook 事件。 */
  events: string[];
  /** 實際寫入的 hook 內容(權杖遮住),給使用者確認。 */
  preview: string;
}

/** 核心服務推送給畫面的增量更新。 */
export interface Update {
  agent?: AgentInfo;
  event?: NexusEvent;
  removedId?: string;
  autopilot?: boolean;
  maxActive?: number;
  quotaStop?: number;
  usage?: BackendUsage;
  delta?: { agentId: string; text: string };
  /** 終端機模式的輸出。 */
  term?: { agentId: string; data: string };
  /** 單筆任務新增或更新。 */
  task?: TaskInfo;
  /** 整份任務清單被取代(清除已結束的任務時)。 */
  tasks?: TaskInfo[];
  /** 外部觀察節點新增或更新。 */
  observed?: ObservedSession;
  /** 外部觀察節點移除(session 結束、閒置太久或被接手)。 */
  observedRemovedId?: string;
  /** 總管節點換了(null 表示解除)。 */
  chiefId?: string | null;
  /** 總覽儀表的資料有變(花費、預算用量、任務統計、換日)。 */
  dashboard?: DashboardData;
  /** 目前進行中的協作連線(整份取代)。 */
  links?: LinkInfo[];
  /** 分派紀錄(整份取代)。 */
  dispatches?: DispatchEntry[];
}

export interface CreateAgentInput {
  /** 在獨立的 git worktree 與分支上工作。 */
  isolate?: boolean;
  /** 建立後指定為總管節點。 */
  chief?: boolean;
  name: string;
  character: string;
  model: string;
  backend: Backend;
  cwd: string;
  permissionMode: PermissionMode;
}

/** 轉接器從 CLI 自己的紀錄列出的舊 session。 */
export interface ExternalSession { sessionId: string; title: string; cwd: string; updatedAt: number; suggestedName: string }

/**
 * 「開啟舊 session」清單上的一列。
 * source 是 nexus 表示主控台開過(名稱、角色、模型都記得);cli 表示只存在於 CLI 自己的紀錄。
 */
export interface OldSession {
  backend: Backend;
  sessionId: string;
  title: string;
  cwd: string;
  cwdExists: boolean;
  updatedAt: number;
  source: 'nexus' | 'cli';
  /** 幾分鐘內還有更新,可能正被其他程式使用。 */
  maybeActive: boolean;
  /** 主控台開過的才有:當時的節點 id,復原後對話紀錄會接回來。 */
  agentId: string | null;
  name: string;
  character: string;
  model: string;
}

export interface OpenOldSessionInput {
  backend: Backend;
  sessionId: string;
  cwd: string;
  agentId: string | null;
  name: string;
  character: string;
  model: string;
}

/**
 * 分支對話:從既有的 session 分支出一個新節點,新節點有自己的 session,不會佔用來源。
 * 來源可以是面板上的節點,或「開啟舊 session」清單上的一列。
 */
export interface ForkAgentInput {
  source: { kind: 'agent'; agentId: string } | { kind: 'session'; backend: Backend; sessionId: string; cwd: string; agentId: string | null };
  name: string;
  /** 在獨立的 git worktree 與分支上工作。 */
  isolate?: boolean;
  /** 不填沿用來源的模型與角色。 */
  model?: string;
  character?: string;
}

/** 手機遠端的狀態,給桌面版的設定面板顯示。 */
/** 遠端裝置的角色:完整、操作(可對節點下指令)、唯讀。 */
export type RemoteRole = 'full' | 'operator' | 'viewer';

/** 遠端裝置的權限:角色與可見的節點;agents 為 null 表示全部節點。完整角色一律不限節點。 */
export interface RemoteAccess { role: RemoteRole; agents: string[] | null }

/** 操作紀錄的一筆:哪支裝置對哪個節點做了什麼。role 為 desktop 表示是在主控台上做的(配對、撤銷、改權限)。 */
export interface AuditEntry {
  id: number;
  ts: number;
  deviceId: string;
  device: string;
  role: RemoteRole | 'desktop';
  action: string;
  agentId: string;
  agentName: string;
  detail: string;
  /** false 表示因為權限不足被拒絕。 */
  ok: boolean;
}

export interface RemoteStatus {
  enabled: boolean;
  /** 是否也在區域網路的位址上聆聽。 */
  lan: boolean;
  port: number;
  tailscaleIp: string | null;
  lanIp: string | null;
  listening: string[];
  /** 手機要開啟的網址(含一次性配對碼);沒有可用的位址時是 null。 */
  url: string | null;
  qr: string | null;
  pairCode: string;
  pairExpires: number;
  /** 下一支用配對碼配對的裝置會得到的權限。 */
  pairAccess: RemoteAccess;
  devices: Array<{ id: string; name: string; createdAt: number; lastSeen: number; role: RemoteRole; agents: string[] | null }>;
  error: string;
}

/**
 * 語音模式(實驗性,Phase 1:按住說話轉成文字)。語音服務是主控台啟動的本機 Python 程式(tools/voice-server)。
 * off:沒有啟用;starting:行程啟動中;warming:模型載入中;ready:可以錄音;error:啟動或載入失敗;
 * unsupported:這個畫面不能用(瀏覽器版的遠端介面)。
 */
export type VoiceState = 'off' | 'starting' | 'warming' | 'ready' | 'error' | 'unsupported';

export interface VoiceStatus {
  enabled: boolean;
  /** 使用者填的啟動指令;空字串表示用 defaultCommand。 */
  command: string;
  /** 找得到 tools/voice-server/server.py 時的預設啟動指令;找不到是空字串。 */
  defaultCommand: string;
  /** faster-whisper 模型名稱;空字串表示用服務的預設值(large-v3-turbo)。 */
  model: string;
  state: VoiceState;
  /** 錯誤原因或補充說明。 */
  detail: string;
  /** 實際使用的裝置與精度,例如 cuda/int8_float16。 */
  device: string;
  /** 語音服務最近的輸出,給設定面板除錯用。 */
  log: string[];
  /** CosyVoice repo 資料夾;有填才啟用語音合成(Phase 3)。 */
  ttsDir: string;
  /** CosyVoice 2 模型資料夾;空字串表示 <ttsDir>/pretrained_models/CosyVoice2-0.5B。 */
  ttsModel: string;
  /** 語音合成的狀態:off 沒有設定、warming 載入中、ready 可以用、unloaded 手動卸載了(釋放顯示卡記憶體)、error 失敗(detail 是原因)。vramMB 是語音服務的 PyTorch 佔用的顯示卡記憶體。 */
  tts: { state: 'off' | 'warming' | 'ready' | 'unloaded' | 'error'; detail: string; vramMB?: number };
}

export interface VoiceTranscript { text: string; audioMs: number; durationMs: number }

/** 角色的聲音設定。ms 是參考錄音的長度。 */
export interface VoiceProfile { hasVoice: boolean; ms: number; promptText: string; style: string }

/**
 * 語音播報的通知(Phase 2a),主行程只推給桌面畫面。
 * done:桌面發起的回合正常完成,summary 是規則摘要(null 表示找不到適合念的句子,畫面改念固定的完成通知);
 * failed:桌面發起的回合出錯、失聯,或排隊的指令被額度上限擋下;approval、question:節點在等使用者(不分來源)。
 * failed 的 reason 是 budget 時不屬於任何節點:某家後台今天的用量超過每日預算(agentName 是後台名稱,agentId 是 budget:<後台>),一天最多念一次。
 */
export type SpeechNotice =
  | { kind: 'done'; agentId: string; agentName: string; ts: number; taskId: string; summary: string | null }
  | { kind: 'failed'; agentId: string; agentName: string; ts: number; reason: 'error' | 'lost' | 'quota' | 'budget'; queuePaused: boolean; taskId?: string }
  | { kind: 'approval' | 'question'; agentId: string; agentName: string; ts: number; requestId: string };

/**
 * 語音播報的引擎(聲音來源)。播報時依使用者排的順序逐一嘗試,第一個產生出聲音的就用它;全部都沒有聲音時改用系統語音。
 * - clips:角色資料夾 clips/ 裡預先錄好的固定語音(依事件挑一條),不需要語音服務,沒有延遲;念不出完成摘要。
 * - local:本機語音服務的語音合成(目前是 CosyVoice 2),用角色的參考錄音念出整句。
 */
export type SpeechEngineId = 'clips' | 'local';
export const SPEECH_ENGINES: readonly SpeechEngineId[] = ['clips', 'local'];
/** 固定語音的事件;檔名是 <事件>.wav 或 <事件>-<任意>.wav(也接受 .mp3;同一事件有多條時隨機挑)。lost、quota 沒有時改用 failed。 */
export type SpeechClipKind = 'done' | 'approval' | 'question' | 'failed' | 'lost' | 'quota';
export const SPEECH_CLIP_KINDS: readonly SpeechClipKind[] = ['done', 'approval', 'question', 'failed', 'lost', 'quota'];
export interface SpeechSettings {
  /** 啟用的引擎,依嘗試順序排列;空陣列表示只用系統語音。 */
  engines: SpeechEngineId[];
}
export interface SpeechEngineState {
  id: SpeechEngineId;
  /** 目前能不能用:clips 看有沒有角色錄了固定語音,local 看語音合成的狀態。 */
  ready: boolean;
  detail: string;
}
/** 一個角色的固定語音:每個事件有幾條。 */
export interface SpeechClipSet { character: string; counts: Partial<Record<SpeechClipKind, number>> }

/** preload 暴露給畫面的介面。 */
export interface NexusApi {
  /**
   * 播報用:依引擎順序產生這則通知的聲音,回傳 WAV 與實際用的引擎;都沒有聲音時回傳 null(呼叫端改用系統語音)。
   * text 是要念的整句(local 引擎用);clips 引擎依 notice 的事件挑固定語音。瀏覽器版回傳 null。
   */
  speechRender(notice: SpeechNotice, text: string): Promise<{ audio: ArrayBuffer; mime: string; engine: SpeechEngineId } | null>;
  speechSettings(): Promise<{ settings: SpeechSettings; engines: SpeechEngineState[]; clips: SpeechClipSet[] }>;
  speechSet(patch: Partial<SpeechSettings>): Promise<{ settings: SpeechSettings; engines: SpeechEngineState[]; clips: SpeechClipSet[] }>;
  /** 試聽一個角色某個事件的固定語音;沒有時回傳 null。 */
  speechClip(character: string, kind: SpeechClipKind): Promise<{ audio: ArrayBuffer; mime: string } | null>;
  /** 指定總管節點;null 表示解除。總管會收到額外的「總管守則」,負責把使用者交代的事分派給其他節點。 */
  setChief(id: string | null): Promise<void>;
  /** 語音模式:只有桌面畫面能用;瀏覽器版的遠端介面回傳 state 為 unsupported。 */
  voiceStatus(): Promise<VoiceStatus>;
  voiceSet(patch: { enabled?: boolean; command?: string; model?: string; ttsDir?: string; ttsModel?: string; restart?: boolean }): Promise<VoiceStatus>;
  /**
   * 用節點(或角色)的聲音合成一段話,回傳 WAV;語音合成沒有啟用、或這個角色沒有參考錄音(角色資料夾的 voice.wav)時回傳 null,
   * 呼叫端改用系統語音。target 是節點 id,或 { character } 用來試聽。
   */
  voiceTts(target: string | { character: string }, text: string): Promise<ArrayBuffer | null>;
  /** 手動卸載本機語音合成(釋放顯示卡記憶體)或重新載入;語音辨識不受影響。卸載後播報改用下一個聲音來源。服務重新啟動時會再載入。 */
  voiceTtsPower(load: boolean): Promise<VoiceStatus>;
  /** 角色的聲音設定(角色資料夾的 voice.wav、voice.txt、style.txt);只有桌面畫面能用,瀏覽器版回傳 null。 */
  voiceProfile(character: string): Promise<VoiceProfile | null>;
  /** 儲存角色的聲音:wav 是新的參考錄音(16-bit WAV,2 到 30 秒;null 表示移除),promptText、style 空字串表示刪除。 */
  voiceProfileSave(character: string, patch: { wav?: ArrayBuffer | null; promptText?: string; style?: string }): Promise<VoiceProfile>;
  /** 從這台電腦選一個 WAV 檔當參考錄音(開檔案對話框);取消時回傳 null。 */
  voiceProfileImport(character: string): Promise<VoiceProfile | null>;
  /** 參考錄音的內容(播放原音用);沒有時回傳 null。 */
  voiceProfileAudio(character: string): Promise<ArrayBuffer | null>;
  /** 各角色有沒有參考錄音,給設定面板顯示。 */
  voiceCharacters(): Promise<Array<{ character: string; hasVoice: boolean; style: string }>>;
  /** wav 是 16 kHz、16-bit、單聲道的 WAV 檔內容。 */
  voiceTranscribe(wav: ArrayBuffer): Promise<VoiceTranscript>;
  onVoice(cb: (s: VoiceStatus) => void): () => void;
  /** 語音播報的通知;只有桌面畫面收得到。 */
  onSpeech(cb: (n: SpeechNotice) => void): () => void;
  getSnapshot(): Promise<Snapshot>;
  /** 一個節點的完整事件紀錄,用來重建對話。 */
  getHistory(id: string): Promise<NexusEvent[]>;
  createAgent(input: CreateAgentInput): Promise<AgentInfo>;
  removeAgent(id: string): Promise<void>;
  /**
   * images 是附件路徑(名稱沿用舊稱,不限圖片)。類型由副檔名判斷(attachmentKind),
   * 後台能內嵌的類型直接交給模型看,其他的由轉接器把路徑寫進指令並以 note 事件說明。
   */
  send(id: string, text: string, images?: string[]): Promise<void>;
  /** 修改節點的名稱、角色、模型或權限模式。換模型或權限模式會重新啟動 session(對話內容保留)。 */
  updateAgent(id: string, patch: { name?: string; character?: string; model?: string; permissionMode?: PermissionMode }): Promise<AgentInfo>;
  pickFiles(): Promise<string[]>;
  /** 把剪貼簿貼上的圖片存成暫存檔(只收圖片、有大小上限),回傳檔案路徑。 */
  savePastedImage(mime: string, data: ArrayBuffer): Promise<string>;
  /** 附件的縮圖(data URL);只限這次由使用者選取、貼上或拖放過的圖片,其他路徑回傳 null。 */
  attachmentPreview(path: string): Promise<string | null>;
  /** 拖放進來的檔案在磁碟上的路徑。 */
  pathForFile(file: File): string;
  /** 只有瀏覽器版提供:檔案在另一台電腦上沒有路徑可用,改成上傳到主控台,回傳存好的路徑。 */
  uploadFile?(file: File): Promise<string>;
  /** 回覆裡的文字是不是這台電腦上實際存在的檔案或資料夾(相對路徑以節點的工作目錄、其上層與家目錄為基準)。 */
  canReveal(agentId: string, text: string): Promise<boolean>;
  /** 在檔案總管中顯示:資料夾直接打開,檔案則打開所在資料夾並選取;不會執行或開啟檔案。 */
  revealPath(agentId: string, text: string): Promise<void>;
  openTerminal(id: string, cols: number, rows: number): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  termAttach(id: string): Promise<string>;
  termWrite(id: string, data: string): Promise<void>;
  termResize(id: string, cols: number, rows: number): Promise<void>;
  respondApproval(id: string, requestId: string, decision: ApprovalDecision): Promise<void>;
  interrupt(id: string): Promise<void>;
  /** 把指令排到節點佇列的尾端,節點待命且有執行名額時依序自動送出。 */
  enqueue(id: string, text: string, images?: string[]): Promise<void>;
  cancelQueued(id: string, queuedId: string): Promise<void>;
  editQueued(id: string, queuedId: string, text: string): Promise<void>;
  /** 解除佇列暫停,節點待命時繼續送出。 */
  resumeQueue(id: string): Promise<void>;
  /** 回答 agent 的提問;answers 的鍵是題目 id。傳 null 表示略過不回答。 */
  answerQuestion(id: string, requestId: string, answers: Record<string, string[]> | null): Promise<void>;
  sleep(id: string): Promise<void>;
  wake(id: string): Promise<void>;
  setAutopilot(on: boolean): Promise<void>;
  setMaxActive(n: number): Promise<void>;
  openPortraitsFolder(): Promise<void>;
  /** 角色的 Q 版頭像(data URL;立繪資料夾\<角色>\avatar.png 或 chibi_avatar.png),沒有就是 null。 */
  getAvatar(character: string): Promise<string | null>;
  /** 讀取角色卡(立繪資料夾\<角色>\persona.md);超過 max 字的部分會截掉,truncated 為 true。 */
  getPersona(character: string): Promise<{ text: string; truncated: boolean; max: number }>;
  /** Antigravity 的工具白名單(所有 Antigravity 節點共用,agy 的 permissions.allow 規則);只有完整權限。 */
  getAgyAllow(): Promise<string[]>;
  /** 儲存白名單(一行一條或字串陣列);格式不對的規則會丟出說明。節點要重新啟動才會套用。回傳整理後的清單。 */
  setAgyAllow(rules: string[] | string): Promise<string[]>;
  /** 儲存角色卡;使用這個角色的節點會在下一則指令前收到新的角色設定。 */
  setPersona(character: string, text: string): Promise<void>;
  clearFinishedTasks(): Promise<void>;
  /** 使用者驗收或退回一個已結束的任務(再按一次同樣的結果即取消);null 表示清除判斷。 */
  setTaskVerdict(taskId: string, verdict: TaskVerdict): Promise<void>;
  /** 「記下這個解法」:請承辦節點把這個已結束的任務寫成判例(狀態先是未確認)。回傳給使用者看的說明。 */
  markCase(taskId: string): Promise<string>;
  /** 對話草稿按鈕要用的資訊:上次儲存到哪一筆事件(seq)、累積多少字才顯示按鈕。 */
  draftInfo(id: string): Promise<{ lastSeq: number; threshold: number }>;
  /** 「儲存這段記憶」:請這個節點把上次儲存之後的對話整理成草稿(狀態未確認),回傳給使用者看的說明。 */
  requestDraft(id: string): Promise<string>;
  /** 記憶庫資料夾的位置與目前的索引(階段 1 只讀,記憶管理在獨立的 app)。 */
  getMemoryVault(): Promise<{ dir: string; entries: MemoryEntry[] }>;
  /** 刪除節點並先歸檔進記憶庫:summary 先請節點(不行就請總管)寫工作總結,stats 只存統計。歸檔失敗不擋刪除,note 說明結果。 */
  removeAgentArchived(id: string, mode: 'summary' | 'stats'): Promise<{ archive: string | null; note: string }>;
  /** 找這些名稱(依序:節點名稱、角色)的最新封存;沒有就是 null。 */
  findMemoryArchive(names: string[]): Promise<{ path: string; date: string; name: string } | null>;
  /** 把封存的特長與解決問題的流程接回這個節點的側寫;封存裡沒有這兩段時回傳 null。 */
  attachMemoryArchive(agentId: string, archivePath: string): Promise<string | null>;
  /** 取得一個任務期間的檔案變更;任務還在執行時回傳到目前為止的變更。 */
  getTaskChanges(taskId: string): Promise<ChangeSet>;
  listOldSessions(): Promise<OldSession[]>;
  inspectDir(cwd: string): Promise<DirInfo>;
  /** 還原任務的修改;paths 為 null 表示整個任務。 */
  revertTask(taskId: string, paths: string[] | null): Promise<RevertResult>;
  commitTask(taskId: string, message: string): Promise<string>;
  /** 把變更檢視的評論整理成一則指令,送回產生這個任務的節點修改。 */
  sendReviewComments(taskId: string, comments: ReviewComment[]): Promise<void>;
  /** 把任務的變更送交另一個節點審查;審查者只回覆意見,不修改檔案。 */
  requestReview(taskId: string, reviewerId: string, note?: string): Promise<void>;
  worktreeStatus(id: string): Promise<WorktreeStatus | null>;
  mergeWorktree(id: string): Promise<string>;
  openPullRequest(id: string): Promise<string>;
  setQuotaStop(percent: number): Promise<void>;
  /** 設定某家後台的每日預算(佔每週額度的百分比,0 到 100;0 表示不提醒);null 表示改回預設值(每週額度的 1/7)。超過只提醒,不擋指令。 */
  setDailyBudget(backend: Backend, percent: number | null): Promise<void>;
  remoteStatus(): Promise<RemoteStatus>;
  remoteSet(patch: { enabled?: boolean; lan?: boolean }): Promise<void>;
  remoteNewCode(): Promise<void>;
  remoteRevoke(deviceId: string): Promise<void>;
  /** 設定下一組配對碼的權限,並換一組新的配對碼。 */
  remotePairAccess(access: RemoteAccess): Promise<void>;
  /** 修改已配對裝置的權限;立即生效。 */
  remoteSetDevice(deviceId: string, access: RemoteAccess): Promise<void>;
  /** 最近的操作紀錄,新的在前。 */
  remoteAudit(): Promise<AuditEntry[]>;
  /** 只有瀏覽器版提供:這支裝置的權限。 */
  access?: RemoteAccess;
  observeStatus(): Promise<ObserveStatus>;
  /** 把 hooks 加進 Claude Code 的使用者設定檔(只在使用者按下按鈕時呼叫)。 */
  observeInstall(): Promise<ObserveStatus>;
  observeUninstall(): Promise<ObserveStatus>;
  /** 換一組新的權杖;之後要重新安裝 hooks。 */
  observeNewToken(): Promise<ObserveStatus>;
  /** 把外部觀察節點接進主控台成為正式節點(走「開啟舊 session」的流程)。 */
  observeTakeover(sessionId: string, name: string): Promise<AgentInfo>;
  /** 建立(或復原)節點並接回這個 session;名稱會跟著 session 保存。 */
  openOldSession(input: OpenOldSessionInput): Promise<AgentInfo>;
  /** 從節點或舊 session 分支出新節點;新節點有自己的 session,來源不受影響。 */
  forkAgent(input: ForkAgentInput): Promise<AgentInfo>;
  pickDirectory(): Promise<string | null>;
  onUpdate(cb: (u: Update) => void): () => void;
}
