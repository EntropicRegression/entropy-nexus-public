import { isAbsolute, relative, resolve } from 'node:path';
import type { ReportCommand, ReportVerdict, ScopeException, StepMode, StepReport } from '../../shared/flow.ts';

/**
 * step_report(docs/協作流程實作計畫.md §4):節點做完一步呼叫這個工具回報,主控台不解析自由文字。
 * - normalizeReport:把工具參數(snake_case,接受常見別名)正規化成 StepReport,並依步驟性質驗證。
 *   驗證不過的回報不算數(回傳 errors),節點可以修正後重送。
 * - renderReportMd:主控台依回報代寫的 md(runs/<id>/reports/<交辦>.md)。
 * 交辦是否屬於呼叫者、是否已有回報、是否遲到,由 FlowService 與狀態機判斷,不在這裡。
 */

/** 長度上限:summary 4000 字;每個項目 2000 字;每個清單 50 項。 */
export const SUMMARY_MAX = 4000;
export const ITEM_MAX = 2000;
export const LIST_MAX = 50;

/**
 * 常見的參數別名(模型偶爾把參數名稱寫成別的,實測 Codex 在 ask_node 發生過):別名 → 正式名稱。
 * 正式名稱也列在這裡(對應到自己),方便判斷哪些是認得的參數。
 */
export const REPORT_ALIASES: Record<string, string> = {
  assignment_id: 'assignment_id', assignmentId: 'assignment_id', assignment: 'assignment_id', assignment_ID: 'assignment_id', task_id: 'assignment_id',
  summary: 'summary', message: 'summary', text: 'summary', result_summary: 'summary',
  verdict: 'verdict', decision: 'verdict', review_verdict: 'verdict',
  must_fix: 'must_fix', mustFix: 'must_fix', must_fixes: 'must_fix', required_changes: 'must_fix', blocking: 'must_fix', blockers: 'must_fix', 必修: 'must_fix',
  suggestions: 'suggestions', suggestion: 'suggestions', recommendations: 'suggestions', nits: 'suggestions', 建議: 'suggestions',
  needs_ruling: 'needs_ruling', needsRuling: 'needs_ruling', rulings: 'needs_ruling', needs_decision: 'needs_ruling', 需裁示: 'needs_ruling',
  commands_run: 'commands_run', commandsRun: 'commands_run', commands: 'commands_run', commands_executed: 'commands_run',
  not_verified: 'not_verified', notVerified: 'not_verified', unverified: 'not_verified', not_tested: 'not_verified',
  questions: 'questions', question: 'questions', open_questions: 'questions',
  scope_exceptions: 'scope_exceptions', scopeExceptions: 'scope_exceptions', out_of_scope: 'scope_exceptions', exceptions: 'scope_exceptions',
};

/** 審查專用的欄位:實作步驟不接受。 */
const REVIEW_FIELDS = ['verdict', 'must_fix', 'suggestions', 'needs_ruling'];

const VERDICT_ALIASES: Record<string, ReportVerdict> = {
  mergeable: 'mergeable', merge: 'mergeable', approve: 'mergeable', approved: 'mergeable', pass: 'mergeable', passed: 'mergeable', ok: 'mergeable', lgtm: 'mergeable', 可合併: 'mergeable', 通過: 'mergeable',
  changes_required: 'changes_required', changes_requested: 'changes_required', request_changes: 'changes_required', needs_changes: 'changes_required', reject: 'changes_required', rejected: 'changes_required', fail: 'changes_required', 需修正: 'changes_required', 退回: 'changes_required',
};

export interface NormalizeOptions {
  mode: StepMode;
  /** repo 根目錄(scope_exceptions 的路徑正規化成相對於它的路徑)。 */
  repoRoot: string;
  now?: number;
  manual?: boolean;
}

export interface NormalizeResult {
  report: StepReport | null;
  errors: string[];
  /** 不認得、已忽略的參數。 */
  ignored: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 把別名合併成正式名稱;同一個欄位有正式名稱也有別名時,正式名稱優先。 */
export function canonicalArgs(args: Obj): { args: Obj; ignored: string[] } {
  const out: Obj = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const name = REPORT_ALIASES[k];
    if (!name) { ignored.push(k); continue; }
    if (v === undefined || v === null) continue;
    if (k === name || !(name in out)) out[name] = v;
  }
  return { args: out, ignored };
}

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** 字串清單:接受單一字串(依換行切開)或陣列;陣列裡的物件取 text/item/description 之類的欄位。 */
function list(errors: string[], name: string, v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  const raw = typeof v === 'string' ? v.split(/\r?\n/).map(s => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')) : Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const x of raw) {
    const s = isObj(x) ? text(x.text ?? x.item ?? x.description ?? x.title ?? x.content) : text(x);
    if (!s) continue;
    if (s.length > ITEM_MAX) { errors.push(`${name}:每個項目最多 ${ITEM_MAX} 字(有一項 ${s.length} 字)`); continue; }
    out.push(s);
  }
  if (out.length > LIST_MAX) errors.push(`${name}:最多 ${LIST_MAX} 項(收到 ${out.length} 項)`);
  return out.slice(0, LIST_MAX);
}

