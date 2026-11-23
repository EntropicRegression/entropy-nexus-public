// 驗收:協作流程的狀態機(src/main/flow/machine.ts,純邏輯)。
// 涵蓋規格「驗收」的情境(一次通過、退回一輪、退回兩輪停機、需裁示、被環境擋住、未回報、遲到回報、中途停止、版本失效、原 session 不在),
// 外加暫停、時間上限(扣掉暫停與等待使用者)、主控台重開、終止狀態不復活、commit 違規、核實失敗與核實改檔。
// 用法:在 app 資料夾執行 node tests/flow-machine.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFlow } from '../src/main/flow/definition.ts';
import { flowElapsed } from '../src/shared/flow.ts';
import { chooseFixTarget, createRun, nextDeadline, reduce, restoreAfterRestart, toView } from '../src/main/flow/machine.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

test('畫面的已用時間從 viewAt 起算(載入快照時不會把 updatedAt 之後的時間算兩次)', () => {
  // 主行程在 updatedAt=5000 之後一直執行,到 viewAt=65000 產生檢視時 activeMs 已經含這 60 秒
  const v = { status: 'running', activeMs: 60000, updatedAt: 5000, viewAt: 65000 };
  assert.equal(flowElapsed(v, 65000), 60000, '剛載入時就是 activeMs,不能變成 120 秒');
  assert.equal(flowElapsed(v, 70000), 65000, '之後每過一秒加一秒');
  assert.equal(flowElapsed({ ...v, status: 'paused' }, 99999), 60000, '暫停時不累加');
});

const TEMPLATE = parseFlow(readFileSync(new URL('../src/main/flow/templates/implement-review.yaml', import.meta.url), 'utf8'), 'builtin').flow;
assert.ok(TEMPLATE, '內建範本解析成功');
const MIN = 60000;
const V0 = '0'.repeat(40);
const v = n => String(n).padStart(40, 'a');

/**
 * 模擬 FlowService:依 effect 自動回應(交辦 → 回報與回合結束、快照、核實、匯出副本、收尾、確認結束),
 * world 決定每一步的回報、正本的版本變化與核實結果。
 */
