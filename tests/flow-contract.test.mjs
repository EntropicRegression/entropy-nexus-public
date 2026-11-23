// 驗收:協作流程狀態機的範圍合約與授權卡完整版(src/main/flow/machine.ts,里程碑 M3):
// requires_approval 的步驟交辦前跳卡(允許才交辦、拒絕停機、版本改變重開卡、授權只給這一步)、
// 收尾授權卡列出範圍外檔案的說明與沒寫原因的檔案、收尾第一版只支援 commit、
// L1/L2 違規事件、打包產出與受保護資料夾被寫入時停機、已授權 commit 的步驟 refs 改變不算違規。
// 用法:在 app 資料夾執行 node tests/flow-contract.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyProject, dumpProjectsFile, parseFlow, parseProjectsFile } from '../src/main/flow/definition.ts';
import { allowedRefChanges, createRun, reduce, restoreAfterRestart, toView } from '../src/main/flow/machine.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

const TEXT = readFileSync(new URL('../src/main/flow/templates/implement-review.yaml', import.meta.url), 'utf8');
const TEMPLATE = parseFlow(TEXT, 'builtin').flow;
const V0 = '0'.repeat(40);
const v = n => String(n).padStart(40, 'a');

/** 簡化版的 FlowService 模擬:依 effect 自動回應。snapExtra(a) 可以加上 artifacts、protectedWrites、refsChanged。 */
function harness(opts = {}) {
  const flow = structuredClone(TEMPLATE);
  flow.verify.commands = [];
  if (opts.edit) opts.edit(flow);
  const agents = [{ id: 'impl', name: 'Keeper', sessionId: 's-impl', state: 'idle' }, { id: 'rev', name: 'Claudia', sessionId: 's-rev', state: 'idle' }];
  const h = {
    t: 1_000_000, canon: V0, next: 1, effects: [], log: [],
    run: createRun({
      id: 'r1', flow, topic: 't', projectId: 'p', projectName: 'P', cwd: 'C:/repo', repoRoot: 'C:/repo',
      roles: { implementer: { agentId: 'impl', name: 'Keeper' }, reviewer: { agentId: 'rev', name: 'Claudia' } }, baseVersion: V0,
    }, 1_000_000),
  };
  h.apply = ev => { h.t += 10; const r = reduce(h.run, ev, h.t); h.run = r.run; h.effects.push(...r.effects); h.log.push(...r.effects); return r.effects; };
  h.a = id => h.run.assignments.find(a => a.id === id);
  h.report = (a, extra = {}) => ({ assignmentId: a.id, summary: '完成', mustFix: [], suggestions: [], needsRuling: [], commandsRun: [], notVerified: [], questions: [], scopeExceptions: [], receivedAt: h.t, ...(a.stepId === 'review' ? { verdict: 'mergeable' } : {}), ...extra });
  h.pump = () => {
    for (let i = 0; i < 300 && h.effects.length; i++) {
      const e = h.effects.shift();
      switch (e.type) {
        case 'gate': h.apply({ type: 'gate_ready', token: e.token, canonical: h.canon }); break;
        case 'pick_agent': h.apply({ type: 'agents', token: e.token, agents }); break;
        case 'dispatch': {
          const a = h.a(e.assignmentId);
          h.apply({ type: 'dispatched', assignmentId: a.id, queuedId: 'q', refsBefore: { symbolic: 'refs/heads/main', head: 'h0', refs: {} }, guardBefore: { 'flows/projects.yaml': '1:1' } });
          h.apply({ type: 'task_started', assignmentId: a.id, taskId: `${a.id}-t` });
          if (a.stepId !== 'review') h.canon = v(h.next++);
          h.apply({ type: 'report', assignmentId: a.id, report: h.report(a, opts.report?.(a) ?? {}) });
          h.apply({ type: 'turn_ended', assignmentId: a.id, taskId: `${a.id}-t`, outcome: 'done', sessionId: agents.find(x => x.id === a.agentId).sessionId });
          break;
        }
        case 'snapshot': {
          const a = h.a(e.assignmentId);
          h.apply({ type: 'snapshot_done', token: e.token, snap: { version: h.canon, refsChanged: [], ignored: [], changed: ['src/a.ts', 'notes.txt'], outOfScope: [], unexplained: [], copyWritten: [], ...(opts.snapExtra?.(a) ?? {}) } });
          break;
        }
        case 'export_copy': h.apply({ type: 'copy_ready', token: e.token, dir: `C:/runs/copies/r-${e.version.slice(0, 8)}`, canonical: h.canon }); break;
        case 'finish': h.apply(opts.finishDone ? { ...opts.finishDone, type: 'finish_done', token: e.token, canonical: h.canon } : { type: 'finish_done', token: e.token, canonical: h.canon, paths: ['src/a.ts', 'notes.txt', 'package.json'], outOfScope: ['notes.txt', 'package.json'], scopeNotes: [{ path: 'notes.txt', reason: '記錄決策' }], unexplained: ['package.json'] }); break;
        case 'ensure_ended': h.apply({ type: 'ended', token: e.token }); break;
        default: break;
      }
    }
  };
  h.start = () => { h.apply({ type: 'start' }); h.pump(); return h; };
  return h;
}

