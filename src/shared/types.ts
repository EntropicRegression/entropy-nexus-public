// 主行程、preload 與畫面共用的型別。畫面只認這裡定義的狀態與事件。

export type Backend = 'claude' | 'codex' | 'antigravity';

/** 統一的七種狀態;三家 CLI 的事件都由轉接器翻譯成這一組。 */
export type AgentState = 'idle' | 'planning' | 'working' | 'awaiting' | 'error' | 'lost' | 'sleeping';

/** 主面板的五個區塊。 */
export type Zone = 'standby' | 'planning' | 'active' | 'auth' | 'fault';

export const STATE_ZONE: Record<AgentState, Zone> = {
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
export interface QueuedPrompt { id: string; text: string; images: string[]; createdAt: number }

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
}

/** 轉接器送給核心服務的事件。 */
export type AdapterEvent =
  | { type: 'state'; state: AgentState; detail?: string }
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
}

export interface CreateAgentInput {
  /** 在獨立的 git worktree 與分支上工作。 */
  isolate?: boolean;
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

/** preload 暴露給畫面的介面。 */
export interface NexusApi {
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
  /** 修改節點的名稱、角色或模型。換模型會重新啟動 session(對話內容保留)。 */
  updateAgent(id: string, patch: { name?: string; character?: string; model?: string }): Promise<AgentInfo>;
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
  /** 儲存角色卡;使用這個角色的節點會在下一則指令前收到新的角色設定。 */
  setPersona(character: string, text: string): Promise<void>;
  clearFinishedTasks(): Promise<void>;
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
