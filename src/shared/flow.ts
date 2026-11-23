/**
 * 可重用協作流程(發展規劃 2-2)的型別契約,主行程與畫面共用。
 * 規格見 docs/協作流程規劃.md,實作計畫見 docs/協作流程實作計畫.md。
 * 這個檔案不 import 任何 node 模組,也不用 enum(單元測試用 Node 直接載入 .ts)。
 *
 * 命名慣例:YAML 與 step_report 工具參數用 snake_case(英文,工具參數名稱只能用英數字);
 * 解析後的 TypeScript 物件一律用 camelCase。
 */

// ---- 基本列舉 ----

/** 步驟的性質:write 會改工作區;review 在隔離副本上審查。 */
export const STEP_MODES = ['write', 'review'] as const;
export type StepMode = (typeof STEP_MODES)[number];

/**
 * 高風險動作:節點不能自己做,一律要使用者在授權卡上確認後由主控台執行,流程定義不能設成免授權。
 * - install(安裝或覆蓋):執行 *Setup*.exe、.msi,寫入 Program Files 或 %LOCALAPPDATA%\Programs。
 * - real_vault(碰真實記憶庫):寫入設定中的記憶庫路徑,或真實的 userData(%APPDATA%\entropy-nexus)。
 */
export const HIGH_RISK_ACTIONS = ['commit', 'push', 'real_vault', 'install'] as const;
export type HighRiskAction = (typeof HIGH_RISK_ACTIONS)[number];

/** 永遠禁止、連授權卡也不能開放的動作(使用者裁示 2026-11-22 第 7 點):合併 PR、核准 PR、force push、刪分支。 */
export const NEVER_ALLOWED_ACTIONS = ['merge_pr', 'approve_pr', 'force_push', 'delete_branch'] as const;
export type NeverAllowedAction = (typeof NEVER_ALLOWED_ACTIONS)[number];

/** 節點不可自行做的動作:高風險動作、dist(打包安裝檔)、永遠禁止的動作。 */
export const FORBIDDEN_ACTIONS = [...HIGH_RISK_ACTIONS, 'dist', ...NEVER_ALLOWED_ACTIONS] as const;
export type ForbiddenAction = (typeof FORBIDDEN_ACTIONS)[number];

/** 每個流程一定禁止的動作(寫死),定義檔沒寫也會強制併入。 */
export const ALWAYS_FORBIDDEN: readonly ForbiddenAction[] = ['commit', 'push', 'dist', ...NEVER_ALLOWED_ACTIONS];

/** 步驟指向「停機」的保留字(on_reject、next 可用)。 */
export const HALT = 'halt';
/** 步驟指向「流程通過、進入收尾」的保留字(next 可用)。最後一步省略 next 也等於 done。 */
export const DONE = 'done';

/** 核實指令逾時的上限(秒)。 */
export const VERIFY_TIMEOUT_MAX = 3600;

// ---- 流程定義(YAML 解析後) ----

export interface VerifyCommandDef {
  id: string;
  /** 交給 shell 執行的指令文字。 */
  run: string;
  /** 逾時秒數,必填,上限 VERIFY_TIMEOUT_MAX。 */
  timeout: number;
  /** 前置指令的 id;只支援一層(被依賴的指令本身不能再有 needs)。 */
  needs: string[];
  /** 需要桌面(會開視窗)。只有專案勾了「允許桌面核實」才跑,而且在獨立 worktree 裡跑。 */
  desktop: boolean;
}

export interface FlowRoleDef {
  mode: StepMode;
  description: string;
}

export interface FlowLimits {
  /** 退回實作者的上限輪數;超過就停機。 */
  maxRejections: number;
  /** 整個流程的時間上限(分鐘,只計執行中的時間)。 */
  maxMinutes: number;
  /** 單一步驟的時間上限(分鐘)。 */
  stepMinutes: number;
  /** 回合結束仍沒回報時,隔多久提醒(分鐘)。 */
  reminderMinutes: number;
  /** 整個流程最多交辦幾次(含重跑、改派)。 */
  maxDispatches: number;
}

export interface FlowScope {
  /** gitignore 風格的樣式;空陣列表示不限制。改到範圍外只標示、不擋。 */
  allowedPaths: string[];
  /** 一定包含 ALWAYS_FORBIDDEN。 */
  forbiddenActions: ForbiddenAction[];
}