const gated = actions => flow => { flow.steps.find(s => s.id === 'implement').requiresApproval = actions; };

test('requires_approval:交辦前先跳卡(綁定正本版本、寫明涵蓋與不涵蓋),允許前不交辦', () => {
  const h = harness({ edit: gated(['push']) }).start();
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.kind, 'step_approval');
  assert.deepEqual(JSON.parse(JSON.stringify(h.run.pending.options)), ['halt', 'stop']);
  assert.equal(h.run.assignments.length, 0, '允許前沒有交辦');
  const card = h.run.approvals[0];
  assert.equal(card.action, 'push');
  assert.equal(card.stepId, 'implement');
  assert.equal(card.version, V0, '卡片綁定交辦前正本的版本');
  assert.ok(card.covers.some(c => c.includes('push')) && card.excludes.some(x => x.includes('force push')) && card.excludes.some(x => x.includes('其他步驟')), JSON.stringify(card));
  assert.equal(toView(h.run).steps[0].lamp, 'awaiting_approval');
});

test('requires_approval:允許後才交辦,授權只給這一步的交辦;流程走完', () => {
  const h = harness({ edit: gated(['push']) }).start();
  h.apply({ type: 'approval_card', cardId: h.run.approvals[0].id, status: 'approved', result: '已允許' });
  h.pump();
  assert.equal(h.run.status, 'completed', h.run.reason);
  const [impl, rev] = h.run.assignments;
  assert.deepEqual(impl.approved, ['push'], '實作交辦可以 push');
  assert.equal(rev.approved, undefined, '審查交辦沒有授權');
  assert.equal(h.run.gate, undefined);
});

test('requires_approval:拒絕就停機、不交辦', () => {
  const h = harness({ edit: gated(['install']) }).start();
  h.apply({ type: 'approval_card', cardId: h.run.approvals[0].id, status: 'denied' });
  h.pump();
  assert.equal(h.run.status, 'halted');
  assert.match(h.run.reason, /拒絕.*不交辦/);
  assert.equal(h.run.assignments.length, 0);
});

test('requires_approval:允許時版本已改變 → 卡片失效,重拍版本開新卡', () => {
  const h = harness({ edit: gated(['real_vault', 'install']) }).start();
  assert.equal(h.run.approvals.length, 2, '每個動作一張卡');
  h.canon = v(99);
  h.apply({ type: 'approval_card', cardId: h.run.approvals[0].id, status: 'expired', result: '版本已改變' });
  h.pump();
  assert.equal(h.run.status, 'awaiting_user');
  const live = h.run.approvals.filter(c => c.status === 'pending');
  assert.equal(live.length, 2, '新版本的兩張卡');
  assert.ok(live.every(c => c.version === v(99)));
  assert.ok(h.run.approvals.filter(c => c.version === V0).every(c => c.status === 'expired'), '舊版本的卡都失效');
  for (const c of live) h.apply({ type: 'approval_card', cardId: c.id, status: 'approved' });
  h.pump();
  assert.equal(h.run.status, 'completed');
});

test('requires_approval:停止流程時待決的交辦前授權卡失效', () => {
  const h = harness({ edit: gated(['push']) }).start();
  h.apply({ type: 'decide', decisionId: h.run.pending.id, choice: 'stop' });
  assert.equal(h.run.status, 'stopped');
  assert.equal(h.run.approvals[0].status, 'expired');
});

test('requires_approval:重開主控台後仍在等授權卡', () => {
  const h = harness({ edit: gated(['push']) }).start();
  const r = restoreAfterRestart(h.run, h.t + 1);
  assert.equal(r.status, 'awaiting_user');
  assert.equal(r.pending.kind, 'step_approval');
});

