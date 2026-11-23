// 驗收:協作流程的 step_report 正規化與驗證、代寫的 md(src/main/flow/report.ts),以及交辦文字(src/main/flow/prompts.ts)。
// 用法:在 app 資料夾執行 node tests/flow-report.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ITEM_MAX, LIST_MAX, normalizeRepoPath, normalizeReport, REPORT_ALIASES, renderReportMd, SUMMARY_MAX } from '../src/main/flow/report.ts';
import { reminderPrompt, reportFields, stepPrompt } from '../src/main/flow/prompts.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const ROOT = resolve(tmpdir(), 'nexus-flow-report-repo');
const W = { mode: 'write', repoRoot: ROOT, now: 1000 };
const R = { mode: 'review', repoRoot: ROOT, now: 1000 };

test('必填:assignment_id、summary', () => {
  const r = normalizeReport({}, W);
  assert.equal(r.report, null);
  assert.ok(r.errors.some(e => e.startsWith('assignment_id')));
  assert.ok(r.errors.some(e => e.startsWith('summary')));
  assert.deepEqual(normalizeReport('x', W).errors, ['參數必須是物件']);
});

test('實作步驟:正規化清單、指令、範圍外說明', () => {
  const r = normalizeReport({
    assignment_id: 'a1', summary: ' 完成 ', commands_run: [{ command: 'npm test', result: '通過' }, 'npm run typecheck → 0 錯誤', { cmd: 'x' }],
    not_verified: '- 沒跑桌面核實\n- 沒測 Windows 7', questions: ['要不要改名?'], scope_exceptions: [{ path: './docs\\a.md', reason: '補文件' }, { path: join(ROOT, 'src', 'b.ts'), reason: '型別' }],
  }, W);
  assert.deepEqual(r.errors, []);
  const x = r.report;
  assert.equal(x.summary, '完成');
  assert.deepEqual(x.commandsRun, [{ command: 'npm test', result: '通過' }, { command: 'npm run typecheck', result: '0 錯誤' }, { command: 'x', result: '' }]);
  assert.deepEqual(x.notVerified, ['沒跑桌面核實', '沒測 Windows 7']);
  assert.deepEqual(x.questions, ['要不要改名?']);
  assert.deepEqual(x.scopeExceptions, [{ path: 'docs/a.md', reason: '補文件' }, { path: 'src/b.ts', reason: '型別' }]);
  assert.equal(x.verdict, undefined);
  assert.deepEqual(x.mustFix, []);
  assert.equal(x.receivedAt, 1000);
});

test('實作步驟不接受審查欄位', () => {
  const r = normalizeReport({ assignment_id: 'a', summary: 's', verdict: 'mergeable', must_fix: ['x'] }, W);
  assert.equal(r.report, null);
  assert.ok(r.errors.some(e => e.includes('實作步驟不接受審查欄位') && e.includes('verdict') && e.includes('must_fix')));
  // 空的審查欄位不算
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', must_fix: [], suggestions: '' }, W).report);
});

test('審查步驟:verdict 必填,和必修清單要一致', () => {
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's' }, R).errors.some(e => e.startsWith('verdict')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', verdict: 'mergeable', must_fix: ['x'] }, R).errors.some(e => e.includes('不能有 must_fix')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', verdict: 'changes_required' }, R).errors.some(e => e.includes('至少要有一項')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', verdict: 'maybe' }, R).errors.some(e => e.includes('只能是 mergeable')));
  const ok = normalizeReport({ assignment_id: 'a', summary: 's', verdict: 'changes_required', must_fix: ['補測試'], suggestions: ['改名'], needs_ruling: ['範圍?'] }, R).report;
  assert.equal(ok.verdict, 'changes_required');
  assert.deepEqual([ok.mustFix, ok.suggestions, ok.needsRuling], [['補測試'], ['改名'], ['範圍?']]);
});