function harness(opts = {}) {
  const flow = structuredClone(TEMPLATE);
  Object.assign(flow.limits, opts.limits ?? {});
  if (opts.noVerify) flow.verify.commands = [];
  const agents = opts.agents ?? [
    { id: 'impl', name: 'Keeper', sessionId: 's-impl', state: 'idle' },
    { id: 'rev', name: 'Claudia', sessionId: 's-rev', state: 'idle' },
  ];
  const h = {
    t: 1_000_000,
    canon: V0,
    nextVersion: 1,
    agents,
    effects: [],
    log: [],
    /** (step, attempt, assignment, reminded) → { report?, outcome?, write?, late? } */
    onTurn: opts.onTurn ?? (() => ({})),
    verify: opts.verify ?? (() => 'pass'),
    refsChanged: opts.refsChanged ?? (() => []),
    hold: new Set(opts.hold ?? []),
    run: createRun({
      id: 'r1234567', flow, topic: '測試主題', projectId: 'p', projectName: 'P', cwd: 'C:/repo', repoRoot: 'C:/repo',
      roles: { implementer: { agentId: 'impl', name: 'Keeper' }, reviewer: { agentId: 'rev', name: 'Claudia' } },
      roleHints: opts.roleHints ?? {}, baseVersion: V0,
    }, 1_000_000),
  };
  h.apply = (ev, dt = 10) => {
    h.t += dt;
    const r = reduce(h.run, ev, h.t);
    h.run = r.run;
    h.effects.push(...r.effects);
    h.log.push(...r.effects);
    return r.effects;
  };
  h.a = id => h.run.assignments.find(a => a.id === id);
  h.report = (a, extra = {}) => ({
    assignmentId: a.id, summary: '完成', mustFix: [], suggestions: [], needsRuling: [], commandsRun: [], notVerified: [], questions: [], scopeExceptions: [], receivedAt: h.t,
    ...(a.stepId === 'review' ? { verdict: 'mergeable' } : {}), ...extra,
  });
  h.turn = (a, reminded) => {
    const step = a.stepId;
    const res = h.onTurn(step, a.attempt, a, reminded, h) ?? {};
    h.apply({ type: 'task_started', assignmentId: a.id, taskId: `${a.id}-t${reminded ? 2 : 1}` });
    if (res.write !== false && !reminded && TEMPLATE.steps.find(s => s.id === step).mode === 'write') h.canon = v(h.nextVersion++);
    if (res.report) h.apply({ type: 'report', assignmentId: a.id, report: h.report(a, res.report === true ? {} : res.report) });
    if (res.hold) return; // 回合不結束(測試停止、暫停)
    const agent = h.agents.find(x => x.id === a.agentId);
    h.apply({ type: 'turn_ended', assignmentId: a.id, taskId: `${a.id}-t${reminded ? 2 : 1}`, outcome: res.outcome ?? 'done', sessionId: agent?.sessionId ?? null });
  };
  /** 依序處理 effect,直到沒有可處理的(hold 裡的 effect 種類先不處理)。 */
  h.pump = (max = 200) => {
    for (let i = 0; i < max && h.effects.length; i++) {
      const e = h.effects.shift();
      if (h.hold.has(e.type)) { h.held = (h.held ?? []).concat(e); continue; }
      switch (e.type) {
        case 'pick_agent': h.apply({ type: 'agents', token: e.token, agents: h.agents }); break;
        case 'dispatch': {
          h.apply({ type: 'dispatched', assignmentId: e.assignmentId, queuedId: `q-${e.assignmentId}`, refsBefore: { symbolic: 'refs/heads/main', head: 'h0', refs: {} } });
          h.turn(h.a(e.assignmentId), false);
          break;
        }
        case 'remind': h.turn(h.a(e.assignmentId), true); break;
        case 'snapshot': {
          const a = h.a(e.assignmentId);
          h.apply({ type: 'snapshot_done', token: e.token, snap: { version: h.canon, refsChanged: h.refsChanged(a), ignored: [], changed: ['src/a.ts'], outOfScope: [], unexplained: [], copyWritten: [] } });
          break;
        }
        case 'verify': {
          const a = h.a(e.assignmentId);
          const outcome = h.verify(a, h);
          const cmd = { id: 'unit', run: 'npm test', outcome: outcome === 'modified' ? 'pass' : outcome, exitCode: outcome === 'pass' ? 0 : 1, ms: 1, lastLine: 'x', logFile: '', location: 'copy', modified: outcome === 'modified' ? ['src/gen.ts'] : [] };
          const result = { version: e.version, outcome, commands: [cmd], stuckAt: ['blocked', 'timeout'].includes(outcome) ? 'unit' : undefined, failed: outcome === 'fail' ? ['unit'] : [], blocked: outcome === 'blocked' ? ['unit'] : [], modifiedBy: outcome === 'modified' ? ['unit'] : [], notVerified: [], modified: cmd.modified, startedAt: h.t, endedAt: h.t };
          h.apply({ type: 'verify_done', token: e.token, result, canonical: h.canon });
          break;
        }
        case 'export_copy': h.apply({ type: 'copy_ready', token: e.token, dir: `C:/runs/copies/r-${e.version.slice(0, 8)}`, canonical: h.canon }); break;
        case 'finish': h.apply({ type: 'finish_done', token: e.token, canonical: h.canon, paths: ['src/a.ts', 'notes.txt'], outOfScope: ['notes.txt'] }); break;
        case 'ensure_ended': h.apply({ type: 'ended', token: e.token }); break;
        default: break;
      }
    }
  };
  h.start = () => { h.apply({ type: 'start' }); h.pump(); return h; };
  h.byStep = step => h.run.assignments.filter(a => a.stepId === step);
  h.kinds = () => h.log.map(e => e.type);
  return h;
}

// ---- 規格「驗收」 ----

test('一次通過:實作 → 核實 → 隔離審查可合併 → 走完並產生 commit 授權卡', () => {
  const h = harness({ onTurn: () => ({ report: true }) }).start();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.run.rejections, 0);
  assert.deepEqual(h.run.assignments.map(a => a.stepId), ['implement', 'review']);
  const [impl, rev] = h.run.assignments;
  assert.equal(impl.status, 'reported');
  assert.equal(impl.result, 'passed');
  assert.equal(rev.reviewedVersion, impl.version, '審查的是實作交出的版本');
  assert.equal(rev.context.reportFrom, impl.id, '審查讀實作者的回報檔');
  assert.equal(h.run.approvals.length, 1);
  const card = h.run.approvals[0];
  assert.equal(card.action, 'commit');
  assert.equal(card.version, h.canon);
  assert.deepEqual(card.paths, ['src/a.ts'], '範圍外的檔案預設不納入');
  assert.deepEqual(card.outOfScope, ['notes.txt']);
  assert.ok(card.excludes.includes('push'), '卡片寫明不涵蓋 push');
  assert.ok(h.kinds().includes('cleanup'));
  assert.ok(h.log.some(e => e.type === 'notify' && e.kind === 'completed'));
  const view = toView(h.run, 'C:/runs/r1234567');
  assert.equal(view.steps.find(s => s.id === 'review').lamp, 'awaiting_approval');
  assert.equal(view.steps.find(s => s.id === 'implement').lamp, 'passed');
  assert.equal(toView(h.run, '', () => undefined, h.run.updatedAt + 5000).viewAt, h.run.updatedAt + 5000, '檢視記下產生的時間(畫面只從這裡往後累加)');
});