test('收尾授權卡:範圍內預設納入,範圍外列出節點的說明,沒寫原因的另外標示', () => {
  const h = harness().start();
  assert.equal(h.run.status, 'completed');
  const card = h.run.approvals[0];
  assert.deepEqual(card.paths, ['src/a.ts']);
  assert.deepEqual(card.outOfScope, ['notes.txt', 'package.json']);
  assert.deepEqual(card.scopeNotes, [{ path: 'notes.txt', reason: '記錄決策' }]);
  assert.deepEqual(card.unexplained, ['package.json']);
  assert.ok(card.covers.some(c => c.includes('要勾選才納入')) && card.excludes.some(x => x.includes('沒有勾選的範圍外檔案')), JSON.stringify(card));
  h.apply({ type: 'approval_card', cardId: card.id, status: 'approved', result: '已提交', included: ['notes.txt'] });
  assert.deepEqual(h.run.approvals[0].included, ['notes.txt'], '記下勾選納入的範圍外檔案');
});

test('收尾第一版只支援 commit:offer 裡的 push 不產生卡片(定義檔解析時警告)', () => {
  const h = harness({ edit: flow => { flow.finish.offer = ['commit', 'push']; } }).start();
  assert.deepEqual(h.run.approvals.map(c => c.action), ['commit']);
  assert.ok(h.run.audit.some(x => x.text.includes('第一版不支援')));
  const r = parseFlow(TEXT.replace('offer: [commit]', 'offer: [commit, push]'), 'builtin');
  assert.ok(r.flow && r.warnings.some(w => w.includes('只支援 commit')), JSON.stringify(r.warnings));
});

test('L1 違規(自動拒絕)只記錄、流程繼續;L2 違規停機', () => {
  const h = harness({ edit: flow => { flow.steps[0].verify = false; } });
  h.apply({ type: 'start' });
  // 交辦出去後先停住,模擬節點工作中
  while (h.effects.length) { const e = h.effects.shift(); if (e.type === 'pick_agent') h.apply({ type: 'agents', token: e.token, agents: [{ id: 'impl', name: 'Keeper', sessionId: 's', state: 'idle' }, { id: 'rev', name: 'C', sessionId: 's2', state: 'idle' }] }); }
  const a = h.run.assignments[0];
  h.apply({ type: 'violation', halt: false, violation: { kind: 'forbidden_action', stepId: a.stepId, assignmentId: a.id, detail: 'L1', items: ['git push'], actions: ['push'], blocked: true, at: h.t } });
  assert.equal(h.run.status, 'running');
  assert.equal(h.run.violations[0].blocked, true);
  h.apply({ type: 'violation', halt: true, violation: { kind: 'forbidden_action', stepId: a.stepId, assignmentId: a.id, detail: 'L2:執行 git commit', items: ['git commit -m x'], actions: ['commit'], blocked: false, at: h.t } });
  assert.equal(h.run.status, 'stopping', '先確認交辦結束(中斷)');
  h.pump();
  assert.equal(h.run.status, 'halted');
  assert.match(h.run.reason, /L2/);
});

test('L4:打包產出(dist/、release/)新增或改動 → 標違規並停機', () => {
  const h = harness({ snapExtra: a => (a.stepId === 'implement' ? { artifacts: ['release/x Setup.exe'] } : {}) }).start();
  assert.equal(h.run.status, 'halted');
  assert.ok(h.run.violations.some(x => x.kind === 'artifact_changed' && x.items.includes('release/x Setup.exe')));
  assert.equal(h.run.assignments.length, 1, '不往下審查');
});

test('受保護的資料夾:流程定義 flows/ 被寫入 → 標違規並停機', () => {
  const h = harness({ snapExtra: a => (a.stepId === 'implement' ? { protectedWrites: ['flows/evil.yaml'] } : {}) }).start();
  assert.equal(h.run.status, 'halted');
  assert.ok(h.run.violations.some(x => x.kind === 'protected_write' && x.items.includes('flows/evil.yaml')));
  assert.match(h.run.reason, /受保護的資料夾/);
});

test('交辦時的資料夾指紋記在交辦上(重開後仍能比對)', () => {
  const h = harness({ edit: flow => { flow.steps[0].verify = false; } }).start();
  assert.deepEqual(h.run.assignments[0].guardBefore, { 'flows/projects.yaml': '1:1' });
});

test('已授權 commit 的步驟:refs 改變不算違規(只記稽核);沒授權的步驟照樣停機', () => {
  const ok = harness({ edit: gated(['commit']), snapExtra: a => (a.stepId === 'implement' ? { refsChanged: ['HEAD'] } : {}) }).start();
  ok.apply({ type: 'approval_card', cardId: ok.run.approvals[0].id, status: 'approved' });
  ok.pump();
  assert.equal(ok.run.status, 'completed', ok.run.reason);
  assert.ok(!ok.run.violations.some(x => x.kind === 'refs_changed'));
  assert.ok(ok.run.audit.some(x => x.text.includes('已授權 commit')));
  const bad = harness({ snapExtra: a => (a.stepId === 'implement' ? { refsChanged: ['HEAD'] } : {}) }).start();
  assert.equal(bad.run.status, 'halted');
});