export interface FlowStepDef {
  id: string;
  label: string;
  role: string;
  mode: StepMode;
  /** 這一步完成後主控台要不要重跑核實指令。 */
  verify: boolean;
  /** 被退回(必修或核實失敗)時要去的步驟 id,或 HALT;省略表示停機。 */
  onReject?: string;
  /** 通過後要去的步驟 id、DONE 或 HALT;省略表示定義順序的下一步(最後一步則等於 DONE)。 */
  next?: string;
  /** 修正步驟優先送回原本的實作 session。 */
  continueSession: boolean;
  /** 這一步需要使用者授權才能做的高風險動作(經授權卡同意後由主控台執行)。 */
  requiresApproval: HighRiskAction[];
  /** 說明用:這一步讀哪些前一步的產出(例如 implement.report)。 */
  inputs: string[];
  /** 說明用:這一步產出什麼。 */
  outputs: string[];
}

export interface FlowFinish {
  /** 流程通過後提供給使用者的授權卡(例如 commit)。 */
  offer: HighRiskAction[];
}

export type FlowSource = 'builtin' | 'user';

/** 核實指令在哪裡跑:copy(從版本匯出的副本,沒有 .git,預設)或 worktree(獨立 detached worktree,需要 git 的專案用)。 */
export type VerifyLocation = 'copy' | 'worktree';

export interface FlowDefinition {
  id: string;
  name: string;
  version: number;
  description: string;
  roles: Record<string, FlowRoleDef>;
  limits: FlowLimits;
  scope: FlowScope;
  /** in 由專案設定的 verify_in 決定,預設 copy。 */
  verify: { commands: VerifyCommandDef[]; in: VerifyLocation };
  steps: FlowStepDef[];
  finish: FlowFinish;
  source: FlowSource;
  /** 使用者自訂範本的檔案路徑;內建範本是範本檔名。 */
  file?: string;
}

/** 解析或驗證的結果:有 errors 時 flow 為 null;warnings(例如不認得的欄位)不影響使用。 */
export interface FlowParseResult {
  flow: FlowDefinition | null;
  errors: string[];
  warnings: string[];
}

/** 範本清單(給「套用流程」對話框用)。 */
export interface FlowTemplateInfo {
  id: string;
  name: string;
  description: string;
  source: FlowSource;
  file?: string;
  /** 解析失敗的使用者範本也列出來,讓使用者知道哪裡寫錯。 */
  errors: string[];
  warnings: string[];
}

// ---- 專案設定(<資料夾>/flows/projects.yaml) ----

export interface ProjectFlowConfig {
  /** 專案 id(正規化後的專案根目錄路徑,見 main/project.ts)。 */
  projectId: string;
  /** 角色 → 節點名稱或 id。 */
  roles: Record<string, string>;
  /** 核實指令的覆寫:replace 整組取代,append 接在範本後面。 */
  verify?: { mode: 'replace' | 'append'; commands: VerifyCommandDef[] };
  /** 有值時取代範本的 allowed_paths。 */
  allowedPaths?: string[];
  /** 允許桌面核實(desktop: true 的指令),預設不勾。 */
  allowDesktopVerify: boolean;
  /** 核實指令在哪裡跑(YAML 的 verify_in);省略表示 copy。 */
  verifyIn?: VerifyLocation;
}

export interface ProjectsFileResult {
  /** 解析成功的專案。 */
  projects: Record<string, ProjectFlowConfig>;
  /** 寫錯的專案:錯誤訊息與原始內容(寫回 projects.yaml 時原樣保留,不洗掉使用者的設定)。 */
  invalid: Record<string, { errors: string[]; raw: unknown }>;
  errors: string[];
  warnings: string[];
}

// ---- step_report ----

export type ReportVerdict = 'mergeable' | 'changes_required';

export interface ReportCommand {
  command: string;
  result: string;
}

export interface ScopeException {
  /** repo 相對路徑(斜線統一成 /)。 */
  path: string;
  reason: string;
}

/** 正規化後的 step_report(工具參數是 snake_case,見 M2 的 flow/report.ts)。 */
export interface StepReport {
  assignmentId: string;
  summary: string;
  /** 只有 review 步驟有;有必修就不能是 mergeable。 */
  verdict?: ReportVerdict;
  /** 必修:退回實作者。 */
  mustFix: string[];
  /** 建議:實作者自行判斷。 */
  suggestions: string[];
  /** 需裁示:直接交給使用者,不計入退回輪數。 */
  needsRuling: string[];
  commandsRun: ReportCommand[];
  notVerified: string[];
  questions: string[];
  scopeExceptions: ScopeException[];
  /** 收到的時間(毫秒)。 */
  receivedAt: number;
  /** 使用者手動補報的。 */
  manual?: boolean;
}

