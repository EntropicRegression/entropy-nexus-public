import {
  DONE, HALT, TERMINAL_STATUSES,
  type ApprovalCard, type AssignmentStatus, type HighRiskAction, type ScopeException, type Continuation, type DecisionChoice, type FlowAttemptView, type FlowDefinition, type FlowRunView,
  type FlowStepDef, type FlowStepView, type PendingDecision, type PendingKind, type RunPhase, type RunStatus, type ScopeViolation, type StepLamp,
  type StepReport, type VerifyResult,
} from '../../shared/flow.ts';
import type { RefsState } from './version.ts';

/**
 * 協作流程的狀態機(docs/協作流程實作計畫.md §3):純函式,不碰 IO、不讀時鐘(時間由呼叫端傳入)。
 * reduce(run, event, now) 回傳新的 run 與要執行的 effects;FlowService 負責執行 effect(交辦、快照、核實、匯出副本…),
 * 把結果再當成事件送回來。
 *
 * 設計:事件只記「事實」(回報到了、回合結束了、快照拍好了),要不要往下走一律由 drive() 依目前的階段與事實決定,
 * 而且只在 running 時才會發出新的工作。所以暫停時進來的結果只會被記下,繼續時由 drive() 接著做;主控台重開後也一樣。
 * 每個非同步的 effect 帶一個 token(run.inflight),結果回來時 token 不符(已停止、已改派、已重開)就只記稽核紀錄。
 *
 * 規則重點:
 * - 回合結束才收尾(收到回報先存起來,節點可能還在寫檔)。
 * - 回合結束時還沒回報:隔 reminder_minutes 提醒一次;提醒後的回合仍沒回報 → 未回報,交給使用者(手動補報或重跑),不計輪數。
 * - 輪數只計審查的必修與核實失敗;需裁示、被環境擋住、逾時、核實改到檔案、未回報、節點出錯都交給使用者、不計輪數。
 *   退回超過 max_rejections 就停機。
 * - 任何檢查點發現正本的 tree 不等於版本:審查、核實、授權全部失效,交給使用者。
 * - 停止、改派、重跑前先確認原交辦已經結束(ensure_ended effect)。
 * - 交辦已經不是進行中時收到的回報寫進 late/,不推進流程;流程卡在未回報時只預填在手動補報欄位。
 * - 終止狀態(stopped、completed、halted)不復活:之後的事件只記稽核紀錄(completed 的授權卡結果例外)。
 * - 每一步前後比對 refs(HEAD、分支、遠端追蹤分支、標籤),發現 commit 或 push 就標違規並停機(使用者裁示第 1 點)。
 *   打包產出(dist/、release/)新增或改動、受保護的資料夾(flows/、主控台設定資料夾)被寫入,同樣標違規並停機(M3)。
 * - 步驟列了 requires_approval:交辦前先拍正本、開授權卡(綁定版本),都允許了才交辦,拒絕就停機;
 *   允許的動作只開放給這一步的交辦(L1、L2 攔截與 refs 比對扣掉它)。收尾的授權卡第一版只支援 commit。
 * - 時間上限只計執行中(running)的時間,扣掉暫停與等待使用者(使用者裁示第 5 點)。
 */

// ---- 資料 ----

/** 節點的精簡資訊(選擇交辦對象用)。 */
export interface AgentLite {
  id: string;
  name: string;
  sessionId: string | null;
  state: string;
}

/** 下一個交辦要附上的前情(從哪個交辦讀回報、必修、核實結果)。 */
export interface AssignmentContext {
  /** 前一個寫入步驟的交辦(讀它的 step_report)。 */
  reportFrom?: string;
  /** 退回原因來自審查:讀這個審查交辦的必修。 */
  mustFixFrom?: string;
  /** 退回原因來自核實:讀這個交辦的核實結果。 */
  verifyFrom?: string;
  /** 新 session 時附上相對交審版本的 diff:base → end。 */
  diff?: { base: string; end: string };
  /** 使用者的裁示(需裁示選「繼續」時填的話)。 */
  rulings?: string[];
}

/** 快照的結果(寫入步驟:正本的新版本;審查步驟:正本有沒有變、副本有沒有被寫入)。 */
export interface SnapResult {
  /** 正本目前的 tree;拍不到時為 null。 */
  version: string | null;
  refsChanged: string[];
  /** 這次新增的被 .gitignore 略過的產出。 */
  ignored: string[];
  /** 相對交辦開始時版本改了哪些檔(寫入步驟)。 */
  changed: string[];
  /** 範圍外的檔案,以及其中沒在 scope_exceptions 寫原因的。 */
  outOfScope: string[];
  unexplained: string[];
  /** 審查副本被寫入的檔案(已丟棄)。 */
  copyWritten: string[];
  /** 這一步新增或改動的被忽略打包產出(dist/、release/,L4)。 */
  artifacts?: string[];
  /** 這一步寫到的受保護資料夾(流程定義 flows/、主控台設定資料夾、沒授權的記憶庫)。 */
  protectedWrites?: string[];
  /** 審查副本不在或無法比對(例如主控台重開時已清掉):不能當成副本被寫入。 */
  copyError?: string;
  error?: string;
}

export interface RunAssignment {
  id: string;
  stepId: string;
  attempt: number;
  agentId: string;
  agentName: string;
  sessionAtDispatch: string | null;
  sessionAtEnd: string | null;
  continuation: Continuation;
  status: AssignmentStatus;
  taskIds: string[];
  queuedId?: string;
  reminded: boolean;
  /** 目前這個回合(含提醒的回合)結束了沒。 */
  turnEnded: boolean;
  turnOutcome?: 'done' | 'interrupted' | 'failed';
  turnEndedAt?: number;
  report?: StepReport;
  /** 交辦開始時正本的版本(寫入步驟用來算改了哪些檔)。 */
  baseVersion: string;
  /** 這一步交出的版本(寫入步驟收尾後);還沒收尾時為空字串。 */
  version: string;
  /** 審查步驟:審查的版本與副本資料夾。 */
  reviewedVersion?: string;
  copyDir?: string;
  refsBefore?: RefsState;
  /** 交辦時記下的資料夾指紋(flows/ 與打包產出資料夾,見 guard.ts 的 guardFingerprint)。 */
  guardBefore?: Record<string, string>;
  /** 這個交辦經授權卡允許、可以自己做的高風險動作(步驟的 requires_approval)。 */
  approved?: HighRiskAction[];
  /** 授權卡綁定的版本(交辦前再確認一次正本仍是這個版本)。 */
  approvedVersion?: string;
  snap?: SnapResult;
  verify?: VerifyResult;
  /** 核實結束時正本的 tree(用來判斷核實期間版本有沒有變)。 */
  verifyCanonical?: string | null;
  verifyError?: string;
  /** 使用者已處理過需裁示(選了繼續)。 */
  rulingDone?: boolean;
  /** 使用者接受核實改到檔案的結果(選了繼續)。 */
  verifyAccepted?: boolean;
  /** 使用者接受審查副本無法比對的審查結果(選了繼續)。 */
  copyAccepted?: boolean;
  /** 收尾後的結果:通過、退回、交給使用者。 */
  result?: 'passed' | 'rejected' | 'user';
  context: AssignmentContext;
  files: string[];
  startedAt: number;
  endedAt?: number;
}

export interface FlowRun {
  id: string;
  /** 啟動當時解析好的流程定義(執行中改 YAML 不影響)。 */
  flow: FlowDefinition;
  topic: string;
  projectId: string;
  projectName: string;
  cwd: string;
  repoRoot: string;
  /** 角色 → 節點。 */
  roles: Record<string, { agentId: string; name: string }>;
  /** 專案設定的角色對照(節點名稱或 id),原節點不在時用來找接手的節點。 */
  roleHints: Record<string, string>;
  allowDesktop: boolean;
  status: RunStatus;
  phase?: RunPhase;
  stepId: string;
  /** 進行中的非同步 effect;結果回來時 token 要相符。 */
  inflight: { kind: string; token: number } | null;
  seq: number;
  /** 目前的交辦。 */
  current?: string;
  rejections: number;
  dispatches: number;
  /** 啟動時的版本。 */
  baseVersion: string;
  /** 最新的寫入步驟交出的版本。 */
  version: string;
  verifiedVersion?: string;
  reviewedVersion?: string;
  /** 啟動時被 .gitignore 略過的清單(之後和它做差集)。 */
  ignoredBase: string[];
  assignments: RunAssignment[];
  /** 下一個交辦要附上的前情(退回時設定,建立交辦時取走)。 */
  carry: AssignmentContext;
  /** 改派:下一個交辦一律交給這個節點。 */
  forceAgent?: { stepId: string; agentId: string };
  /** 準備好的審查副本(匯出後、交辦前)。 */
  copy?: { dir: string; version: string };
  /** 收尾的結果(授權卡的資料)。 */
  finish?: FinishResult;
  /** 交辦前的授權(步驟的 requires_approval):哪一步、卡片綁定的版本、是否都允許了。 */
  gate?: { stepId: string; version?: string; ready: boolean };
  pending?: PendingDecision;
  approvals: ApprovalCard[];
  violations: ScopeViolation[];
  reason?: string;
  /** stopping 結束後要變成的狀態。 */
  stopTarget?: 'stopped' | 'halted';
  /**
   * 正在確認哪些交辦已經結束,以及確認完要做什麼(stop:完成停止;rerun:重跑或改派;limit:單步超時後中斷)。
   * 確認結束之前:不完成停止(工作樹鎖不釋放)、不重新交辦,這些交辦的回報一律當遲到。token 為 0 表示確認逾時、等使用者決定。
   */
  ensuring?: { token: number; purpose: 'stop' | 'rerun' | 'limit'; assignmentIds: string[] };
  /** 核實用的 worktree(verify_in: worktree 與桌面核實):主控台重開後用來清掉殘留(由 FlowService 記錄)。 */
  worktrees?: { path: string; commit: string }[];
  /** 上一次通知總管的待決事項(同一個待決事項重提時不重複通知)。 */
  lastNotice?: string;
  /** 只計 running 的時間;activeSince 是這段 running 開始的時間(不在 running 時為 null)。 */
  activeMs: number;
  activeSince: number | null;
  /** 目前這一步的執行時間(交辦時歸零)。 */
  stepActiveMs: number;
  startedAt: number;
  updatedAt: number;
  audit: { at: number; text: string }[];
}