function commands(errors: string[], v: unknown): ReportCommand[] {
  if (v === undefined || v === null || v === '') return [];
  const raw = Array.isArray(v) ? v : [v];
  const out: ReportCommand[] = [];
  for (const x of raw) {
    let c: ReportCommand;
    if (isObj(x)) c = { command: text(x.command ?? x.cmd ?? x.run), result: text(x.result ?? x.output ?? x.outcome ?? x.status) };
    else {
      // 「指令 → 結果」或「指令:結果」這種一行寫法
      const s = text(x);
      const m = /^(.*?)\s*(?:→|->|=>)\s*(.*)$/.exec(s);
      c = m ? { command: m[1].trim(), result: m[2].trim() } : { command: s, result: '' };
    }
    if (!c.command) continue;
    if (c.command.length > ITEM_MAX || c.result.length > ITEM_MAX) { errors.push(`commands_run:每個項目最多 ${ITEM_MAX} 字`); continue; }
    out.push(c);
  }
  if (out.length > LIST_MAX) errors.push(`commands_run:最多 ${LIST_MAX} 項(收到 ${out.length} 項)`);
  return out.slice(0, LIST_MAX);
}

/**
 * scope_exceptions 的路徑正規化成 repo 相對路徑(斜線統一成 /);指到 repo 外面的拒收。
 * 絕對路徑必須在 repoRoot 底下;相對路徑以 repoRoot 為基準解析。
 */
export function normalizeRepoPath(p: string, repoRoot: string): string | null {
  const s = p.trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  const abs = isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) ? resolve(s) : resolve(repoRoot, s);
  let rel = relative(resolve(repoRoot), abs);
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(rel)) return null;
  rel = rel.replace(/\\/g, '/');
  if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

function exceptions(errors: string[], v: unknown, repoRoot: string): ScopeException[] {
  if (v === undefined || v === null || v === '') return [];
  const raw = Array.isArray(v) ? v : [v];
  const out: ScopeException[] = [];
  for (const x of raw) {
    const path = isObj(x) ? text(x.path ?? x.file) : text(x);
    const reason = isObj(x) ? text(x.reason ?? x.why ?? x.note) : '';
    if (!path) continue;
    const rel = normalizeRepoPath(path, repoRoot);
    if (!rel) { errors.push(`scope_exceptions:「${path}」不在專案資料夾裡`); continue; }
    if (!reason) { errors.push(`scope_exceptions:「${rel}」要寫原因(reason)`); continue; }
    if (reason.length > ITEM_MAX) { errors.push(`scope_exceptions:「${rel}」的原因最多 ${ITEM_MAX} 字`); continue; }
    out.push({ path: rel, reason });
  }
  if (out.length > LIST_MAX) errors.push(`scope_exceptions:最多 ${LIST_MAX} 項(收到 ${out.length} 項)`);
  return out.slice(0, LIST_MAX);
}

/**
 * 正規化並驗證一份 step_report。規則(計畫 §4):
 * assignment_id、summary 必填;write 步驟不接受審查欄位;review 步驟必填 verdict,
 * mergeable 不能有必修、changes_required 必須有必修;長度上限;scope_exceptions 的路徑不能指到 repo 外面。
 */