test('退回一輪後通過:必修退回原 session 修正,再複審', () => {
  const h = harness({ onTurn: (step, n) => (step === 'review' && n === 1 ? { report: { verdict: 'changes_required', mustFix: ['改 A'] } } : { report: true }) }).start();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.run.rejections, 1);
  assert.deepEqual(h.run.assignments.map(a => `${a.stepId}#${a.attempt}`), ['implement#1', 'review#1', 'fix#1', 'review#2']);
  const fix = h.byStep('fix')[0];
  assert.equal(fix.agentId, 'impl');
  assert.equal(fix.continuation, 'continued', '原 session 沒變 → 延續');
  assert.equal(fix.context.mustFixFrom, h.byStep('review')[0].id);
  assert.equal(fix.context.diff, undefined, '延續原 session 時不附 diff');
  assert.equal(h.byStep('review')[1].continuation, 'continued');
});

test('退回兩輪後停機:第 3 輪還有必修就停機,不再交辦', () => {
  const h = harness({ onTurn: step => (step === 'review' ? { report: { verdict: 'changes_required', mustFix: ['還是不行'] } } : { report: true }) }).start();
  assert.equal(h.run.status, 'halted');
  assert.equal(h.run.rejections, 2);
  assert.match(h.run.reason, /上限/);
  assert.deepEqual(h.run.assignments.map(a => `${a.stepId}#${a.attempt}`), ['implement#1', 'review#1', 'fix#1', 'review#2', 'fix#2', 'review#3']);
  assert.ok(h.log.some(e => e.type === 'notify' && e.kind === 'halted'), '停機通知總管');
});

test('需裁示不計入退回輪數:交給使用者,選繼續後走完', () => {
  const h = harness({ onTurn: step => (step === 'review' ? { report: { needsRuling: ['要不要改名?'] } } : { report: true }) }).start();
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.kind, 'needs_ruling');
  assert.equal(h.run.rejections, 0);
  assert.ok(h.log.some(e => e.type === 'notify' && e.kind === 'needs_user'));
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'continue', note: '照建議' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.run.rejections, 0);
});

test('被環境擋住不計入退回輪數:交給使用者,重跑核實通過後繼續', () => {
  let calls = 0;
  const h = harness({ onTurn: () => ({ report: true }), verify: () => (calls++ === 0 ? 'blocked' : 'pass') }).start();
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.kind, 'verify_blocked');
  assert.equal(h.run.rejections, 0);
  assert.equal(h.byStep('fix').length, 0, '沒有退回實作者');
  assert.equal(toView(h.run).steps.find(s => s.id === 'implement').lamp, 'blocked');
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'rerun' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.run.rejections, 0);
  assert.equal(calls, 2);
});

test('逾時、核實改到檔案也不計輪數;核實失敗才計一輪並退回', () => {
  const t = harness({ onTurn: () => ({ report: true }), verify: () => 'timeout' }).start();
  assert.equal(t.run.pending.kind, 'verify_timeout');
  assert.equal(t.run.rejections, 0);
  const m = harness({ onTurn: () => ({ report: true }), verify: () => 'modified' }).start();
  assert.equal(m.run.pending.kind, 'verify_modified');
  assert.equal(m.run.rejections, 0);
  assert.ok(m.run.violations.some(x => x.kind === 'verify_modified'));
  m.apply({ type: 'decide', decisionId: m.run.pending.id, choice: 'continue' });
  m.pump();
  assert.equal(m.run.status, 'completed');
  let n = 0;
  const f = harness({ onTurn: () => ({ report: true }), verify: () => (n++ === 0 ? 'fail' : 'pass') }).start();
  assert.equal(f.run.status, 'completed');
  assert.equal(f.run.rejections, 1);
  const fix = f.byStep('fix')[0];
  assert.equal(fix.context.verifyFrom, f.byStep('implement')[0].id, '修正交辦附上核實失敗的結果');
});

test('未回報:回合結束先等提醒時間,提醒一次;仍沒回報 → 交使用者(不計輪數),可手動補報', () => {
  const h = harness({ onTurn: (step, n, a, reminded) => (step === 'implement' && n === 1 ? {} : { report: true }) }).start();
  const a = h.byStep('implement')[0];
  assert.equal(h.run.phase, 'awaiting_report');
  assert.equal(a.status, 'awaiting_report');
  assert.ok(!h.kinds().includes('remind'), '還沒到提醒時間');
  assert.equal(nextDeadline(h.run, h.t), a.turnEndedAt + 10 * MIN, '下一次喚醒是提醒時間');
  h.apply({ type: 'tick' }, 10 * MIN);
  assert.equal(h.kinds().filter(k => k === 'remind').length, 1, '提醒一次');
  h.pump();
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.kind, 'unreported');
  assert.equal(h.a(a.id).status, 'unreported');
  assert.equal(h.run.rejections, 0);
  assert.equal(h.kinds().filter(k => k === 'remind').length, 1, '只提醒一次');
  assert.deepEqual(h.run.pending.options, ['manual_report', 'rerun', 'halt', 'stop']);
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'manual_report', report: h.report(a, { summary: '使用者補報' }) });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.a(a.id).report.manual, true);
});