export interface FinishResult {
  canonical: string | null;
  paths: string[];
  outOfScope: string[];
  /** 範圍外檔案的說明(各寫入步驟回報的 scope_exceptions)與沒寫原因的檔案。 */
  scopeNotes?: ScopeException[];
  unexplained?: string[];
  /** 沒有檔案可提交時的說明(例如修改已經由節點經授權 commit 進 HEAD)。 */
  note?: string;
  error?: string;
}

export interface CreateRunInput {
  id: string;
  flow: FlowDefinition;
  topic: string;
  projectId: string;
  projectName: string;
  cwd: string;
  repoRoot: string;
  roles: Record<string, { agentId: string; name: string }>;
  roleHints?: Record<string, string>;
  allowDesktop?: boolean;
  baseVersion: string;
  ignoredBase?: string[];
}

// ---- 事件與 effect ----

export type TurnOutcome = 'done' | 'interrupted' | 'failed';

export type FlowEvent =
  | { type: 'start' }
  | { type: 'agents'; token: number; agents: AgentLite[] }
  | { type: 'dispatched'; assignmentId: string; queuedId?: string; refsBefore?: RefsState; guardBefore?: Record<string, string>; error?: string }
  | { type: 'task_started'; assignmentId: string; taskId: string }
  | { type: 'turn_ended'; assignmentId: string; taskId: string; outcome: TurnOutcome; sessionId: string | null }
  | { type: 'report'; assignmentId: string; report: StepReport }
  | { type: 'snapshot_done'; token: number; snap: SnapResult }
  | { type: 'verify_done'; token: number; result?: VerifyResult; canonical: string | null; error?: string }
  | { type: 'copy_ready'; token: number; dir?: string; canonical: string | null; error?: string }
  | { type: 'finish_done'; token: number; canonical: string | null; paths: string[]; outOfScope: string[]; scopeNotes?: ScopeException[]; unexplained?: string[]; note?: string; error?: string }
  | { type: 'gate_stale'; assignmentId: string; canonical: string | null }
  | { type: 'gate_ready'; token: number; canonical: string | null; error?: string }
  | { type: 'ended'; token: number; ok?: boolean; stuck?: string[] }
  | { type: 'note'; text: string }
  | { type: 'tick' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop'; reason?: string }
  | { type: 'decide'; decisionId: string; choice: DecisionChoice; agentId?: string; agentName?: string; note?: string; report?: StepReport }
  | { type: 'approval_card'; cardId: string; status: 'approved' | 'denied' | 'expired'; result?: string; included?: string[] }
  | { type: 'violation'; violation: ScopeViolation; halt: boolean };

export type FlowEffect =
  | { type: 'pick_agent'; token: number; stepId: string }
  | { type: 'dispatch'; assignmentId: string; agentId: string; wake: boolean }
  | { type: 'remind'; assignmentId: string; agentId: string }
  | { type: 'snapshot'; token: number; assignmentId: string }
  | { type: 'verify'; token: number; assignmentId: string; version: string }
  | { type: 'export_copy'; token: number; version: string }
  | { type: 'finish'; token: number }
  | { type: 'gate'; token: number; stepId: string }
  | { type: 'ensure_ended'; token: number; assignmentIds: string[] }
  | { type: 'write_report'; assignmentId: string }
  | { type: 'write_late'; assignmentId: string; report: StepReport; reason: string }
  | { type: 'report_ignored'; assignmentId: string; reason: string }
  | { type: 'cleanup' }
  | { type: 'notify'; kind: 'halted' | 'needs_user' | 'completed' | 'stopped'; message: string };

export interface ReduceResult { run: FlowRun; effects: FlowEffect[] }

/** 交辦還沒結束(要先確認結束才能停止或改派)。 */
const ACTIVE: readonly AssignmentStatus[] = ['queued', 'running', 'awaiting_report'];
export const isActive = (a: RunAssignment) => ACTIVE.includes(a.status);
const isTerminal = (s: RunStatus) => TERMINAL_STATUSES.includes(s);

const MIN = 60000;

// ---- 建立與輔助 ----

export function createRun(i: CreateRunInput, now: number): FlowRun {
  return {
    id: i.id, flow: i.flow, topic: i.topic, projectId: i.projectId, projectName: i.projectName, cwd: i.cwd, repoRoot: i.repoRoot,
    roles: { ...i.roles }, roleHints: { ...(i.roleHints ?? {}) }, allowDesktop: i.allowDesktop ?? false,
    status: 'running', phase: 'dispatching', stepId: i.flow.steps[0]?.id ?? '', inflight: null, seq: 0,
    rejections: 0, dispatches: 0, baseVersion: i.baseVersion, version: i.baseVersion, ignoredBase: [...(i.ignoredBase ?? [])],
    assignments: [], carry: {}, approvals: [], violations: [], activeMs: 0, activeSince: now, stepActiveMs: 0,
    startedAt: now, updatedAt: now, audit: [{ at: now, text: `流程啟動:${i.flow.name}` }],
  };
}

export const stepOf = (run: FlowRun, id: string): FlowStepDef | undefined => run.flow.steps.find(s => s.id === id);
export const currentAssignment = (run: FlowRun): RunAssignment | undefined => run.assignments.find(a => a.id === run.current);
const lastOf = (run: FlowRun, pred: (a: RunAssignment) => boolean): RunAssignment | undefined => [...run.assignments].reverse().find(pred);
const modeOf = (run: FlowRun, stepId: string) => stepOf(run, stepId)?.mode ?? 'write';

function audit(run: FlowRun, now: number, text: string): void {
  run.audit.push({ at: now, text });
  if (run.audit.length > 300) run.audit.splice(0, run.audit.length - 300);
}

/** 把這段 running 的時間記進 activeMs、stepActiveMs;activeSince 依目前狀態重設。 */
function account(run: FlowRun, now: number): void {
  if (run.activeSince !== null) {
    const d = Math.max(0, now - run.activeSince);
    run.activeMs += d;
    run.stepActiveMs += d;
  }
  run.activeSince = run.status === 'running' ? now : null;
}

function startEffect(run: FlowRun, kind: string): number {
  run.seq += 1;
  run.inflight = { kind, token: run.seq };
  return run.seq;
}

function pend(run: FlowRun, now: number, fx: FlowEffect[], kind: PendingKind, message: string, options: DecisionChoice[], extra: Partial<PendingDecision> = {}): void {
  run.seq += 1;
  const cur = currentAssignment(run);
  // 目前的交辦屬於別的步驟(例如前一步已通過、這一步還沒交辦)時不掛在它身上
  const a = cur && cur.stepId === run.stepId ? cur : undefined;
  run.pending = { id: `d${run.seq}`, kind, stepId: run.stepId, ...(a ? { assignmentId: a.id } : {}), message, options, createdAt: now, ...extra };
  run.status = 'awaiting_user';
  if (a && !isActive(a)) a.result = 'user';
  audit(run, now, `交給使用者(${kind}):${message}`);
  // 停機或需裁示時通知總管與使用者(只留言、不自動跑回合,使用者裁示第 4 點);同一個待決事項重提時不重複通知
  const key = `${kind}|${a?.id ?? ''}|${message}`;
  if (run.lastNotice !== key) fx.push({ type: 'notify', kind: 'needs_user', message: `協作流程「${run.flow.name}」需要你處理:${message}` });
  run.lastNotice = key;
}

/** 開始確認交辦結束;block 為 true 時擋住 drive(停止、重跑、改派要等確認完才往下走)。 */
function startEnsure(run: FlowRun, fx: FlowEffect[], purpose: 'stop' | 'rerun' | 'limit', ids: string[], block: boolean): void {
  run.seq += 1;
  const token = run.seq;
  run.ensuring = { token, purpose, assignmentIds: [...ids] };
  if (block) run.inflight = { kind: 'ensure', token };
  fx.push({ type: 'ensure_ended', token, assignmentIds: [...ids] });
}

/** 確認交辦都結束了:標記交辦,停止的就完成停止。 */
function ensureDone(run: FlowRun, now: number, fx: FlowEffect[], en: NonNullable<FlowRun['ensuring']>): void {
  run.ensuring = undefined;
  const mark: AssignmentStatus = en.purpose === 'stop' ? (run.stopTarget === 'stopped' ? 'stopped' : 'interrupted') : en.purpose === 'rerun' ? 'superseded' : 'interrupted';
  for (const id of en.assignmentIds) { const a = run.assignments.find(x => x.id === id); if (a && isActive(a)) { a.status = mark; a.endedAt ??= now; } }
  if (en.purpose === 'stop') finalize(run, now, fx, run.stopTarget ?? 'stopped');
}

/** 確認逾時:節點還沒停下來。不默認已結束,交給使用者(在那之前不釋放工作樹、不重新交辦)。 */
function notEnded(run: FlowRun, now: number, fx: FlowEffect[], en: NonNullable<FlowRun['ensuring']>, stuck: string[]): void {
  run.ensuring = { ...en, token: 0 };
  if (run.inflight?.kind === 'ensure') run.inflight = null;
  const names = [...new Set(en.assignmentIds.map(id => run.assignments.find(a => a.id === id)?.agentName).filter(Boolean))].join('、');
  if (en.purpose === 'limit') { audit(run, now, `中斷超時的交辦,但「${names}」還沒停下來;它之後的回報一律當遲到`); return; }
  const stop = en.purpose === 'stop';
  pend(run, now, fx, 'not_ended', `「${names || '節點'}」還沒停下來(已多次送出中斷${stuck.length ? `,仍在執行:${stuck.join('、')}` : ''})。確認結束前不會${stop ? '完成停止、不釋放工作樹' : '重新交辦或改派'}。可以再等,或在確定它不會再寫檔後強制視為結束${stop ? '' : ',也可以停止流程'}。`, stop ? ['wait', 'force_ended'] : ['wait', 'force_ended', 'stop']);
  if (stop) run.status = 'awaiting_user';
}

/** 版本失效:審查、核實、授權全部作廢。 */
function invalidate(run: FlowRun, now: number): void {
  run.verifiedVersion = undefined;
  run.reviewedVersion = undefined;
  for (const c of run.approvals) if (c.status === 'pending') { c.status = 'expired'; c.decidedAt = now; c.result = '版本已改變,授權失效'; }
}

function versionChanged(run: FlowRun, now: number, fx: FlowEffect[], where: string, expected: string, actual: string | null): void {
  invalidate(run, now);
  pend(run, now, fx, 'version_changed', `${where}時發現正本已經改變(版本 ${expected.slice(0, 8)} → ${actual ? actual.slice(0, 8) : '讀不到'}),先前的審查、核實與授權都已失效。選「繼續」以目前的正本重新核實與審查。`, ['continue', 'halt', 'stop']);
}

/** 結束流程:有還沒結束的交辦就先 stopping、確認結束(ensure_ended),再變成最終狀態。 */
function terminate(run: FlowRun, now: number, fx: FlowEffect[], final: 'stopped' | 'halted', reason: string): void {
  run.reason = reason;
  run.pending = undefined;
  const active = run.assignments.filter(isActive);
  audit(run, now, `${final === 'stopped' ? '停止' : '停機'}:${reason}`);
  if (active.length) {
    run.status = 'stopping';
    run.stopTarget = final;
    startEnsure(run, fx, 'stop', active.map(a => a.id), true);
    return;
  }
  run.ensuring = undefined;
  finalize(run, now, fx, final);
}

function finalize(run: FlowRun, now: number, fx: FlowEffect[], final: 'stopped' | 'halted' | 'completed'): void {
  run.status = final;
  run.inflight = null;
  run.stopTarget = undefined;
  run.ensuring = undefined;
  for (const a of run.assignments) if (isActive(a)) { a.status = final === 'stopped' ? 'stopped' : 'interrupted'; a.endedAt ??= now; }
  // 交辦前的授權卡只對進行中的流程有意義:流程結束就失效
  for (const c of run.approvals) if (c.stepId && c.status === 'pending') { c.status = 'expired'; c.decidedAt = now; c.result = '流程已結束,授權卡失效'; }
  run.gate = undefined;
  fx.push({ type: 'cleanup' });
  if (final === 'halted') fx.push({ type: 'notify', kind: 'halted', message: `協作流程「${run.flow.name}」停機:${run.reason ?? ''}` });
  else if (final === 'completed') fx.push({ type: 'notify', kind: 'completed', message: `協作流程「${run.flow.name}」已走完,等你確認授權卡。` });
  else fx.push({ type: 'notify', kind: 'stopped', message: `協作流程「${run.flow.name}」已停止:${run.reason ?? ''}` });
}

/** 前往某一步:審查步驟先匯出副本,寫入步驟直接交辦。 */
function goStep(run: FlowRun, now: number, fx: FlowEffect[], target: string): void {
  if (target === HALT) { terminate(run, now, fx, 'halted', '流程定義指向停機'); return; }
  if (target === DONE) { run.phase = 'finishing'; run.finish = undefined; return; }
  const step = stepOf(run, target);
  if (!step) { terminate(run, now, fx, 'halted', `找不到步驟「${target}」`); return; }
  run.stepId = step.id;
  run.copy = undefined;
  run.phase = step.mode === 'review' ? 'exporting_copy' : 'dispatching';
}

/** 這一步通過,往下一步走:next、定義順序的下一步、或 DONE。 */
function advance(run: FlowRun, now: number, fx: FlowEffect[], a: RunAssignment): void {
  a.result = 'passed';
  const steps = run.flow.steps;
  const i = steps.findIndex(s => s.id === a.stepId);
  const step = steps[i];
  const target = step?.next ?? steps[i + 1]?.id ?? DONE;
  audit(run, now, `步驟「${step?.label ?? a.stepId}」通過 → ${target === DONE ? '收尾' : target}`);
  goStep(run, now, fx, target);
}

/** 退回(審查必修或核實失敗):計一輪;超過上限就停機。 */
function reject(run: FlowRun, now: number, fx: FlowEffect[], a: RunAssignment, why: string, carry: AssignmentContext): void {
  a.result = 'rejected';
  const step = stepOf(run, a.stepId);
  const max = run.flow.limits.maxRejections;
  if (run.rejections >= max) { terminate(run, now, fx, 'halted', `退回已達上限(${max} 輪),仍有${why}`); return; }
  run.rejections += 1;
  audit(run, now, `退回第 ${run.rejections} 輪:${why}`);
  const target = step?.onReject;
  if (!target || target === HALT) { terminate(run, now, fx, 'halted', `${why}(步驟沒有設定退回對象)`); return; }
  run.carry = carry;
  goStep(run, now, fx, target);
}

// ---- 選擇交辦對象 ----

export interface FixTargetInput {
  /** 原本的承辦(上一次這個角色的交辦);沒有就是 undefined。 */
  original?: { agentId: string; name: string; sessionAtEnd: string | null };
  agents: AgentLite[];
  /** 專案設定的角色對照(節點名稱或 id)。 */
  roleHint?: string;
}

export type FixTarget =
  | { kind: 'continue'; agentId: string; wake: boolean; reason: string }
  | { kind: 'new'; agentId: string; wake: boolean; reason: string }
  | { kind: 'need_user'; reason: string; candidates: { id: string; name: string }[] };

/**
 * 修正步驟交給誰(計畫 §3.2 第 8 點):
 * - 原節點還在、session 沒變 → 送回原 session(continue);節點休眠就先喚醒。
 * - 原節點還在、session 換了 → 仍交給同一個節點,但算新 session(new)。
 * - 原節點不在了 → 依專案的角色對照(id 或名稱)找,再找同名的節點(new);找不到就請使用者指定(need_user)。
 */
export function chooseFixTarget(i: FixTargetInput): FixTarget {
  const wake = (a: AgentLite) => a.state === 'sleeping';
  const o = i.original;
  if (o) {
    const same = i.agents.find(a => a.id === o.agentId);
    if (same) {
      if (o.sessionAtEnd && same.sessionId === o.sessionAtEnd) return { kind: 'continue', agentId: same.id, wake: wake(same), reason: '送回原 session' };
      return { kind: 'new', agentId: same.id, wake: wake(same), reason: '原節點的 session 已經換了,開新的交辦' };
    }
  }
  const hint = i.roleHint?.trim();
  const byHint = hint ? i.agents.find(a => a.id === hint) ?? i.agents.find(a => a.name === hint) : undefined;
  if (byHint) return { kind: 'new', agentId: byHint.id, wake: wake(byHint), reason: `原節點不在了,依專案角色對照交給「${byHint.name}」` };
  const byName = o ? i.agents.find(a => a.name === o.name) : undefined;
  if (byName) return { kind: 'new', agentId: byName.id, wake: wake(byName), reason: `原節點不在了,交給同名的節點「${byName.name}」` };
  return { kind: 'need_user', reason: o ? `原本的承辦「${o.name}」已經不在,找不到可以接手的節點` : '找不到可以接手的節點', candidates: i.agents.map(a => ({ id: a.id, name: a.name })) };
}

/** 一般步驟的交辦對象:角色指定的節點;不在了就依角色對照或同名節點找。 */
function roleTarget(run: FlowRun, step: FlowStepDef, agents: AgentLite[]): FixTarget {
  if (run.forceAgent?.stepId === step.id) {
    const f = agents.find(a => a.id === run.forceAgent!.agentId);
    if (f) return { kind: 'new', agentId: f.id, wake: f.state === 'sleeping', reason: '使用者改派' };
  }
  const role = run.roles[step.role];
  if (step.continueSession) {
    const prev = lastOf(run, a => stepOf(run, a.stepId)?.role === step.role && stepOf(run, a.stepId)?.mode === 'write' && !!a.report);
    if (prev) return chooseFixTarget({ original: { agentId: prev.agentId, name: prev.agentName, sessionAtEnd: prev.sessionAtEnd }, agents, roleHint: run.roleHints[step.role] });
  }
  const t = chooseFixTarget({ original: role ? { agentId: role.agentId, name: role.name, sessionAtEnd: null } : undefined, agents, roleHint: run.roleHints[step.role] });
  // 一般步驟沒有「原 session」的概念:同一個節點就交給它,延續與否看它上次在這個流程裡的 session
  if (t.kind === 'need_user') return t;
  const agent = agents.find(a => a.id === t.agentId)!;
  const last = lastOf(run, a => a.agentId === agent.id);
  const continued = !!last && !!last.sessionAtEnd && last.sessionAtEnd === agent.sessionId;
  return continued ? { kind: 'continue', agentId: agent.id, wake: t.wake, reason: '延續這個節點在流程裡的 session' } : { ...t, kind: 'new' };
}

// ---- 推進 ----

/** 依目前的階段與已知的事實決定下一步;只在 running、沒有進行中的 effect 時才發出新的工作。 */
function drive(run: FlowRun, now: number, fx: FlowEffect[]): void {
  for (let guard = 0; guard < 30; guard++) {
    if (run.status !== 'running' || run.inflight) return;
    const a = currentAssignment(run);
    switch (run.phase) {
      case 'dispatching': {
        // 步驟列了 requires_approval:先拍正本、開授權卡,都允許了才交辦
        const step = stepOf(run, run.stepId);
        if (step?.requiresApproval.length && !(run.gate?.stepId === step.id && run.gate.ready)) {
          const token = startEffect(run, 'gate');
          run.gate = { stepId: step.id, ready: false };
          fx.push({ type: 'gate', token, stepId: step.id });
          return;
        }
        const token = startEffect(run, 'pick');
        fx.push({ type: 'pick_agent', token, stepId: run.stepId });
        return;
      }
      case 'working': case 'reviewing': case 'awaiting_report': {
        if (!a) { run.phase = 'dispatching'; continue; }
        if (!a.turnEnded) return;
        if (a.report) { a.status = 'reported'; a.endedAt ??= now; run.phase = 'snapshotting'; continue; }
        if (a.turnOutcome === 'failed') {
          a.status = 'failed';
          a.endedAt ??= now;
          pend(run, now, fx, 'agent_error', `「${a.agentName}」在步驟「${stepOf(run, a.stepId)?.label ?? a.stepId}」出錯或失聯,沒有交回 step_report。`, ['rerun', 'reassign', 'halt', 'stop'], { candidates: [] });
          return;
        }
        if (!a.reminded) {
          a.status = 'awaiting_report';
          run.phase = 'awaiting_report';
          const due = (a.turnEndedAt ?? now) + run.flow.limits.reminderMinutes * MIN;
          if (now < due) return;
          a.reminded = true;
          a.turnEnded = false;
          a.status = 'running';
          run.phase = modeOf(run, a.stepId) === 'review' ? 'reviewing' : 'working';
          audit(run, now, `提醒「${a.agentName}」交 step_report`);
          fx.push({ type: 'remind', assignmentId: a.id, agentId: a.agentId });
          return;
        }
        a.status = 'unreported';
        a.endedAt ??= now;
        pend(run, now, fx, 'unreported', `「${a.agentName}」在步驟「${stepOf(run, a.stepId)?.label ?? a.stepId}」提醒後仍沒有交 step_report(記為未回報,不計入退回輪數)。可以手動補報或重跑這一步。`, ['manual_report', 'rerun', 'halt', 'stop']);
        return;
      }
      case 'snapshotting': {
        if (!a) { terminate(run, now, fx, 'halted', '找不到要收尾的交辦'); return; }
        if (!a.snap) {
          const token = startEffect(run, 'snapshot');
          fx.push({ type: 'snapshot', token, assignmentId: a.id });
          return;
        }
        evaluateSnapshot(run, now, fx, a);
        continue;
      }
      case 'verifying': {
        if (!a) { terminate(run, now, fx, 'halted', '找不到要核實的交辦'); return; }
        if (!a.verify && !a.verifyError) {
          const token = startEffect(run, 'verify');
          fx.push({ type: 'verify', token, assignmentId: a.id, version: a.version });
          return;
        }
        evaluateVerify(run, now, fx, a);
        continue;
      }
      case 'exporting_copy': {
        if (!run.copy) {
          const token = startEffect(run, 'export');
          fx.push({ type: 'export_copy', token, version: run.version });
          return;
        }
        run.phase = 'dispatching';
        continue;
      }
      case 'finishing': {
        if (!run.finish) {
          const token = startEffect(run, 'finish');
          fx.push({ type: 'finish', token });
          return;
        }
        evaluateFinish(run, now, fx);
        continue;
      }
      default:
        return;
    }
  }
}

function needsRulingOf(r: StepReport): string[] { return [...r.needsRuling, ...r.questions]; }

/**
 * 授權後預期中的 refs 改變:commit → HEAD 與交辦時所在的分支;push → 遠端追蹤分支(refs/remotes/…)。
 * 其他(標籤、別的分支、stash…)仍算違規。
 */
export function allowedRefChanges(approved: readonly HighRiskAction[], branch: string): (ref: string) => boolean {
  const commit = approved.includes('commit');
  const push = approved.includes('push');
  return ref => (commit && (ref === 'HEAD' || (!!branch && ref === branch))) || (push && ref.startsWith('refs/remotes/'));
}

const ACTION_LABEL: Record<HighRiskAction, string> = { commit: '本地 commit', push: 'push 到遠端', real_vault: '碰真實記憶庫', install: '安裝或覆蓋' };

/** 交辦前授權卡寫明涵蓋什麼。 */
function gateCovers(step: FlowStepDef, action: HighRiskAction, version: string): string[] {
  const what: Record<HighRiskAction, string> = {
    commit: '在自己的工作樹做本地 commit',
    push: '把分支 push 到遠端(一般 push)',
    real_vault: '寫入設定中的記憶庫資料夾',
    install: '執行安裝檔(*Setup*.exe、.msi)或寫入 Program Files、%LOCALAPPDATA%\\Programs',
  };
  return [`步驟「${step.label}」的交辦可以${what[action]}`, `從版本 ${version.slice(0, 12)} 開始的這一步(重跑時版本沒變就沿用)`];
}

/** 交辦前授權卡寫明不涵蓋什麼。 */
function gateExcludes(step: FlowStepDef, action: HighRiskAction): string[] {
  const out = ['其他步驟(授權只給這一步)', '合併或核准 PR、force push、刪分支(永遠禁止)', '打包安裝檔(npm run dist、electron-builder)'];
  const others = (['commit', 'push', 'real_vault', 'install'] as HighRiskAction[]).filter(a => a !== action && !step.requiresApproval.includes(a));
  if (others.length) out.unshift(`沒有列出的高風險動作:${others.map(a => ACTION_LABEL[a]).join('、')}`);
  if (action === 'real_vault') out.push('流程定義資料夾(flows/)與主控台設定資料夾仍然不能寫');
  return out;
}

/**
 * 交辦前的授權(步驟的 requires_approval):正本的版本拍好之後,每個動作要有一張這個版本、已允許的卡;
 * 沒有就開新卡(同版本已有待決的就沿用),交給使用者。都允許了才往下交辦。舊版本的待決卡失效。
 */
function openGate(run: FlowRun, now: number, fx: FlowEffect[], step: FlowStepDef, version: string): void {
  for (const c of run.approvals) if (c.stepId === step.id && c.status === 'pending' && c.version !== version) { c.status = 'expired'; c.decidedAt = now; c.result = '版本已改變,授權失效'; }
  const missing: HighRiskAction[] = [];
  for (const action of step.requiresApproval) {
    const mine = run.approvals.filter(c => c.stepId === step.id && c.action === action && c.version === version);
    if (mine.some(c => c.status === 'approved')) continue;
    missing.push(action);
    if (mine.some(c => c.status === 'pending')) continue;
    run.seq += 1;
    run.approvals.push({
      id: `a${run.seq}`, action, stepId: step.id, version, covers: gateCovers(step, action, version), excludes: gateExcludes(step, action),
      paths: [], outOfScope: [], status: 'pending', createdAt: now,
    });
  }
  run.gate = { stepId: step.id, version, ready: !missing.length };
  if (!missing.length) { audit(run, now, `步驟「${step.label}」的授權卡都已允許(版本 ${version.slice(0, 8)})`); return; }
  pend(run, now, fx, 'step_approval', `步驟「${step.label}」要先在授權卡上允許:${missing.map(a => ACTION_LABEL[a]).join('、')}(版本 ${version.slice(0, 8)})。允許才交辦;拒絕就停機、不交辦。`, ['halt', 'stop']);
}

function evaluateSnapshot(run: FlowRun, now: number, fx: FlowEffect[], a: RunAssignment): void {
  const s = a.snap!;
  const step = stepOf(run, a.stepId);
  const mode = step?.mode ?? 'write';
  const approved = a.approved ?? [];
  // 這一步經授權卡允許 commit 或 push:預期中的 refs 改變只記稽核紀錄,其餘照樣算違規
  const allowedRefs = allowedRefChanges(approved, a.refsBefore?.symbolic ?? '');
  const okRefs = s.refsChanged.filter(allowedRefs);
  const badRefs = s.refsChanged.filter(r => !allowedRefs(r));
  if (okRefs.length && !a.result) audit(run, now, `refs 改變(這一步已授權 ${approved.filter(x => x === 'commit' || x === 'push').join('、')}):${okRefs.slice(0, 6).join('、')}`);
  if (badRefs.length && !run.violations.some(v => v.kind === 'refs_changed' && v.assignmentId === a.id)) {
    run.violations.push({ kind: 'refs_changed', stepId: a.stepId, assignmentId: a.id, detail: `「${a.agentName}」這一步期間 refs 改變了${okRefs.length ? '(超出這一步授權的範圍)' : ''}:可能是節點自己 commit 或 push,也可能是使用者手動 commit、切分支,或 IDE 自動 fetch 更新了遠端追蹤分支`, items: badRefs, blocked: false, at: now });
    terminate(run, now, fx, 'halted', `偵測到 commit 或 push(${badRefs.slice(0, 4).join('、')});也可能是使用者手動 commit 或 IDE 自動 fetch。依範圍合約停機,交給使用者處理`);
    return;
  }
  // L4:被忽略的打包產出(dist/、release/)新增或改動 → 可能是節點自己打包了,停機交給使用者
  if (s.artifacts?.length && !run.violations.some(v => v.kind === 'artifact_changed' && v.assignmentId === a.id)) {
    run.violations.push({ kind: 'artifact_changed', stepId: a.stepId, assignmentId: a.id, detail: `「${a.agentName}」這一步期間打包產出(dist/、release/)新增或改動了:可能是節點自己打包(npm run dist、electron-builder),也可能是使用者手動建置`, items: s.artifacts.slice(0, 50), actions: ['dist'], blocked: false, at: now });
    terminate(run, now, fx, 'halted', `偵測到打包產出被新增或改動(${s.artifacts.slice(0, 4).join('、')})。依範圍合約停機,交給使用者處理`);
    return;
  }
  // 受保護的資料夾(使用者裁示第 3、8 點):流程定義 flows/、主控台設定資料夾、沒授權的記憶庫
  if (s.protectedWrites?.length && !run.violations.some(v => v.kind === 'protected_write' && v.assignmentId === a.id)) {
    run.violations.push({ kind: 'protected_write', stepId: a.stepId, assignmentId: a.id, detail: `「${a.agentName}」這一步期間受保護的資料夾被寫入(流程定義資料夾、主控台設定資料夾或記憶庫);也可能來自其他進行中的流程或使用者手動修改`, items: s.protectedWrites.slice(0, 50), blocked: false, at: now });
    terminate(run, now, fx, 'halted', `偵測到受保護的資料夾被寫入(${s.protectedWrites.slice(0, 4).join('、')});也可能來自其他進行中的流程或使用者手動修改。節點的寫入範圍不得包含流程定義與主控台設定資料夾,依範圍合約停機,交給使用者處理`);
    return;
  }
  if (s.error || !s.version) { terminate(run, now, fx, 'halted', `無法拍下正本的快照:${s.error ?? '不是 git 版本庫?'}`); return; }
  if (s.outOfScope.length && !run.violations.some(v => v.kind === 'out_of_scope' && v.assignmentId === a.id)) {
    run.violations.push({ kind: 'out_of_scope', stepId: a.stepId, assignmentId: a.id, detail: s.unexplained.length ? `改到範圍外的檔案,其中 ${s.unexplained.length} 個沒有寫原因` : '改到範圍外的檔案(都有寫原因)', items: s.outOfScope, blocked: false, at: now });
  }
  if (mode === 'review') {
    if (s.copyError && !a.copyAccepted) {
      pend(run, now, fx, 'copy_missing', `無法確認審查副本有沒有被寫入(${s.copyError})。可以重新審查,或照用這次的審查結果。`, ['rerun', 'continue', 'halt', 'stop']);
      return;
    }
    if (s.copyWritten.length && !run.violations.some(v => v.kind === 'copy_written' && v.assignmentId === a.id)) {
      run.violations.push({ kind: 'copy_written', stepId: a.stepId, assignmentId: a.id, detail: '審查副本被寫入,已丟棄(不會回寫正本)', items: s.copyWritten, blocked: false, at: now });
    }
    if (s.version !== a.reviewedVersion) { versionChanged(run, now, fx, '審查結束', a.reviewedVersion ?? '', s.version); return; }
  } else {
    a.version = s.version;
    run.version = s.version;
  }
  const r = a.report!;
  if (needsRulingOf(r).length && !a.rulingDone) {
    pend(run, now, fx, 'needs_ruling', `「${a.agentName}」提出需要你裁示的事(不計入退回輪數):${needsRulingOf(r).join(';')}`, ['continue', 'halt', 'stop']);
    return;
  }
  if (mode === 'review') {
    if (r.verdict === 'changes_required' && r.mustFix.length) {
      reject(run, now, fx, a, `審查必修 ${r.mustFix.length} 項`, { mustFixFrom: a.id, reportFrom: lastOf(run, x => modeOf(run, x.stepId) === 'write' && !!x.report)?.id });
      return;
    }
    run.reviewedVersion = a.reviewedVersion;
    advance(run, now, fx, a);
    return;
  }
  if (step?.verify && run.flow.verify.commands.length) { run.phase = 'verifying'; return; }
  advance(run, now, fx, a);
}

function evaluateVerify(run: FlowRun, now: number, fx: FlowEffect[], a: RunAssignment): void {
  if (a.verifyError || !a.verify) {
    pend(run, now, fx, 'verify_blocked', `核實沒有跑完:${a.verifyError ?? '沒有結果'}(不計入退回輪數)`, ['rerun', 'halt', 'stop']);
    return;
  }
  const v = a.verify;
  if (a.verifyCanonical !== a.version) { versionChanged(run, now, fx, '核實結束', a.version, a.verifyCanonical ?? null); return; }
  if (v.outcome === 'modified' && !run.violations.some(x => x.kind === 'verify_modified' && x.assignmentId === a.id)) {
    run.violations.push({ kind: 'verify_modified', stepId: a.stepId, assignmentId: a.id, detail: `核實指令改到受版本控制的檔案:${v.modifiedBy.join('、')}`, items: v.modified, blocked: false, at: now });
  }
  if (v.outcome === 'pass' || (v.outcome === 'modified' && a.verifyAccepted)) {
    run.verifiedVersion = a.version;
    advance(run, now, fx, a);
    return;
  }
  if (v.outcome === 'fail') {
    reject(run, now, fx, a, `核實失敗(${v.failed.join('、')})`, { verifyFrom: a.id, reportFrom: a.id });
    return;
  }
  const stuck = v.commands.find(c => c.id === v.stuckAt);
  if (v.outcome === 'blocked') {
    pend(run, now, fx, 'verify_blocked', `核實被環境擋住(不計入退回輪數):${stuck ? `${stuck.id}:${stuck.reason ?? stuck.lastLine}` : v.blocked.join('、')}`, ['rerun', 'halt', 'stop']);
  } else if (v.outcome === 'timeout') {
    pend(run, now, fx, 'verify_timeout', `核實逾時(不計入退回輪數):${stuck ? `${stuck.id} 卡在 ${stuck.lastLine || '(沒有輸出)'}` : ''}`, ['rerun', 'halt', 'stop']);
  } else {
    pend(run, now, fx, 'verify_modified', `核實指令改到受版本控制的檔案(不算實作者失敗、不計入退回輪數):${v.commands.filter(c => c.modified.length).map(c => `${c.id} 改了 ${c.modified.join('、')}`).join(';')}`, ['continue', 'rerun', 'halt', 'stop']);
  }
}

function evaluateFinish(run: FlowRun, now: number, fx: FlowEffect[]): void {
  const f = run.finish!;
  const expected = run.reviewedVersion ?? run.verifiedVersion ?? run.version;
  if (f.error) { terminate(run, now, fx, 'halted', `收尾失敗:${f.error}`); return; }
  if (f.canonical !== expected) { run.finish = undefined; versionChanged(run, now, fx, '收尾', expected, f.canonical); return; }
  if (f.paths.length) {
    for (const action of run.flow.finish.offer) {
      // 第一版收尾只支援 commit;其他動作明確不支援(定義檔解析時也會警告)
      if (action !== 'commit') { audit(run, now, `收尾的「${ACTION_LABEL[action]}」授權卡第一版不支援(只支援 commit),請在流程結束後自行處理`); continue; }
      run.seq += 1;
      const outside = new Set(f.outOfScope);
      const unexplained = f.unexplained ?? [];
      run.approvals.push({
        id: `a${run.seq}`, action, version: expected,
        covers: [
          `把版本 ${expected.slice(0, 12)} 的修改提交成一筆本地 commit`,
          `範圍內的 ${f.paths.length - f.outOfScope.length} 個檔案${f.outOfScope.length ? `;範圍外的 ${f.outOfScope.length} 個要勾選才納入` : ''}`,
        ],
        excludes: ['push', '合併或核准 PR', '刪分支', '打包安裝檔', ...(f.outOfScope.length ? ['沒有勾選的範圍外檔案(留在工作區)'] : [])],
        paths: f.paths.filter(p => !outside.has(p)), outOfScope: [...f.outOfScope],
        ...(f.outOfScope.length ? { scopeNotes: (f.scopeNotes ?? []).filter(n => outside.has(n.path)), unexplained: unexplained.filter(p => outside.has(p)) } : {}),
        status: 'pending', createdAt: now,
      });
    }
  } else audit(run, now, f.note ?? '流程走完,但這次沒有任何檔案修改,不產生授權卡');
  audit(run, now, '流程走完');
  finalize(run, now, fx, 'completed');
}

// ---- reducer ----

function newAssignment(run: FlowRun, now: number, step: FlowStepDef, agent: AgentLite, continuation: Continuation): RunAssignment {
  run.seq += 1;
  const attempt = run.assignments.filter(a => a.stepId === step.id).length + 1;
  const ctx: AssignmentContext = { ...run.carry };
  if (step.mode === 'review' && !ctx.reportFrom) ctx.reportFrom = lastOf(run, a => modeOf(run, a.stepId) === 'write' && !!a.report)?.id;
  if (step.mode === 'write' && continuation === 'new' && (ctx.mustFixFrom || ctx.verifyFrom)) {
    const end = run.reviewedVersion ?? lastOf(run, a => modeOf(run, a.stepId) === 'review')?.reviewedVersion ?? run.version;
    if (end && end !== run.baseVersion) ctx.diff = { base: run.baseVersion, end };
  }
  const a: RunAssignment = {
    id: `${run.id}-${step.id}-${attempt}-${run.seq}`,
    stepId: step.id, attempt, agentId: agent.id, agentName: agent.name,
    sessionAtDispatch: agent.sessionId, sessionAtEnd: null, continuation, status: 'queued', taskIds: [], reminded: false, turnEnded: false,
    baseVersion: run.version || run.baseVersion, version: '', context: ctx, files: [], startedAt: now,
  };
  if (step.mode === 'review') { a.reviewedVersion = run.copy?.version ?? run.version; a.copyDir = run.copy?.dir; run.copy = undefined; }
  // 交辦前的授權:只有這一步的這個交辦可以做(L1、L2 攔截與 refs 比對會扣掉)
  if (step.requiresApproval.length && run.gate?.stepId === step.id && run.gate.ready) { a.approved = [...step.requiresApproval]; a.approvedVersion = run.gate.version; }
  run.gate = undefined;
  run.carry = {};
  return a;
}

/**
 * 純 reducer:不修改傳入的 run(先深複製),回傳新的 run 與 effects。now 是事件發生的時間(毫秒)。
 */
export function reduce(input: FlowRun, event: FlowEvent, now: number): ReduceResult {
  const run: FlowRun = structuredClone(input);
  const fx: FlowEffect[] = [];
  account(run, now);
  run.updatedAt = now;
  const find = (id: string) => run.assignments.find(a => a.id === id);

  // 終止狀態不復活:只記稽核紀錄(遲到的回報照樣寫進 late/;completed 的授權卡結果照常更新)
  if (isTerminal(run.status)) {
    if (event.type === 'report') {
      fx.push({ type: 'write_late', assignmentId: event.assignmentId, report: event.report, reason: `流程已經${run.status === 'completed' ? '走完' : run.status === 'stopped' ? '停止' : '停機'}` });
      audit(run, now, `流程已結束,遲到的回報(${event.assignmentId})只寫進 late/`);
    } else if (event.type === 'approval_card' && run.status === 'completed') {
      applyCard(run, now, fx, event);
    } else if (event.type === 'turn_ended' || event.type === 'task_started') {
      recordTask(run, now, event);
    } else if (event.type !== 'tick') audit(run, now, `流程已結束,忽略事件 ${event.type}`);
    account(run, now);
    return { run, effects: fx };
  }

  switch (event.type) {
    case 'start':
      audit(run, now, '開始執行');
      break;

    case 'agents': {
      if (run.inflight?.token !== event.token) { audit(run, now, '忽略過期的節點清單'); break; }
      run.inflight = null;
      if (run.status !== 'running') break; // 暫停期間拿到的清單不用,繼續時重新選
      const step = stepOf(run, run.stepId);
      if (!step) { terminate(run, now, fx, 'halted', `找不到步驟「${run.stepId}」`); break; }
      if (run.dispatches >= run.flow.limits.maxDispatches) { terminate(run, now, fx, 'halted', `交辦次數已達上限(${run.flow.limits.maxDispatches} 次)`); break; }
      const t = roleTarget(run, step, event.agents);
      if (t.kind === 'need_user') { pend(run, now, fx, 'need_agent', `步驟「${step.label}」${t.reason},請指定節點。`, ['reassign', 'halt', 'stop'], { candidates: t.candidates }); break; }
      const agent = event.agents.find(x => x.id === t.agentId)!;
      const a = newAssignment(run, now, step, agent, t.kind === 'continue' ? 'continued' : 'new');
      run.assignments.push(a);
      run.current = a.id;
      run.dispatches += 1;
      run.stepActiveMs = 0;
      run.forceAgent = undefined;
      run.phase = step.mode === 'review' ? 'reviewing' : 'working';
      audit(run, now, `交辦「${step.label}」第 ${a.attempt} 次給「${agent.name}」(${a.continuation === 'continued' ? '延續原 session' : '新的 session'};${t.reason})`);
      fx.push({ type: 'dispatch', assignmentId: a.id, agentId: agent.id, wake: t.wake });
      break;
    }

    case 'dispatched': {
      const a = find(event.assignmentId);
      if (!a) break;
      if (event.error) {
        audit(run, now, `交辦失敗:${event.error}`);
        if (isActive(a)) { a.turnEnded = true; a.turnOutcome = 'failed'; a.turnEndedAt = now; }
        break;
      }
      if (event.queuedId) a.queuedId = event.queuedId;
      if (event.refsBefore && !a.refsBefore) a.refsBefore = event.refsBefore;
      if (event.guardBefore && !a.guardBefore) a.guardBefore = event.guardBefore;
      break;
    }

    case 'gate_ready': {
      if (run.inflight?.token !== event.token) { audit(run, now, '忽略過期的授權卡版本'); break; }
      run.inflight = null;
      const step = stepOf(run, run.stepId);
      if (!step || run.phase !== 'dispatching' || run.gate?.stepId !== step.id) break;
      if (!event.canonical) { terminate(run, now, fx, 'halted', `無法拍下正本的快照,不能產生步驟「${step.label}」的授權卡:${event.error ?? '不是 git 版本庫?'}`); break; }
      if (run.status !== 'running') { run.gate = undefined; break; } // 暫停期間拿到的不用,繼續時重新拍
      openGate(run, now, fx, step, event.canonical);
      break;
    }

    case 'gate_stale': {
      // 授權卡允許之後、真的交辦之前正本變了(例如改派、重開後繼續):這次交辦作廢,授權卡失效,重新拍版本開新卡
      const a = find(event.assignmentId);
      if (!a || a.id !== run.current || !isActive(a)) break;
      a.status = 'superseded';
      a.endedAt = now;
      a.result = 'user';
      for (const c of run.approvals) if (c.stepId === a.stepId && c.version === a.approvedVersion && c.status === 'approved') { c.status = 'expired'; c.result = `交辦前發現版本已改變(${(a.approvedVersion ?? '').slice(0, 8)} → ${event.canonical ? event.canonical.slice(0, 8) : '讀不到'}),授權失效`; }
      run.gate = undefined;
      run.phase = 'dispatching';
      audit(run, now, `步驟「${stepOf(run, a.stepId)?.label ?? a.stepId}」交辦前版本已改變,授權卡失效,重新產生授權卡`);
      break;
    }

    case 'task_started': case 'turn_ended':
      recordTask(run, now, event);
      break;

    case 'report': {
      const a = find(event.assignmentId);
      if (!a) { fx.push({ type: 'report_ignored', assignmentId: event.assignmentId, reason: '找不到這個交辦' }); break; }
      if (a.report) { fx.push({ type: 'report_ignored', assignmentId: a.id, reason: '這個交辦已經有有效的回報(以第一次為準)' }); break; }
      // 只有正在工作的交辦收回報:重跑、改派、超時中斷、停止的確認期間,以及等待使用者時進來的一律當遲到
      const working = run.phase === 'working' || run.phase === 'reviewing' || run.phase === 'awaiting_report';
      const ensuring = !!run.ensuring?.assignmentIds.includes(a.id);
      const live = a.id === run.current && isActive(a) && (run.status === 'running' || run.status === 'paused') && working && !ensuring;
      if (!live) {
        const why = run.status === 'stopping' ? '流程正在停止' : ensuring ? '這個交辦正在被中斷(重跑、改派或超時)' : a.id !== run.current ? '這個交辦已經被取代(改派或重跑)'
          : run.status === 'awaiting_user' ? '流程正在等使用者決定' : !working ? '流程已經不在等這個回報' : `這個交辦已經結束(${a.status})`;
        fx.push({ type: 'write_late', assignmentId: a.id, report: event.report, reason: why });
        if (run.pending?.kind === 'unreported' && run.pending.assignmentId === a.id) run.pending.prefill = event.report;
        audit(run, now, `遲到的回報(${a.id}):${why},只寫進 late/、不推進流程`);
        break;
      }
      a.report = event.report;
      fx.push({ type: 'write_report', assignmentId: a.id });
      audit(run, now, `收到「${a.agentName}」的 step_report${a.turnEnded ? '' : '(回合還沒結束,先存起來)'}`);
      break;
    }

    case 'snapshot_done': {
      if (run.inflight?.token !== event.token) { audit(run, now, '忽略過期的快照結果'); break; }
      run.inflight = null;
      const a = currentAssignment(run);
      if (a) a.snap = event.snap;
      break;
    }

    case 'verify_done': {
      if (run.inflight?.token !== event.token) { audit(run, now, '忽略過期的核實結果'); break; }
      run.inflight = null;
      const a = currentAssignment(run);
      if (a) {
        if (event.result) a.verify = event.result; else a.verifyError = event.error ?? '核實沒有結果';
        a.verifyCanonical = event.canonical;
      }
      break;
    }

    case 'copy_ready': {
      if (run.inflight?.token !== event.token) { audit(run, now, '忽略過期的副本'); break; }
      run.inflight = null;
      // 先比版本:正本已經變了就走版本失效(service 這時不匯出,事件不帶 dir)
      if (event.canonical && event.canonical !== run.version) { versionChanged(run, now, fx, '匯出審查副本', run.version, event.canonical); break; }
      if (event.error || !event.dir) { pend(run, now, fx, 'verify_blocked', `無法匯出審查副本:${event.error ?? (event.canonical ? '沒有路徑' : '拍不到正本的快照')}`, ['rerun', 'halt', 'stop']); break; }
      run.copy = { dir: event.dir, version: run.version };
      break;
    }

    case 'finish_done': {
      if (run.inflight?.token !== event.token) { audit(run, now, '忽略過期的收尾結果'); break; }
      run.inflight = null;
      run.finish = {
        canonical: event.canonical, paths: event.paths, outOfScope: event.outOfScope,
        ...(event.scopeNotes ? { scopeNotes: event.scopeNotes } : {}), ...(event.unexplained ? { unexplained: event.unexplained } : {}), ...(event.note ? { note: event.note } : {}), ...(event.error ? { error: event.error } : {}),
      };
      break;
    }

    case 'ended': {
      const en = run.ensuring;
      if (!en || !en.token || en.token !== event.token) break;
      if (run.inflight?.token === event.token) run.inflight = null;
      if (event.ok === false) { notEnded(run, now, fx, en, event.stuck ?? []); break; }
      ensureDone(run, now, fx, en);
      break;
    }

    case 'note':
      audit(run, now, event.text);
      break;

    case 'tick': {
      if (run.status !== 'running') break;
      const lim = run.flow.limits;
      if (run.activeMs >= lim.maxMinutes * MIN) { terminate(run, now, fx, 'halted', `超過整個流程的時間上限(${lim.maxMinutes} 分鐘,不含暫停與等待使用者)`); break; }
      const a = currentAssignment(run);
      if (a && a.status === 'running' && !a.turnEnded && !run.ensuring && run.stepActiveMs >= lim.stepMinutes * MIN) {
        startEnsure(run, fx, 'limit', [a.id], false);
        pend(run, now, fx, 'limit', `步驟「${stepOf(run, a.stepId)?.label ?? a.stepId}」超過時間上限(${lim.stepMinutes} 分鐘),已中斷。`, ['rerun', 'halt', 'stop']);
      }
      break;
    }

    case 'pause':
      if (run.status === 'running') { run.status = 'paused'; audit(run, now, '使用者暫停'); }
      break;

    case 'resume':
      if (run.status === 'paused') { run.status = 'running'; audit(run, now, '使用者繼續'); }
      break;

    case 'stop':
      if (run.status !== 'stopping') terminate(run, now, fx, 'stopped', event.reason ?? '使用者停止');
      break;

    case 'decide':
      decide(run, now, fx, event);
      break;

    case 'approval_card':
      applyCard(run, now, fx, event);
      break;

    case 'violation':
      run.violations.push(event.violation);
      if (event.halt) terminate(run, now, fx, 'halted', event.violation.detail);
      break;
  }

  drive(run, now, fx);
  account(run, now);
  return { run, effects: fx };
}

function recordTask(run: FlowRun, now: number, e: Extract<FlowEvent, { type: 'task_started' | 'turn_ended' }>): void {
  const a = run.assignments.find(x => x.id === e.assignmentId);
  if (!a) return;
  if (!a.taskIds.includes(e.taskId)) a.taskIds.push(e.taskId);
  if (e.type === 'task_started') {
    // 單步時間從節點真的開始執行算起(不含排隊)
    if (a.status === 'queued' && a.id === run.current) run.stepActiveMs = 0;
    if (a.status === 'queued') a.status = 'running';
    a.queuedId = undefined;
    a.turnEnded = false;
    return;
  }
  a.sessionAtEnd = e.sessionId;
  if (!isActive(a)) return;
  a.turnEnded = true;
  a.turnOutcome = e.outcome;
  a.turnEndedAt = now;
  if (a.status === 'queued') a.status = 'running';
  audit(run, now, `「${a.agentName}」的回合結束(${e.outcome === 'done' ? '完成' : e.outcome === 'interrupted' ? '中斷' : '出錯'})`);
}

function applyCard(run: FlowRun, now: number, fx: FlowEffect[], e: Extract<FlowEvent, { type: 'approval_card' }>): void {
  const c = run.approvals.find(x => x.id === e.cardId);
  if (!c || c.status !== 'pending') return;
  c.status = e.status;
  c.decidedAt = now;
  if (e.result) c.result = e.result;
  if (e.included) c.included = [...e.included];
  audit(run, now, `授權卡「${c.action}」:${e.status}${e.result ? `(${e.result})` : ''}`);
  if (!c.stepId || isTerminal(run.status)) return;
  // 交辦前的授權卡:拒絕 → 停機、不交辦;失效(允許時版本已變)→ 重新拍版本、開新卡;都允許了 → 交辦
  const gate = run.gate;
  if (!gate || gate.stepId !== c.stepId || gate.version !== c.version) return;
  const step = stepOf(run, c.stepId);
  const waiting = run.pending?.kind === 'step_approval';
  if (e.status === 'denied') { terminate(run, now, fx, 'halted', `使用者拒絕「${ACTION_LABEL[c.action]}」的授權卡,步驟「${step?.label ?? c.stepId}」不交辦`); return; }
  if (e.status === 'expired') {
    run.gate = undefined;
    if (waiting) { run.pending = undefined; run.status = 'running'; }
    audit(run, now, '授權卡失效(版本已改變),重新產生授權卡');
    return;
  }
  const all = (step?.requiresApproval ?? []).every(act => run.approvals.some(x => x.stepId === c.stepId && x.action === act && x.version === gate.version && x.status === 'approved'));
  if (!all) return;
  gate.ready = true;
  if (waiting) { run.pending = undefined; run.status = 'running'; }
  audit(run, now, `步驟「${step?.label ?? c.stepId}」的授權卡都已允許,交辦`);
}

function decide(run: FlowRun, now: number, fx: FlowEffect[], e: Extract<FlowEvent, { type: 'decide' }>): void {
  const p = run.pending;
  if (run.status !== 'awaiting_user' || !p || p.id !== e.decisionId || !p.options.includes(e.choice)) {
    audit(run, now, `忽略不適用的決定:${e.choice}`);
    return;
  }
  audit(run, now, `使用者決定(${p.kind}):${e.choice}${e.note ? `,${e.note}` : ''}`);
  const a = currentAssignment(run);
  if (e.choice === 'stop') { terminate(run, now, fx, 'stopped', '使用者停止'); return; }
  if (p.kind === 'not_ended') {
    const en = run.ensuring;
    run.pending = undefined;
    if (!en) { run.status = 'running'; return; }
    run.status = en.purpose === 'stop' ? 'stopping' : 'running';
    if (e.choice === 'wait') { startEnsure(run, fx, en.purpose, en.assignmentIds, true); return; }
    audit(run, now, '使用者確認節點不會再寫檔,強制視為結束');
    ensureDone(run, now, fx, en);
    return;
  }
  if (e.choice === 'halt') { terminate(run, now, fx, 'halted', `使用者決定停機(${p.kind})`); return; }
  run.pending = undefined;
  run.status = 'running';
  const rerunStep = () => {
    // 重跑這一步:先確認原交辦結束,再重新交辦(新的交辦)
    const active = run.assignments.filter(isActive).map(x => x.id);
    run.phase = modeOf(run, run.stepId) === 'review' ? 'exporting_copy' : 'dispatching';
    run.copy = undefined;
    if (active.length) startEnsure(run, fx, 'rerun', active, true);
    else run.ensuring = undefined;
    if (a && a.status === 'unreported') a.result = 'user';
  };
  switch (e.choice) {
    case 'manual_report':
      if (!a || !e.report) { pend(run, now, fx, p.kind, p.message, p.options, { ...(p.prefill ? { prefill: p.prefill } : {}) }); return; }
      a.report = { ...e.report, manual: true };
      a.status = 'reported';
      a.turnEnded = true;
      run.phase = 'snapshotting';
      fx.push({ type: 'write_report', assignmentId: a.id });
      return;
    case 'rerun':
      if (p.kind === 'verify_blocked' || p.kind === 'verify_timeout' || p.kind === 'verify_modified') {
        if (a && run.phase === 'verifying') { a.verify = undefined; a.verifyError = undefined; a.verifyCanonical = undefined; return; }
        if (run.phase === 'exporting_copy') { run.copy = undefined; return; }
      }
      rerunStep();
      return;
    case 'reassign': {
      if (!e.agentId) { pend(run, now, fx, p.kind, p.message, p.options, { ...(p.candidates ? { candidates: p.candidates } : {}) }); return; }
      const step = stepOf(run, run.stepId);
      if (step) run.roles[step.role] = { agentId: e.agentId, name: e.agentName ?? run.roles[step.role]?.name ?? e.agentId };
      run.forceAgent = { stepId: run.stepId, agentId: e.agentId };
      rerunStep();
      return;
    }
    case 'continue':
      if (p.kind === 'needs_ruling' && a) {
        a.rulingDone = true;
        if (e.note) run.carry = { ...run.carry, rulings: [...(run.carry.rulings ?? []), e.note] };
        return; // 仍在 snapshotting,drive 會接著評估
      }
      if (p.kind === 'verify_modified' && a) { a.verifyAccepted = true; return; }
      if (p.kind === 'copy_missing' && a) { a.copyAccepted = true; return; }
      if (p.kind === 'version_changed') {
        // 以目前的正本重新收尾:回到最後一個寫入步驟的交辦,重拍快照、重新核實,再重新審查
        const w = lastOf(run, x => modeOf(run, x.stepId) === 'write' && !!x.report);
        if (!w) { terminate(run, now, fx, 'halted', '版本改變,但找不到可以重新收尾的寫入步驟'); return; }
        w.snap = undefined; w.verify = undefined; w.verifyError = undefined; w.verifyCanonical = undefined; w.verifyAccepted = undefined; w.result = undefined;
        run.current = w.id;
        run.stepId = w.stepId;
        run.copy = undefined;
        run.finish = undefined;
        run.phase = 'snapshotting';
        return;
      }
      return;
    default:
      return;
  }
}

/** 下一個要喚醒狀態機(送 tick)的時間;不需要時回傳 null。 */
export function nextDeadline(run: FlowRun, now: number): number | null {
  if (run.status !== 'running') return null;
  const lim = run.flow.limits;
  const out: number[] = [now + Math.max(0, lim.maxMinutes * MIN - run.activeMs)];
  const a = currentAssignment(run);
  if (a && a.status === 'running' && !a.turnEnded && !run.ensuring) out.push(now + Math.max(0, lim.stepMinutes * MIN - run.stepActiveMs));
  if (a && run.phase === 'awaiting_report' && a.turnEnded && !a.reminded) out.push((a.turnEndedAt ?? now) + lim.reminderMinutes * MIN);
  return Math.min(...out);
}

/**
 * 主控台重開後(計畫 §3.2 第 9 點):執行中或停止中的流程改成 paused;進行中的交辦標成 interrupted;
 * 核實結果與準備好的副本丟掉(殘留副本由 FlowService 清掉)。使用者按繼續時:有回報的交辦重新收尾,沒有的重跑這一步。
 */
export function restoreAfterRestart(input: FlowRun, now: number): FlowRun {
  const run: FlowRun = structuredClone(input);
  if (isTerminal(run.status)) return run;
  const wasActive = run.status === 'running' || run.status === 'stopping';
  if (run.status === 'stopping') {
    // 停止中被關掉:行程都不在了,直接完成停止
    for (const a of run.assignments) if (isActive(a)) { a.status = run.stopTarget === 'halted' ? 'interrupted' : 'stopped'; a.endedAt ??= now; }
    run.status = run.stopTarget ?? 'stopped';
    run.inflight = null;
    run.activeSince = null;
    audit(run, now, '主控台重開:停止中的流程直接完成停止');
    return run;
  }
  for (const a of run.assignments) if (isActive(a)) { a.status = 'interrupted'; a.turnEnded = true; a.turnOutcome = 'interrupted'; a.endedAt ??= now; a.queuedId = undefined; }
  // 行程都不在了:確認結束的事一併完成
  const en = run.ensuring;
  run.ensuring = undefined;
  if (run.pending?.kind === 'not_ended') {
    run.pending = undefined;
    if (en?.purpose === 'stop') { run.status = run.stopTarget ?? 'stopped'; run.inflight = null; run.activeSince = null; audit(run, now, '主控台重開:確認結束中的停止直接完成'); return run; }
    run.status = 'paused';
    audit(run, now, '主控台重開:重跑或改派前的確認直接完成,流程改成暫停');
  }
  const cur = currentAssignment(run);
  run.inflight = null;
  run.copy = undefined;
  run.finish = undefined;
  if (cur) { cur.verify = undefined; cur.verifyError = undefined; cur.verifyCanonical = undefined; if (!cur.result) cur.snap = undefined; }
  if (run.phase === 'working' || run.phase === 'reviewing' || run.phase === 'awaiting_report') {
    if (cur?.report) { cur.status = 'reported'; run.phase = 'snapshotting'; }
    else run.phase = modeOf(run, run.stepId) === 'review' ? 'exporting_copy' : 'dispatching';
  }
  if (wasActive) run.status = 'paused';
  run.activeSince = null;
  audit(run, now, wasActive ? '主控台重開:執行中的流程改成暫停,進行中的交辦標成中斷' : '主控台重開');
  return run;
}

// ---- 畫面用的檢視 ----

function lampOf(run: FlowRun, step: FlowStepDef, attempts: RunAssignment[]): StepLamp {
  const here = run.stepId === step.id;
  if (here) {
    if (run.status === 'halted') return 'halted';
    if (run.status === 'awaiting_user') return run.pending?.kind === 'verify_blocked' ? 'blocked' : run.pending?.kind === 'step_approval' ? 'awaiting_approval' : 'awaiting_user';
    if (run.status === 'running' || run.status === 'paused' || run.status === 'stopping') {
      const last = attempts.at(-1);
      if (last && last.result === 'rejected' && run.phase !== 'dispatching' && run.phase !== 'working' && run.phase !== 'reviewing') return 'rejected';
      return 'active';
    }
  }
  const last = attempts.at(-1);
  if (!last) return 'idle';
  if (run.status === 'completed' && here && run.approvals.some(c => c.status === 'pending')) return 'awaiting_approval';
  if (last.result === 'passed') return 'passed';
  if (last.result === 'rejected') return 'rejected';
  return here && run.status === 'stopped' ? 'halted' : 'idle';
}

/** FlowRunView(畫面與 IPC 用);names 用來把節點 id 換成目前的名稱(節點改名時)。 */
export function toView(run: FlowRun, runDir = '', names: (id: string) => string | undefined = () => undefined, now = run.updatedAt): FlowRunView {
  const attempt = (a: RunAssignment): FlowAttemptView => ({
    assignmentId: a.id, stepId: a.stepId, attempt: a.attempt, agentId: a.agentId, agentName: names(a.agentId) ?? a.agentName,
    continuation: a.continuation, status: a.status, version: a.version || a.reviewedVersion || '',
    ...(a.report ? { report: a.report } : {}), ...(a.verify ? { verify: a.verify } : {}), ...(a.snap?.ignored.length ? { ignored: a.snap.ignored } : {}),
    files: [...a.files], startedAt: a.startedAt, ...(a.endedAt ? { endedAt: a.endedAt } : {}),
  });
  const steps: FlowStepView[] = run.flow.steps.map(s => {
    const list = run.assignments.filter(a => a.stepId === s.id);
    return { id: s.id, label: s.label, mode: s.mode, role: s.role, lamp: lampOf(run, s, list), attempts: list.map(attempt) };
  });
  const roles: FlowRunView['roles'] = {};
  for (const [k, v] of Object.entries(run.roles)) roles[k] = { agentId: v.agentId, name: names(v.agentId) ?? v.name };
  const activeMs = run.activeMs + (run.activeSince !== null ? Math.max(0, now - run.activeSince) : 0);
  return {
    id: run.id, flowId: run.flow.id, flowName: run.flow.name, topic: run.topic, projectId: run.projectId, cwd: run.cwd,
    status: run.status, ...(run.phase ? { phase: run.phase } : {}), stepId: run.stepId,
    rejections: run.rejections, maxRejections: run.flow.limits.maxRejections, dispatches: run.dispatches, maxDispatches: run.flow.limits.maxDispatches,
    version: run.version === run.baseVersion && !run.assignments.some(a => a.version) ? '' : run.version,
    roles, steps, ...(run.pending ? { pending: run.pending } : {}), approvals: run.approvals.map(c => ({ ...c })), violations: run.violations.map(v => ({ ...v })),
    ...(run.reason ? { reason: run.reason } : {}), activeMs, viewAt: now, startedAt: run.startedAt, updatedAt: run.updatedAt, runDir,
  };
}