// ---- 核實 ----

/** 單條指令的結果。skipped:前置指令沒通過,或桌面核實沒被允許。 */
export type VerifyCommandOutcome = 'pass' | 'fail' | 'blocked' | 'timeout' | 'skipped';
/** 整組核實的結果:規格的四類,加上 modified(核實指令改到受版本控制的檔案:交給使用者,不算實作者失敗)。 */
export type VerifyOutcome = 'pass' | 'fail' | 'blocked' | 'timeout' | 'modified';

/** 鎖住檔案的程序(盡力而為,只有 Windows 找得到)。 */
export interface LockerInfo {
  pid: number;
  name: string;
}

export interface VerifyCommandResult {
  id: string;
  run: string;
  outcome: VerifyCommandOutcome;
  /** 結束代碼;逾時、啟動失敗、略過時為 null。 */
  exitCode: number | null;
  ms: number;
  /** 最後一行非空白輸出(逾時時就是卡住的位置)。 */
  lastLine: string;
  /** 完整輸出的 log 檔(只保留最後 64KB);沒寫檔時為空字串。 */
  logFile: string;
  /** blocked、skipped 的原因(人看得懂的中文)。 */
  reason?: string;
  /** blocked 時找到的鎖定程序。 */
  lockers?: LockerInfo[];
  /** 失敗時「可能的環境原因」(輸出最後幾行有 EBUSY、EPERM 之類的字,但沒找到鎖定程序,所以仍判失敗)。 */
  envHint?: string;
  /** 在副本還是 worktree 裡跑的。 */
  location: VerifyLocation;
  /** 這條指令跑完後和版本 tree 不同的受版本控制檔案(核實指令不該改檔)。 */
  modified: string[];
}

export interface VerifyResult {
  /** 核實的版本(tree ID)。 */
  version: string;
  outcome: VerifyOutcome;
  commands: VerifyCommandResult[];
  /** 逾時或被擋住時卡在哪條指令的 id。 */
  stuckAt?: string;
  /** 失敗的指令 id(整組被判成 blocked、timeout、modified 時也要列出,畫面一併顯示)。 */
  failed: string[];
  /** 被環境擋住的指令 id。 */
  blocked: string[];
  /** 改到受版本控制檔案的指令 id(各自改了哪些檔看 commands[].modified)。 */
  modifiedBy: string[];
  /** 沒驗證到的事,例如「未跑桌面核實」。 */
  notVerified: string[];
  /** 所有指令合計被改動的檔案。 */
  modified: string[];
  startedAt: number;
  endedAt: number;
}

// ---- 執行狀態 ----

export type RunStatus = 'running' | 'paused' | 'awaiting_user' | 'halted' | 'stopping' | 'stopped' | 'completed';

/** 終止狀態:任何事件都只記稽核紀錄、不處理(不復活)。 */
export const TERMINAL_STATUSES: readonly RunStatus[] = ['halted', 'stopped', 'completed'];

/** running 底下的階段。 */
export type RunPhase =
  | 'dispatching' | 'working' | 'awaiting_report' | 'snapshotting' | 'verifying'
  | 'exporting_copy' | 'reviewing' | 'post_review' | 'finishing';

export type AssignmentStatus =
  | 'queued' | 'running' | 'awaiting_report' | 'reported' | 'unreported'
  | 'interrupted' | 'superseded' | 'failed' | 'stopped';

/** 修正步驟是延續原 session 還是開了新 session。 */
export type Continuation = 'continued' | 'new';

/** 步驟條的燈號。 */
export type StepLamp = 'idle' | 'active' | 'passed' | 'rejected' | 'blocked' | 'awaiting_approval' | 'awaiting_user' | 'halted';

export type PendingKind =
  | 'unreported'        // 節點沒交 step_report:手動補報或重跑
  | 'needs_ruling'      // 審查或實作提出需裁示
  | 'verify_blocked'    // 核實被環境擋住(檔案被鎖等)
  | 'verify_timeout'    // 核實逾時
  | 'verify_modified'   // 核實指令改到受版本控制的檔案
  | 'version_changed'   // 正本的 tree 不等於版本,審查/核實/授權已失效
  | 'need_agent'        // 找不到可以接手的節點,請使用者指定
  | 'agent_error'       // 節點出錯或交辦失敗
  | 'copy_written'      // 審查副本被寫入(已丟棄)
  | 'limit'             // 時間或交辦次數到上限
  | 'not_ended'         // 停止、重跑或改派前,節點一直沒停下來:再等、強制視為結束或停止流程
  | 'copy_missing';     // 審查副本不在了(例如主控台重開),無法確認有沒有被寫入:重新審查或照用審查結果