test('遲到回報不推進:卡在未回報時只預填;重跑後舊交辦的回報寫進 late/', () => {
  const h = harness({ limits: { reminderMinutes: 1 }, onTurn: (step, n) => (step === 'implement' && n === 1 ? {} : { report: true }), hold: ['dispatch'] }).start();
  // 先讓第一次交辦跑完(沒回報),第二次交辦(重跑)先擋住
  const first = h.held.shift();
  h.apply({ type: 'dispatched', assignmentId: first.assignmentId, queuedId: 'q1' });
  h.turn(h.a(first.assignmentId), false);
  h.apply({ type: 'tick' }, MIN);
  h.pump();
  assert.equal(h.run.pending.kind, 'unreported');
  const old = h.a(first.assignmentId);
  const before = h.log.length;
  h.apply({ type: 'report', assignmentId: old.id, report: h.report(old, { summary: '遲到' }) });
  const late = h.log.slice(before);
  assert.ok(late.some(e => e.type === 'write_late'), '寫進 late/');
  assert.ok(!late.some(e => e.type === 'snapshot'), '沒有推進');
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.prefill.summary, '遲到', '預填在手動補報欄位');
  assert.equal(h.a(old.id).report, undefined);
  // 使用者選重跑;舊交辦再送一次也只寫 late
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'rerun' });
  h.pump();
  const second = h.held.shift();
  assert.ok(second && second.assignmentId !== old.id);
  h.apply({ type: 'dispatched', assignmentId: second.assignmentId, queuedId: 'q2' });
  h.apply({ type: 'task_started', assignmentId: second.assignmentId, taskId: 't2' });
  const b2 = h.log.length;
  h.apply({ type: 'report', assignmentId: old.id, report: h.report(old, { summary: '又遲到' }) });
  assert.ok(h.log.slice(b2).some(e => e.type === 'write_late'));
  assert.equal(h.run.current, second.assignmentId, '目前的交辦沒變');
  assert.equal(h.a(second.assignmentId).status, 'running');
  h.hold.clear();
  h.apply({ type: 'report', assignmentId: second.assignmentId, report: h.report(h.a(second.assignmentId)) });
  h.canon = v(99);
  h.apply({ type: 'turn_ended', assignmentId: second.assignmentId, taskId: 't2', outcome: 'done', sessionId: 's-impl' });
  h.pump();
  assert.equal(h.run.status, 'completed');
});

test('同一個交辦重送只記第一次', () => {
  const h = harness({ onTurn: () => ({ report: true, hold: true }) }).start();
  const a = h.byStep('implement')[0];
  const fx = h.apply({ type: 'report', assignmentId: a.id, report: h.report(a, { summary: '第二次' }) });
  assert.ok(fx.some(e => e.type === 'report_ignored'));
  assert.equal(h.a(a.id).report.summary, '完成');
});

test('中途停止後不復活:先確認交辦結束才停止;之後的回報、決定、繼續都不處理', () => {
  const h = harness({ onTurn: () => ({ hold: true }) }).start();
  const a = h.byStep('implement')[0];
  assert.equal(h.a(a.id).status, 'running');
  const fx = h.apply({ type: 'stop' });
  assert.equal(h.run.status, 'stopping');
  const ensure = fx.find(e => e.type === 'ensure_ended');
  assert.deepEqual(ensure.assignmentIds, [a.id], '停止前先確認原交辦結束');
  h.apply({ type: 'turn_ended', assignmentId: a.id, taskId: 't', outcome: 'interrupted', sessionId: 's-impl' });
  assert.equal(h.run.status, 'stopping', '回合結束不等於確認完成');
  h.apply({ type: 'ended', token: ensure.token });
  assert.equal(h.run.status, 'stopped');
  assert.equal(h.a(a.id).status, 'stopped');
  const after = h.log.length;
  h.apply({ type: 'report', assignmentId: a.id, report: h.report(a) });
  h.apply({ type: 'resume' });
  h.apply({ type: 'tick' }, 999 * MIN);
  h.apply({ type: 'decide', decisionId: 'd1', choice: 'rerun' });
  h.apply({ type: 'start' });
  const later = h.log.slice(after);
  assert.equal(h.run.status, 'stopped');
  assert.ok(later.some(e => e.type === 'write_late'), '遲到的回報寫進 late/');
  assert.ok(!later.some(e => ['pick_agent', 'dispatch', 'snapshot', 'verify'].includes(e.type)), '沒有任何新的工作');
  assert.equal(h.a(a.id).report, undefined);
});

test('審查後同一份正本又被改:版本失效,交使用者;選繼續後重新核實、重新審查', () => {
  const h = harness({
    onTurn: (step, n, a, r, hh) => {
      if (step === 'review' && n === 1) { hh.canon = v(500); } // 審查期間正本被改
      return { report: true };
    },
  }).start();
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.kind, 'version_changed');
  assert.equal(h.run.reviewedVersion, undefined, '審查失效');
  assert.equal(h.run.verifiedVersion, undefined, '核實失效');
  assert.equal(h.run.rejections, 0);
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'continue' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.byStep('review').length, 2, '重新審查');
  assert.equal(h.byStep('review')[1].reviewedVersion, v(500));
  assert.equal(h.run.approvals[0].version, v(500));
});