test('建議 10:只授權 commit 時只放行 HEAD 與目前分支;標籤、遠端追蹤分支照樣停機', () => {
  assert.ok(allowedRefChanges(['commit'], 'refs/heads/main')('HEAD') && allowedRefChanges(['commit'], 'refs/heads/main')('refs/heads/main'));
  assert.ok(!allowedRefChanges(['commit'], 'refs/heads/main')('refs/tags/v1') && !allowedRefChanges(['commit'], 'refs/heads/main')('refs/remotes/origin/main') && !allowedRefChanges(['commit'], 'refs/heads/main')('refs/heads/other'));
  assert.ok(allowedRefChanges(['push'], '')('refs/remotes/origin/main') && !allowedRefChanges(['push'], '')('HEAD'));
  const h = harness({ edit: gated(['commit']), snapExtra: a => (a.stepId === 'implement' ? { refsChanged: ['HEAD', 'refs/heads/main', 'refs/tags/v9'] } : {}) }).start();
  h.apply({ type: 'approval_card', cardId: h.run.approvals[0].id, status: 'approved' });
  h.pump();
  assert.equal(h.run.status, 'halted');
  const v = h.run.violations.find(x => x.kind === 'refs_changed');
  assert.deepEqual(v.items, ['refs/tags/v9'], '只列超出授權的 refs');
});

test('建議 10:修改已經都在 HEAD 裡時不產生 commit 卡,稽核紀錄說明原因', () => {
  // 收尾時 service 回報沒有檔案可提交並附上說明
  const h = harness({ finishDone: { paths: [], outOfScope: [], note: '修改已經都在 HEAD 裡' } }).start();
  assert.equal(h.run.status, 'completed', h.run.reason);
  assert.equal(h.run.approvals.length, 0);
  assert.ok(h.run.audit.some(x => x.text.includes('修改已經都在 HEAD 裡')));
});

test('建議 11:授權卡允許之後、交辦之前版本變了 → 這次交辦作廢、授權失效,重新開卡', () => {
  const h = harness({ edit: gated(['push']) }).start();
  h.apply({ type: 'approval_card', cardId: h.run.approvals[0].id, status: 'approved' });
  // 先不處理 effect:手動跑到交辦出去前
  let e;
  while ((e = h.effects.shift())) {
    if (e.type === 'pick_agent') h.apply({ type: 'agents', token: e.token, agents: [{ id: 'impl', name: 'Keeper', sessionId: 's', state: 'idle' }, { id: 'rev', name: 'C', sessionId: 's2', state: 'idle' }] });
    if (e.type === 'dispatch') break;
  }
  const a = h.run.assignments[0];
  assert.equal(a.approvedVersion, V0, '交辦記下授權卡的版本');
  h.canon = v(77);
  h.apply({ type: 'gate_stale', assignmentId: a.id, canonical: h.canon });
  assert.equal(h.run.assignments[0].status, 'superseded');
  assert.equal(h.run.approvals[0].status, 'expired');
  h.pump();
  assert.equal(h.run.status, 'awaiting_user');
  assert.equal(h.run.pending.kind, 'step_approval');
  assert.ok(h.run.approvals.some(c => c.status === 'pending' && c.version === v(77)), '新版本的卡');
});

test('專案設定 artifact_dirs:解析、寫回、套用(預設 dist、release)', () => {
  const r = parseProjectsFile('projects:\n  p1:\n    artifact_dirs: [build/out, release]\n  p2:\n    artifact_dirs: [../x]\n');
  assert.deepEqual(r.projects.p1.artifactDirs, ['build/out', 'release']);
  assert.ok(r.invalid.p2, '跳出專案的資料夾不接受');
  assert.deepEqual(parseProjectsFile(dumpProjectsFile(r.projects)).projects.p1.artifactDirs, ['build/out', 'release']);
  assert.deepEqual(applyProject(TEMPLATE, r.projects.p1).flow.scope.artifactDirs, ['build/out', 'release']);
  assert.equal(applyProject(TEMPLATE, { projectId: 'x', roles: {}, allowDesktopVerify: false }).flow.scope.artifactDirs, undefined, '沒設定就用預設');
});

console.log(`通過 ${passed} 項`);