/** wait:再等節點停下來;force_ended:使用者確認節點已經不會再寫檔,強制視為結束。 */
export type DecisionChoice = 'manual_report' | 'rerun' | 'continue' | 'reassign' | 'halt' | 'stop' | 'wait' | 'force_ended';

export interface PendingDecision {
  id: string;
  kind: PendingKind;
  stepId: string;
  assignmentId?: string;
  /** 給使用者看的說明。 */
  message: string;
  options: DecisionChoice[];
  /** unreported 時遲到的回報可以預填在手動補報欄位。 */
  prefill?: StepReport;
  /** need_agent 時可選的節點(id 與名稱)。 */
  candidates?: { id: string; name: string }[];
  createdAt: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalCard {
  id: string;
  action: HighRiskAction;
  /** 授權涵蓋的版本(tree ID);版本一變就失效(expired)。 */
  version: string;
  /** 這次授權涵蓋什麼,例如「本地 commit」。 */
  covers: string[];
  /** 明確不涵蓋什麼,例如「push」。 */
  excludes: string[];
  /** 範圍內、預設納入的檔案。 */
  paths: string[];
  /** 範圍外的檔案,使用者勾選的才納入。 */
  outOfScope: string[];
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  /** 允許後執行的結果(例如 commit 的短雜湊)或失敗原因。 */
  result?: string;
}

export type ViolationKind = 'forbidden_action' | 'out_of_scope' | 'refs_changed' | 'copy_written' | 'verify_modified' | 'artifact_changed';

export interface ScopeViolation {
  kind: ViolationKind;
  stepId?: string;
  assignmentId?: string;
  detail: string;
  /** 相關檔案或命中的指令。 */
  items: string[];
  /** 是否被擋下(forbidden_action 的 L1)或只是標示。 */
  blocked: boolean;
  at: number;
}

// ---- 畫面用的檢視 ----

export interface FlowAttemptView {
  assignmentId: string;
  stepId: string;
  attempt: number;
  agentId: string;
  agentName: string;
  continuation: Continuation;
  status: AssignmentStatus;
  /** 這次嘗試交出的版本(tree ID);還沒收尾時為空字串。 */
  version: string;
  report?: StepReport;
  verify?: VerifyResult;
  /** 這次嘗試新增的被 .gitignore 略過的產出(和開始時的清單做差集)。 */
  ignored?: string[];
  /** runs/<id>/ 底下的檔案(json、md、log)。 */
  files: string[];
  startedAt: number;
  endedAt?: number;
}

export interface FlowStepView {
  id: string;
  label: string;
  mode: StepMode;
  role: string;
  lamp: StepLamp;
  attempts: FlowAttemptView[];
}

export interface FlowRunView {
  id: string;
  flowId: string;
  flowName: string;
  topic: string;
  projectId: string;
  cwd: string;
  status: RunStatus;
  phase?: RunPhase;
  /** 目前所在的步驟 id。 */
  stepId: string;
  rejections: number;
  maxRejections: number;
  /** 已交辦次數(含重跑、改派)與上限。 */
  dispatches: number;
  maxDispatches: number;
  /** 目前的版本(tree ID);還沒拍過快照時為空字串。 */
  version: string;
  /** 角色 → 節點(id 與名稱)。 */
  roles: Record<string, { agentId: string; name: string }>;
  steps: FlowStepView[];
  pending?: PendingDecision;
  approvals: ApprovalCard[];
  violations: ScopeViolation[];
  /** 停機或停止的原因。 */
  reason?: string;
  /** 只計執行中的時間(毫秒)。 */
  activeMs: number;
  startedAt: number;
  updatedAt: number;
  /** runs/<id>/ 的完整路徑。 */
  runDir: string;
}

export interface FlowStartInput {
  templateId: string;
  topic: string;
  /** 工作目錄(專案由它決定)。 */
  cwd: string;
  /** 角色 → 節點 id;省略的角色依專案設定對照。 */
  roles?: Record<string, string>;
}