test('核實期間正本被改也算版本失效;收尾時的授權卡跟著失效', () => {
  const h = harness({ onTurn: () => ({ report: true }), verify: (a, hh) => { hh.canon = v(777); return 'pass'; } }).start();
  assert.equal(h.run.pending.kind, 'version_changed');
  const c = structuredClone(h.run);
  c.approvals.push({ id: 'x', action: 'commit', version: V0, covers: [], excludes: [], paths: [], outOfScope: [], status: 'pending', createdAt: 0 });
  c.status = 'running'; c.pending = undefined; c.phase = 'exporting_copy'; c.inflight = null;
  const r = reduce(c, { type: 'tick' }, h.t + 1);
  const ex = r.effects.find(e => e.type === 'export_copy');
  const r2 = reduce(r.run, { type: 'copy_ready', token: ex.token, dir: 'C:/x/r-12345678', canonical: v(888) }, h.t + 2);
  assert.equal(r2.run.pending.kind, 'version_changed');
  assert.equal(r2.run.approvals[0].status, 'expired', '授權失效');
});

test('原 session 不在了:修正交給同名的新節點(新 session),交辦附上回報、必修與 diff', () => {
  const h = harness({
    onTurn: (step, n, a, r, hh) => {
      if (step === 'review' && n === 1) {
        hh.agents = [{ id: 'impl2', name: 'Keeper', sessionId: 's-new', state: 'idle' }, hh.agents[1]];
        return { report: { verdict: 'changes_required', mustFix: ['補測試'] } };
      }
      return { report: true };
    },
  }).start();
  assert.equal(h.run.status, 'completed');
  const fix = h.byStep('fix')[0];
  assert.equal(fix.agentId, 'impl2');
  assert.equal(fix.continuation, 'new');
  assert.equal(fix.context.mustFixFrom, h.byStep('review')[0].id);
  assert.ok(fix.context.reportFrom, '附上前一份 step_report');
  assert.deepEqual(fix.context.diff, { base: V0, end: h.byStep('review')[0].reviewedVersion }, '附上相對交審版本的 diff');
});

test('chooseFixTarget:session 沒變延續、換了開新、依角色對照或同名、找不到請使用者指定', () => {
  const agents = [{ id: 'a', name: 'Keeper', sessionId: 's1', state: 'sleeping' }, { id: 'b', name: 'Other', sessionId: 's2', state: 'idle' }];
  const o = { agentId: 'a', name: 'Keeper', sessionAtEnd: 's1' };
  assert.deepEqual(chooseFixTarget({ original: o, agents }), { kind: 'continue', agentId: 'a', wake: true, reason: '送回原 session' });
  assert.equal(chooseFixTarget({ original: { ...o, sessionAtEnd: 's0' }, agents }).kind, 'new');
  assert.equal(chooseFixTarget({ original: { ...o, agentId: 'gone' }, agents, roleHint: 'Other' }).agentId, 'b');
  assert.equal(chooseFixTarget({ original: { ...o, agentId: 'gone' }, agents, roleHint: 'b' }).agentId, 'b');
  assert.equal(chooseFixTarget({ original: { ...o, agentId: 'gone' }, agents }).agentId, 'a', '同名');
  const none = chooseFixTarget({ original: { agentId: 'gone', name: 'Nobody', sessionAtEnd: 's' }, agents });
  assert.equal(none.kind, 'need_user');
  assert.equal(none.candidates.length, 2);
});

test('找不到接手的節點:請使用者指定,改派後繼續', () => {
  const h = harness({
    onTurn: (step, n, a, r, hh) => {
      if (step === 'review' && n === 1) { hh.agents = [hh.agents[1], { id: 'z', name: 'Zed', sessionId: 'sz', state: 'idle' }]; return { report: { verdict: 'changes_required', mustFix: ['x'] } }; }
      return { report: true };
    },
  }).start();
  assert.equal(h.run.pending.kind, 'need_agent');
  assert.equal(h.run.pending.assignmentId, undefined, '不掛在上一步的交辦上');
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'reassign', agentId: 'z', agentName: 'Zed' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.byStep('fix')[0].agentId, 'z');
  assert.equal(h.run.roles.implementer.agentId, 'z');
});

test('節點自己 commit:refs 改變 → 標違規並停機', () => {
  const h = harness({ onTurn: () => ({ report: true }), refsChanged: a => (a.stepId === 'implement' ? ['HEAD', 'refs/heads/main'] : []) }).start();
  assert.equal(h.run.status, 'halted');
  assert.match(h.run.reason, /commit 或 push/);
  const viol = h.run.violations.find(x => x.kind === 'refs_changed');
  assert.deepEqual(viol.items, ['HEAD', 'refs/heads/main']);
  assert.equal(h.byStep('review').length, 0);
});