export function normalizeReport(input: unknown, o: NormalizeOptions): NormalizeResult {
  const errors: string[] = [];
  if (!isObj(input)) return { report: null, errors: ['參數必須是物件'], ignored: [] };
  const { args, ignored } = canonicalArgs(input);
  const assignmentId = text(args.assignment_id);
  if (!assignmentId) errors.push('assignment_id:必填(主控台交辦裡給的交辦編號)');
  const summary = text(args.summary);
  if (!summary) errors.push('summary:必填(這一步做了什麼、結果如何)');
  else if (summary.length > SUMMARY_MAX) errors.push(`summary:最多 ${SUMMARY_MAX} 字(收到 ${summary.length} 字)`);

  const mustFix = list(errors, 'must_fix', args.must_fix);
  const suggestions = list(errors, 'suggestions', args.suggestions);
  const needsRuling = list(errors, 'needs_ruling', args.needs_ruling);
  let verdict: ReportVerdict | undefined;
  if (args.verdict !== undefined && text(args.verdict)) {
    const v = text(args.verdict);
    verdict = VERDICT_ALIASES[v] ?? VERDICT_ALIASES[v.toLowerCase()];
    if (!verdict) errors.push(`verdict:只能是 mergeable(可合併)或 changes_required(需修正),收到「${v}」`);
  }

  if (o.mode === 'write') {
    const used = REVIEW_FIELDS.filter(f => (f === 'verdict' ? args.verdict !== undefined && text(args.verdict) : (f === 'must_fix' ? mustFix : f === 'suggestions' ? suggestions : needsRuling).length));
    if (used.length) errors.push(`實作步驟不接受審查欄位:${used.join('、')}(要請使用者裁示的事請寫在 questions)`);
  } else {
    if (!verdict && !errors.some(e => e.startsWith('verdict'))) errors.push('verdict:審查步驟必填(mergeable 或 changes_required)');
    if (verdict === 'mergeable' && mustFix.length) errors.push('verdict 是 mergeable(可合併)時不能有 must_fix;有必修請改成 changes_required');
    if (verdict === 'changes_required' && !mustFix.length) errors.push('verdict 是 changes_required(需修正)時 must_fix 至少要有一項');
  }

  const report: StepReport = {
    assignmentId,
    summary,
    ...(o.mode === 'review' && verdict ? { verdict } : {}),
    mustFix: o.mode === 'review' ? mustFix : [],
    suggestions: o.mode === 'review' ? suggestions : [],
    needsRuling: o.mode === 'review' ? needsRuling : [],
    commandsRun: commands(errors, args.commands_run),
    notVerified: list(errors, 'not_verified', args.not_verified),
    questions: list(errors, 'questions', args.questions),
    scopeExceptions: exceptions(errors, args.scope_exceptions, o.repoRoot),
    receivedAt: o.now ?? Date.now(),
    ...(o.manual ? { manual: true } : {}),
  };
  return errors.length ? { report: null, errors, ignored } : { report, errors: [], ignored };
}

export interface ReportMdContext {
  flowName: string;
  topic: string;
  stepLabel: string;
  stepId: string;
  mode: StepMode;
  attempt: number;
  agentName: string;
  continuation: 'continued' | 'new';
  /** 這一步交出(或審查)的版本;還沒拍快照時為空字串。 */
  version: string;
}

const bullets = (xs: string[]) => (xs.length ? xs.map(x => `- ${x.replace(/\r?\n/g, '\n  ')}`).join('\n') : '- (無)');

/** 主控台依 step_report 代寫的 md(審查文件也是這樣產生,節點不必自己寫檔)。 */
export function renderReportMd(r: StepReport, c: ReportMdContext): string {
  const when = new Date(r.receivedAt).toISOString().replace('T', ' ').slice(0, 19);
  const lines = [
    `# ${c.flowName}:${c.stepLabel}(第 ${c.attempt} 次)`,
    '',
    `- 主題:${c.topic.split(/\r?\n/)[0].slice(0, 200)}`,
    `- 步驟:${c.stepId}(${c.mode === 'review' ? '隔離審查' : '寫入'})`,
    `- 承辦:${c.agentName}(${c.continuation === 'continued' ? '延續原 session' : '新的 session'})`,
    `- 交辦:${r.assignmentId}`,
    `- 版本:${c.version || '(尚未拍快照)'}`,
    `- 回報時間:${when}(UTC)${r.manual ? ',使用者手動補報' : ''}`,
  ];
  if (c.mode === 'review') lines.push(`- 結論:${r.verdict === 'mergeable' ? '可合併' : r.verdict === 'changes_required' ? '需修正' : '(未填)'}`);
  lines.push('', '## 摘要', '', r.summary);
  if (c.mode === 'review') {
    lines.push('', '## 必修', '', bullets(r.mustFix), '', '## 建議', '', bullets(r.suggestions), '', '## 需裁示', '', bullets(r.needsRuling));
  }
  lines.push('', '## 實際跑過的指令', '', r.commandsRun.length ? r.commandsRun.map(x => `- \`${x.command.replace(/`/g, "'")}\`${x.result ? `:${x.result}` : ''}`).join('\n') : '- (無)');
  lines.push('', '## 沒驗證到的事', '', bullets(r.notVerified));
  lines.push('', '## 請使用者裁示的問題', '', bullets(r.questions));
  lines.push('', '## 範圍外的檔案與原因', '', r.scopeExceptions.length ? r.scopeExceptions.map(x => `- ${x.path}:${x.reason}`).join('\n') : '- (無)');
  return lines.join('\n') + '\n';
}