test('別名:參數名稱與 verdict 的常見寫法', () => {
  const r = normalizeReport({ assignmentId: 'a', message: 's', decision: 'LGTM', mustFix: [], recommendations: ['x'], commands: ['npm test'], notVerified: ['y'], scopeExceptions: [], foo: 1 }, R);
  assert.deepEqual(r.errors, []);
  assert.equal(r.report.assignmentId, 'a');
  assert.equal(r.report.verdict, 'mergeable');
  assert.deepEqual(r.report.suggestions, ['x']);
  assert.deepEqual(r.ignored, ['foo']);
  assert.equal(normalizeReport({ assignment_id: 'a', summary: 's', verdict: 'request_changes', must_fix: 'x' }, R).report.verdict, 'changes_required');
  // 正式名稱優先於別名
  assert.equal(normalizeReport({ summary: '正式', message: '別名', assignment_id: 'a' }, W).report.summary, '正式');
  for (const v of Object.values(REPORT_ALIASES)) assert.match(v, /^[a-z_]+$/);
});

test('長度上限:summary、項目、清單項數', () => {
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 'x'.repeat(SUMMARY_MAX + 1) }, W).errors.some(e => e.startsWith('summary')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', not_verified: ['x'.repeat(ITEM_MAX + 1)] }, W).errors.some(e => e.startsWith('not_verified')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', questions: Array.from({ length: LIST_MAX + 1 }, (_, i) => `q${i}`) }, W).errors.some(e => e.startsWith('questions')));
});

test('scope_exceptions:指到 repo 外面的拒收、原因必填', () => {
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', scope_exceptions: [{ path: '../outside.txt', reason: 'x' }] }, W).errors.some(e => e.includes('不在專案資料夾裡')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', scope_exceptions: [{ path: resolve(ROOT, '..', 'other', 'x.ts'), reason: 'x' }] }, W).errors.some(e => e.includes('不在專案資料夾裡')));
  assert.ok(normalizeReport({ assignment_id: 'a', summary: 's', scope_exceptions: [{ path: 'a.ts' }] }, W).errors.some(e => e.includes('要寫原因')));
  assert.equal(normalizeRepoPath('.', ROOT), null);
  assert.equal(normalizeRepoPath('src/../x.ts', ROOT), 'x.ts');
  if (process.platform === 'win32') assert.equal(normalizeRepoPath('D:\\elsewhere\\x.ts', 'C:\\repo'), null);
});

test('手動補報標記 manual', () => {
  assert.equal(normalizeReport({ assignment_id: 'a', summary: 's' }, { ...W, manual: true }).report.manual, true);
});