test('節點出錯:交給使用者(不計輪數),可以重跑', () => {
  let first = true;
  const h = harness({ onTurn: step => { if (step === 'implement' && first) { first = false; return { outcome: 'failed' }; } return { report: true }; } }).start();
  assert.equal(h.run.pending.kind, 'agent_error');
  assert.equal(h.run.rejections, 0);
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'rerun' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.byStep('implement').length, 2);
});

test('暫停:回報與回合結束照樣記下,但不往下走;繼續後才收尾', () => {
  const h = harness({ onTurn: () => ({ hold: true }) }).start();
  const a = h.byStep('implement')[0];
  h.apply({ type: 'pause' });
  assert.equal(h.run.status, 'paused');
  h.apply({ type: 'report', assignmentId: a.id, report: h.report(a) });
  const fx = h.apply({ type: 'turn_ended', assignmentId: a.id, taskId: 't', outcome: 'done', sessionId: 's-impl' });
  assert.ok(!fx.some(e => e.type === 'snapshot'), '暫停中不收尾');
  assert.equal(nextDeadline(h.run, h.t), null, '暫停中不計時');
  const fx2 = h.apply({ type: 'resume' });
  assert.ok(fx2.some(e => e.type === 'snapshot'), '繼續後收尾');
});

test('時間上限扣掉暫停與等待使用者;超過就停機', () => {
  const h = harness({ limits: { maxMinutes: 10, stepMinutes: 100 }, onTurn: () => ({ hold: true }) }).start();
  h.apply({ type: 'pause' }, 4 * MIN);           // 執行 4 分鐘後暫停
  h.apply({ type: 'resume' }, 60 * MIN);         // 暫停 60 分鐘不算
  assert.ok(h.run.activeMs >= 4 * MIN && h.run.activeMs < 5 * MIN, `activeMs=${h.run.activeMs}`);
  h.apply({ type: 'tick' }, 5 * MIN);
  assert.equal(h.run.status, 'running', '9 分鐘還沒到上限');
  h.apply({ type: 'tick' }, 2 * MIN);
  assert.equal(h.run.status, 'stopping', '超過 10 分鐘 → 先確認交辦結束再停機');
  const ensure = h.log.filter(e => e.type === 'ensure_ended').at(-1);
  h.apply({ type: 'ended', token: ensure.token });
  assert.equal(h.run.status, 'halted');
  assert.match(h.run.reason, /時間上限/);
  // 等待使用者的時間也不算
  const w = harness({ limits: { maxMinutes: 10 }, onTurn: step => (step === 'review' ? { report: { needsRuling: ['?'] } } : { report: true }) }).start();
  const used = w.run.activeMs;
  w.apply({ type: 'tick' }, 120 * MIN);
  assert.equal(w.run.status, 'awaiting_user');
  assert.equal(w.run.activeMs, used, '等待使用者不計時');
});

test('單步時間上限:中斷並交給使用者,可以重跑', () => {
  const h = harness({ limits: { stepMinutes: 5 }, onTurn: () => ({ hold: true }) }).start();
  const fx = h.apply({ type: 'tick' }, 6 * MIN);
  assert.ok(fx.some(e => e.type === 'ensure_ended'));
  assert.equal(h.run.pending.kind, 'limit');
});

test('交辦次數上限:超過就停機', () => {
  const h = harness({ limits: { maxDispatches: 2 }, onTurn: step => (step === 'review' ? { report: { verdict: 'changes_required', mustFix: ['x'] } } : { report: true }) }).start();
  assert.equal(h.run.status, 'halted');
  assert.match(h.run.reason, /交辦次數/);
});

test('主控台重開:執行中改成暫停、進行中的交辦標成中斷、核實結果丟掉;繼續時重跑這一步', () => {
  const h = harness({ onTurn: () => ({ hold: true }) }).start();
  const a = h.byStep('implement')[0];
  const r = restoreAfterRestart(h.run, h.t + 1000);
  assert.equal(r.status, 'paused');
  assert.equal(r.assignments[0].status, 'interrupted');
  assert.equal(r.inflight, null);
  assert.equal(r.activeSince, null);
  assert.equal(r.phase, 'dispatching');
  const res = reduce(r, { type: 'resume' }, h.t + 2000);
  assert.ok(res.effects.some(e => e.type === 'pick_agent'), '繼續時重新交辦');
  // 已經有回報的交辦:繼續時重新收尾
  const h2 = harness({ onTurn: () => ({ report: true, hold: true }) }).start();
  const r2 = restoreAfterRestart(h2.run, h2.t + 1);
  assert.equal(r2.phase, 'snapshotting');
  assert.equal(r2.assignments[0].status, 'reported');
  // 核實中重開:結果丟掉,繼續時重跑核實
  const h3 = harness({ onTurn: () => ({ report: true }), hold: ['verify'] }).start();
  assert.equal(h3.run.phase, 'verifying');
  const r3 = restoreAfterRestart(h3.run, h3.t + 1);
  assert.equal(r3.status, 'paused');
  const res3 = reduce(r3, { type: 'resume' }, h3.t + 2);
  assert.ok(res3.effects.some(e => e.type === 'verify'));
  // 舊的核實結果回來也不採用(token 不符)
  const stale = reduce(res3.run, { type: 'verify_done', token: h3.held[0].token, canonical: h3.canon, result: { outcome: 'fail' } }, h3.t + 3);
  assert.equal(stale.run.assignments[0].verify, undefined);
  // 停止中被關掉:直接完成停止;終止狀態不變
  const s = harness({ onTurn: () => ({ hold: true }) }).start();
  s.apply({ type: 'stop' });
  assert.equal(restoreAfterRestart(s.run, s.t).status, 'stopped');
  const done = harness({ onTurn: () => ({ report: true }) }).start();
  assert.equal(restoreAfterRestart(done.run, done.t).status, 'completed');
  void a;
});

test('走完之後:回報寫 late、決定不處理;授權卡結果照常更新', () => {
  const h = harness({ onTurn: () => ({ report: true }) }).start();
  const a = h.byStep('implement')[0];
  const fx = h.apply({ type: 'report', assignmentId: a.id, report: h.report(a) });
  assert.ok(fx.some(e => e.type === 'write_late'));
  h.apply({ type: 'approval_card', cardId: h.run.approvals[0].id, status: 'approved', result: '已提交 abc1234' });
  assert.equal(h.run.approvals[0].status, 'approved');
  assert.equal(h.run.status, 'completed');
});

test('匯出審查副本時正本已變(service 送的事件不帶 dir):走版本失效,不是被環境擋住;選繼續以新版本重做', () => {
  const h = harness({ onTurn: () => ({ report: true }), hold: ['export_copy'] }).start();
  assert.equal(h.run.phase, 'exporting_copy');
  const ex = h.held.shift();
  h.canon = v(321);
  // 和 FlowService.exportCopy 一樣:canonical !== version 時只帶 canonical,不帶 dir、error
  h.apply({ type: 'copy_ready', token: ex.token, canonical: h.canon });
  assert.equal(h.run.pending.kind, 'version_changed');
  assert.equal(h.run.verifiedVersion, undefined, '核實失效');
  h.hold.clear();
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'continue' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.byStep('review')[0].reviewedVersion, v(321), '以新版本重新核實後審查');
  assert.equal(h.byStep('implement')[0].version, v(321));
  // 拍不到正本(canonical 為 null)時才算匯出失敗
  const b = harness({ onTurn: () => ({ report: true }), hold: ['export_copy'] }).start();
  b.apply({ type: 'copy_ready', token: b.held[0].token, canonical: null, error: 'git 失敗' });
  assert.equal(b.run.pending.kind, 'verify_blocked');
});

test('停止時節點一直沒停下來:不默認已結束,交給使用者;工作樹不釋放;再等或強制視為結束', () => {
  const h = harness({ onTurn: () => ({ hold: true }) }).start();
  const a = h.byStep('implement')[0];
  const ensure = h.apply({ type: 'stop' }).find(e => e.type === 'ensure_ended');
  h.apply({ type: 'ended', token: ensure.token, ok: false, stuck: ['Keeper'] });
  assert.equal(h.run.status, 'awaiting_user', '不是終止狀態(工作樹鎖還在)');
  assert.equal(h.run.pending.kind, 'not_ended');
  assert.deepEqual(h.run.pending.options, ['wait', 'force_ended']);
  assert.equal(h.a(a.id).status, 'running');
  // 等待期間交來的回報當遲到
  const late = h.apply({ type: 'report', assignmentId: a.id, report: h.report(a) });
  assert.ok(late.some(e => e.type === 'write_late'));
  const again = h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'wait' }).find(e => e.type === 'ensure_ended');
  assert.ok(again, '再等:重新確認');
  assert.equal(h.run.status, 'stopping');
  h.apply({ type: 'ended', token: ensure.token });
  assert.equal(h.run.status, 'stopping', '舊的確認結果不採用');
  h.apply({ type: 'ended', token: again.token, ok: false });
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'force_ended' });
  assert.equal(h.run.status, 'stopped');
  assert.equal(h.a(a.id).status, 'stopped');
});