test('renderReportMd:審查文件含必修、建議、需裁示與版本', () => {
  const r = normalizeReport({ assignment_id: 'a1', summary: '大致可以', verdict: 'changes_required', must_fix: ['補測試'], suggestions: ['改名'], commands_run: [{ command: 'npm test', result: '通過' }], scope_exceptions: [{ path: 'docs/a.md', reason: '補文件' }] }, R).report;
  const md = renderReportMd(r, { flowName: '實作 → 審查', topic: '修正 X\n細節', stepLabel: '隔離審查', stepId: 'review', mode: 'review', attempt: 2, agentName: 'Claudia', continuation: 'continued', version: 'abc123' });
  assert.match(md, /^# 實作 → 審查:隔離審查\(第 2 次\)/);
  assert.match(md, /- 結論:需修正/);
  assert.match(md, /## 必修\n\n- 補測試/);
  assert.match(md, /## 建議\n\n- 改名/);
  assert.match(md, /## 需裁示\n\n- \(無\)/);
  assert.match(md, /`npm test`:通過/);
  assert.match(md, /- 版本:abc123/);
  assert.match(md, /- docs\/a.md:補文件/);
  assert.ok(!md.includes('細節'), '主題只取第一行');
  const w = renderReportMd(normalizeReport({ assignment_id: 'a2', summary: '完成' }, W).report, { flowName: 'F', topic: 't', stepLabel: '實作', stepId: 'implement', mode: 'write', attempt: 1, agentName: 'K', continuation: 'new', version: '' });
  assert.ok(!w.includes('## 必修'), '實作的回報沒有審查段落');
});

test('交辦文字:實作看不到審查欄位;審查有副本路徑;修正附必修、核實失敗與 diff', () => {
  const step = { id: 'implement', label: '實作', role: 'implementer', mode: 'write', verify: true, continueSession: false, requiresApproval: [], inputs: [], outputs: [] };
  const p = stepPrompt({ flowName: 'F', topic: '主題〔測試流程:x〕', step, attempt: 1, assignmentId: 'A1', continuation: 'new', cwd: 'C:/repo', allowedPaths: ['src/'], verifyCommands: ['npm test'] });
  assert.match(p, /^\(主控台:協作流程「F」的交辦。/);
  assert.match(p, /^流程步驟:implement\(第 1 次\)$/m);
  assert.match(p, /^assignment_id:A1$/m);
  assert.ok(p.includes('〔測試流程:x〕'), '主題原樣帶上');
  assert.ok(p.includes('npm test'));
  assert.ok(!p.includes('verdict') && !p.includes('must_fix'), '實作步驟看不到審查欄位');
  assert.ok(p.includes('不要 commit'));
  const review = { ...step, id: 'review', label: '隔離審查', role: 'reviewer', mode: 'review' };
  const prev = { label: '實作', agentName: 'K', report: normalizeReport({ assignment_id: 'A1', summary: '做完了' }, W).report, file: 'C:/runs/x/reports/A1.md' };
  const rp = stepPrompt({ flowName: 'F', topic: 't', step: review, attempt: 1, assignmentId: 'B1', continuation: 'new', cwd: 'C:/repo', allowedPaths: [], verifyCommands: [], copyDir: 'C:/runs/x/copies/r-1234abcd-3', version: '1234abcd9999', changed: ['src/a.ts'], prev });
  assert.match(rp, /^審查副本:C:\/runs\/x\/copies\/r-1234abcd-3$/m);
  assert.ok(rp.includes('verdict') && rp.includes('must_fix') && rp.includes('needs_ruling'));
  assert.ok(rp.includes('做完了') && rp.includes('src/a.ts'));
  const fix = { ...step, id: 'fix', label: '修正', continueSession: true };
  const mustFix = { label: '隔離審查', agentName: 'C', report: normalizeReport({ assignment_id: 'B1', summary: '要改', verdict: 'changes_required', must_fix: ['補測試'] }, R).report };
  const verify = { version: 'v', outcome: 'fail', commands: [{ id: 'unit', run: 'npm test', outcome: 'fail', exitCode: 1, ms: 1, lastLine: 'AssertionError', logFile: 'C:/l/unit.log', location: 'copy', modified: [] }], failed: ['unit'], blocked: [], modifiedBy: [], notVerified: [], modified: [], startedAt: 0, endedAt: 0 };
  const fp = stepPrompt({ flowName: 'F', topic: 't', step: fix, attempt: 1, assignmentId: 'C1', continuation: 'new', cwd: 'C:/repo', allowedPaths: [], verifyCommands: [], prev, mustFix: { from: mustFix }, verify, diff: '--- src/a.ts\n+x', rulings: ['照建議'] });
  assert.ok(fp.includes('這是新的交辦'));
  assert.ok(fp.includes('補測試') && fp.includes('AssertionError') && fp.includes('C:/l/unit.log') && fp.includes('+x') && fp.includes('照建議'));
  const rm = reminderPrompt({ flowName: 'F', step, attempt: 1, assignmentId: 'A1', topic: 't' });
  assert.match(rm, /^\(主控台:step_report 提醒。/);
  assert.match(rm, /^assignment_id:A1$/m);
  assert.equal(reportFields('write').some(l => l.includes('verdict')), false);
});

console.log(`通過 ${passed} 項`);