test('重跑前節點沒停下來:不重新交辦、舊交辦的回報當遲到;使用者可以停止流程', () => {
  let first = true;
  const h = harness({ onTurn: step => { if (step === 'implement' && first) { first = false; return { outcome: 'failed', hold: true }; } return { report: true }; } }).start();
  const a = h.byStep('implement')[0];
  // 讓第一個交辦變成出錯但任務其實還在跑:手動模擬
  h.apply({ type: 'turn_ended', assignmentId: a.id, taskId: 'x', outcome: 'failed', sessionId: 's-impl' });
  assert.equal(h.run.pending.kind, 'agent_error');
  h.run.assignments[0].status = 'running'; // 出錯後又恢復執行(例如失聯後又有事件)
  h.hold = new Set(['ensure_ended']);
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'rerun' });
  h.pump();
  const ens = h.held.shift();
  assert.ok(ens);
  const r1 = h.apply({ type: 'report', assignmentId: a.id, report: h.report(a) });
  assert.ok(r1.some(e => e.type === 'write_late'), '確認期間舊交辦的回報當遲到');
  assert.equal(h.a(a.id).report, undefined);
  h.apply({ type: 'ended', token: ens.token, ok: false });
  assert.equal(h.run.pending.kind, 'not_ended');
  assert.deepEqual(h.run.pending.options, ['wait', 'force_ended', 'stop']);
  assert.equal(h.byStep('implement').length, 1, '沒有重新交辦');
  assert.ok(!h.log.slice(-5).some(e => e.type === 'pick_agent'));
  const st = h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'stop' });
  assert.equal(h.run.status, 'stopping');
  h.apply({ type: 'ended', token: st.find(e => e.type === 'ensure_ended').token });
  assert.equal(h.run.status, 'stopped');
});

test('單步超時:確認結束後交辦標成中斷;等待使用者期間的回報當遲到;單步時間從開始執行算', () => {
  const h = harness({ limits: { stepMinutes: 5 }, hold: ['dispatch'] }).start();
  const d = h.held.shift();
  h.apply({ type: 'dispatched', assignmentId: d.assignmentId, queuedId: 'q' });
  h.apply({ type: 'tick' }, 30 * MIN);                       // 在佇列裡排了 30 分鐘
  assert.equal(h.run.pending, undefined, '排隊不算單步時間');
  h.apply({ type: 'task_started', assignmentId: d.assignmentId, taskId: 't1' });
  h.apply({ type: 'tick' }, 3 * MIN);
  assert.equal(h.run.pending, undefined);
  const fx = h.apply({ type: 'tick' }, 3 * MIN);
  const ens = fx.find(e => e.type === 'ensure_ended');
  assert.ok(ens);
  assert.equal(h.run.pending.kind, 'limit');
  const a = h.a(d.assignmentId);
  const r1 = h.apply({ type: 'report', assignmentId: a.id, report: h.report(a) });
  assert.ok(r1.some(e => e.type === 'write_late'), '等待使用者時的回報當遲到');
  h.apply({ type: 'ended', token: ens.token });
  assert.equal(h.a(a.id).status, 'interrupted', '確認結束後不再停在執行中');
  h.hold.clear();
  h.onTurn = () => ({ report: true });
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'rerun' });
  h.pump();
  assert.equal(h.run.status, 'completed');
});

test('審查副本不在了:不記成副本被寫入,交給使用者重新審查或照用', () => {
  const h = harness({ onTurn: () => ({ report: true }), hold: ['snapshot'] }).start();
  // 實作的快照照常
  const s1 = h.held.shift();
  h.apply({ type: 'snapshot_done', token: s1.token, snap: { version: h.canon, refsChanged: [], ignored: [], changed: [], outOfScope: [], unexplained: [], copyWritten: [] } });
  h.pump();
  const s2 = h.held.shift();
  h.apply({ type: 'snapshot_done', token: s2.token, snap: { version: h.canon, refsChanged: [], ignored: [], changed: [], outOfScope: [], unexplained: [], copyWritten: [], copyError: '副本已不在' } });
  assert.equal(h.run.pending.kind, 'copy_missing');
  assert.ok(!h.run.violations.some(x => x.kind === 'copy_written'));
  h.hold.clear();
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'rerun' });
  h.pump();
  assert.equal(h.run.status, 'completed');
  assert.equal(h.byStep('review').length, 2, '重新審查');
});

test('同一個待決事項重提不重複通知總管;主控台重開時確認中的停止直接完成', () => {
  const h = harness({ onTurn: (step, n) => (step === 'implement' && n === 1 ? {} : { report: true }) }).start();
  h.apply({ type: 'tick' }, 10 * MIN);
  h.pump();
  assert.equal(h.run.pending.kind, 'unreported');
  const before = h.log.filter(e => e.type === 'notify').length;
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'manual_report' }); // 沒帶回報:重提同一個待決事項
  assert.equal(h.run.pending.kind, 'unreported');
  assert.equal(h.log.filter(e => e.type === 'notify').length, before, '沒有重複通知');
  const s = harness({ onTurn: () => ({ hold: true }) }).start();
  const ens = s.apply({ type: 'stop' }).find(e => e.type === 'ensure_ended');
  s.apply({ type: 'ended', token: ens.token, ok: false });
  assert.equal(restoreAfterRestart(s.run, s.t).status, 'stopped');
});

test('reduce 不修改傳入的 run', () => {
  const h = harness({ onTurn: () => ({ hold: true }) }).start();
  const before = JSON.stringify(h.run);
  reduce(h.run, { type: 'stop' }, h.t + 1);
  assert.equal(JSON.stringify(h.run), before);
});

console.log(`通過 ${passed} 項`);
