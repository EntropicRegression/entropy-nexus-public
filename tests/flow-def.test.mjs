// 驗收:協作流程的定義檔(src/main/flow/definition.ts):內建範本解析、驗證規則、專案覆寫、使用者範本與 projects.yaml。
// 用法:在 app 資料夾執行 node tests/flow-def.test.mjs(Node 22.18 以上可直接載入 .ts)
// 內建範本用 fs 直接讀(builtin.ts 的 ?raw 只有建置時能用)。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyProject, dumpProjectsFile, loadUserTemplates, parseFlow, parseProjectsFile } from '../src/main/flow/definition.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

// CI 在 Windows 上 checkout 會轉成 CRLF;測試用字串取代範本內容,先統一成 LF(解析本身兩種都接受,另有測試)
const TEMPLATE = readFileSync(resolve(import.meta.dirname, '../src/main/flow/templates/implement-review.yaml'), 'utf8').replace(/\r\n/g, '\n');
const base = () => parseFlow(TEMPLATE, 'builtin', 'implement-review.yaml');
/** 把範本改一點再解析;edit 收到 YAML 文字。 */
const variant = edit => parseFlow(edit(TEMPLATE));
const ALWAYS = ['commit', 'push', 'dist', 'merge_pr', 'approve_pr', 'force_push', 'delete_branch'];
const hasErr = (r, frag) => assert.ok(r.errors.some(e => e.includes(frag)), `應有含「${frag}」的錯誤,實際:${JSON.stringify(r.errors)}`);

test('內建範本:解析成功、沒有錯誤也沒有警告', () => {
  const r = base();
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const f = r.flow;
  assert.equal(f.id, 'implement-review');
  assert.equal(f.source, 'builtin');
  assert.deepEqual(Object.keys(f.roles), ['implementer', 'reviewer']);
  assert.equal(f.roles.reviewer.mode, 'review');
  assert.deepEqual(f.limits, { maxRejections: 2, maxMinutes: 180, stepMinutes: 45, reminderMinutes: 10, maxDispatches: 12 });
  assert.deepEqual(f.steps.map(s => s.id), ['implement', 'review', 'fix']);
  const [impl, review, fix] = f.steps;
  assert.equal(impl.verify, true); assert.equal(impl.onReject, 'fix'); assert.equal(impl.next, undefined);
  assert.equal(review.mode, 'review'); assert.equal(review.next, 'done'); assert.equal(review.onReject, 'fix');
  assert.equal(fix.continueSession, true); assert.equal(fix.next, 'review');
  assert.deepEqual(f.verify.commands, [
    { id: 'typecheck', run: 'npm run typecheck', timeout: 300, needs: [], desktop: false },
    { id: 'unit', run: 'npm test', timeout: 600, needs: ['typecheck'], desktop: false },
  ]);
  assert.deepEqual(f.finish.offer, ['commit']);
  assert.deepEqual(f.scope.forbiddenActions, ALWAYS);
  assert.equal(f.verify.in, 'copy');
});

test('必填:id、name、steps;id 格式', () => {
  hasErr(variant(t => t.replace(/^id: .*$/m, '')), 'id:必填');
  hasErr(variant(t => t.replace(/^name: .*$/m, '')), 'name:必填');
  hasErr(variant(t => t.replace(/^id: .*$/m, 'id: Implement_Review')), 'id:只能用小寫英文');
  hasErr(parseFlow('id: x\nname: x\nroles: { a: { mode: write } }\n'), 'steps:必填');
  hasErr(parseFlow('id: x\nname: x\nroles: { a: { mode: write } }\nsteps: []\n'), 'steps:必須是非空的清單');
  hasErr(parseFlow('- 不是物件'), '必須是 YAML 物件');
  hasErr(parseFlow('id: [x'), 'YAML 格式錯誤');
});

test('步驟:要有 role 與 mode,role 必須在 roles 裡;id 不重複、不能用保留字', () => {
  hasErr(variant(t => t.replace('role: reviewer, mode: review, on_reject', 'role: auditor, mode: review, on_reject')), '「auditor」不在 roles 裡');
  hasErr(variant(t => t.replace('label: 實作, role: implementer, mode: write,', 'label: 實作, role: implementer,')), 'steps[0].mode:必填');
  hasErr(variant(t => t.replace('label: 實作, role: implementer, mode: write,', 'label: 實作, role: implementer, mode: read,')), '只能是 write 或 review');
  hasErr(variant(t => t.replace('{ id: fix,', '{ id: review,')), '步驟 id「review」重複');
  hasErr(variant(t => t.replace('{ id: fix,', '{ id: halt,')), '「halt」是保留字');
});

test('on_reject、next 要指向存在的步驟或 halt(next 另可用 done)', () => {
  hasErr(variant(t => t.replace('on_reject: fix, next: done', 'on_reject: nowhere, next: done')), 'on_reject:指向不存在的步驟「nowhere」');
  hasErr(variant(t => t.replace('next: review', 'next: nowhere')), 'next:指向不存在的步驟「nowhere」');
  hasErr(variant(t => t.replace('on_reject: fix, next: done', 'on_reject: done, next: done')), 'on_reject:指向不存在的步驟「done」');
  const ok = variant(t => t.replace('on_reject: fix, next: done', 'on_reject: halt, next: halt'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.flow.steps[1].onReject, 'halt');
});

test('核實指令:timeout 必填且上限 3600;needs 只能一層、不能依賴自己或不存在的指令;desktop 預設 false', () => {
  hasErr(variant(t => t.replace('run: npm run typecheck, timeout: 300', 'run: npm run typecheck')), '每條核實指令都必須有逾時');
  hasErr(variant(t => t.replace('timeout: 300', 'timeout: 3601')), '上限 3600 秒');
  hasErr(variant(t => t.replace('timeout: 300', 'timeout: -1')), '大於 0 的秒數');
  hasErr(variant(t => t.replace('needs: [typecheck]', 'needs: [unit]')), '不能依賴自己');
  hasErr(variant(t => t.replace('needs: [typecheck]', 'needs: [lint]')), '不存在的「lint」');
  hasErr(variant(t => t.replace('timeout: 300 }', 'timeout: 300, needs: [build] }\n    - { id: build, run: x, timeout: 1 }')), 'needs 只支援一層');
  hasErr(variant(t => t.replace('{ id: unit,', '{ id: typecheck,')), '指令 id「typecheck」重複');
  const d = variant(t => t.replace('timeout: 600, needs: [typecheck] }', 'timeout: 600, needs: [typecheck] }\n    - { id: smoke, run: npm run smoke, timeout: 120, desktop: true }'));
  assert.deepEqual(d.errors, []);
  assert.equal(d.flow.verify.commands[2].desktop, true);
  assert.equal(d.flow.verify.commands[0].desktop, false);
});

test('forbidden_actions 一律併入 commit、push、dist 與永遠禁止的動作;不認得的動作是錯誤', () => {
  const r = variant(t => t.replace('forbidden_actions: [commit, push, dist]', 'forbidden_actions: [install]'));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.flow.scope.forbiddenActions, ['install', ...ALWAYS]);
  const none = variant(t => t.replace(/^scope:\n(?: {2}.*\n)+/m, ''));
  assert.deepEqual(none.flow.scope.forbiddenActions, ALWAYS);
  hasErr(variant(t => t.replace('forbidden_actions: [commit, push, dist]', 'forbidden_actions: [rm_rf]')), '「rm_rf」不是可禁止的動作');
});

test('高風險動作只能經 requires_approval 開放,不能設成免授權', () => {
  hasErr(variant(t => t.replace('{ id: implement,', '{ id: implement, auto_approve: [commit],')), '不能設成免授權');
  hasErr(variant(t => t.replace('scope:\n', 'scope:\n  allowed_actions: [push]\n')), '不能設成免授權');
  hasErr(variant(t => t.replace('{ id: implement,', '{ id: implement, requires_approval: true,')), '請列出需要授權的動作');
  hasErr(variant(t => t.replace('{ id: implement,', '{ id: implement, requires_approval: [dist],')), '「dist」不是高風險動作');
  const ok = variant(t => t.replace('{ id: implement,', '{ id: implement, requires_approval: [real_vault],'));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.flow.steps[0].requiresApproval, ['real_vault']);
  hasErr(variant(t => t.replace('offer: [commit]', 'offer: [commit, deploy]')), '「deploy」不是高風險動作');
  // 合併 PR、核准 PR、force push、刪分支永遠禁止,連授權卡也不能開放
  for (const a of ['merge_pr', 'approve_pr', 'force_push', 'delete_branch']) {
    hasErr(variant(t => t.replace('{ id: implement,', `{ id: implement, requires_approval: [${a}],`)), '永遠禁止');
    hasErr(variant(t => t.replace('offer: [commit]', `offer: [${a}]`)), '永遠禁止');
  }
});

test('不認得的欄位只記警告,不影響解析', () => {
  const r = variant(t => `${t}\ncolor: blue\n`.replace('{ id: implement,', '{ id: implement, emoji: x,'));
  assert.deepEqual(r.errors, []);
  assert.ok(r.flow);
  assert.ok(r.warnings.some(w => w.includes('「color」')) && r.warnings.some(w => w.includes('「emoji」')), JSON.stringify(r.warnings));
});

test('JSON_SCHEMA:不接受自訂型別,日期之類的值只當字串', () => {
  hasErr(parseFlow('id: x\nname: !!js/function "function(){}"\n'), 'YAML 格式錯誤');
  // JSON_SCHEMA 沒有 timestamp 型別,沒加引號的日期也只是字串,不會變成 Date
  const r = variant(t => t.replace(/^name: .*$/m, 'name: 2026-11-22'));
  assert.equal(r.flow.name, '2026-11-22');
});

test('limits:max_rejections 可以是 0,其他上限要大於 0', () => {
  const zero = variant(t => t.replace('max_rejections: 2', 'max_rejections: 0'));
  assert.deepEqual(zero.errors, []);
  assert.equal(zero.flow.limits.maxRejections, 0);
  hasErr(variant(t => t.replace('max_minutes: 180', 'max_minutes: 0')), 'limits.max_minutes');
  hasErr(variant(t => t.replace('max_rejections: 2', 'max_rejections: 1.5')), '必須是整數');
});

test('專案覆寫:verify replace / append、allowed_paths 取代、不修改原本的定義', () => {
  const f = base().flow;
  const extra = { id: 'lint', run: 'npm run lint', timeout: 60, needs: ['typecheck'], desktop: false };
  const app = applyProject(f, { projectId: 'p', roles: {}, allowDesktopVerify: false, verify: { mode: 'append', commands: [extra] }, allowedPaths: ['src/renderer/**'] });
  assert.deepEqual(app.errors, []);
  assert.deepEqual(app.flow.verify.commands.map(c => c.id), ['typecheck', 'unit', 'lint']);
  assert.deepEqual(app.flow.scope.allowedPaths, ['src/renderer/**']);
  assert.deepEqual(f.verify.commands.map(c => c.id), ['typecheck', 'unit']);
  assert.deepEqual(f.scope.allowedPaths, []);
  const rep = applyProject(f, { projectId: 'p', roles: {}, allowDesktopVerify: false, verify: { mode: 'replace', commands: [{ ...extra, needs: [] }] } });
  assert.deepEqual(rep.flow.verify.commands.map(c => c.id), ['lint']);
  assert.deepEqual(rep.flow.scope.allowedPaths, []);
  const dup = applyProject(f, { projectId: 'p', roles: { ghost: 'x' }, allowDesktopVerify: false, verify: { mode: 'append', commands: [{ ...extra, id: 'unit' }] } });
  assert.equal(dup.flow, null);
  assert.ok(dup.errors.some(e => e.includes('「unit」重複')));
  const bad = applyProject(f, { projectId: 'p', roles: {}, allowDesktopVerify: false, verify: { mode: 'replace', commands: [extra] } });
  assert.ok(bad.errors.some(e => e.includes('不存在的「typecheck」')), JSON.stringify(bad.errors));
  assert.ok(applyProject(f, { projectId: 'p', roles: { ghost: 'x' }, allowDesktopVerify: false }).warnings.some(w => w.includes('「ghost」')));
  assert.equal(applyProject(f, null).flow, f);
  // verify_in:預設 copy,專案設定可改 worktree
  assert.equal(app.flow.verify.in, 'copy');
  assert.equal(applyProject(f, { projectId: 'p', roles: {}, allowDesktopVerify: false, verifyIn: 'worktree' }).flow.verify.in, 'worktree');
  assert.equal(f.verify.in, 'copy');
});

test('projects.yaml:一個專案寫錯不影響其他專案,寫回時原樣保留寫錯的專案', () => {
  const text = [
    'projects:',
    '  c:/good:',
    '    roles: { implementer: keeper }',
    '    verify_in: worktree',
    '    verify:',
    '      commands:',
    '        - { id: lint, run: npm run lint, timeout: 60, needs: [typecheck] }',
    '  c:/bad:',
    '    roles: { implementer: someone }',
    '    allow_desktop_verify: "yes"',
    '    verify_in: sandbox',
  ].join('\n');
  const r = parseProjectsFile(text);
  // append 的 needs 指向範本裡的 typecheck:解析時不算錯,合併後才檢查
  assert.deepEqual(Object.keys(r.projects), ['c:/good']);
  assert.equal(r.projects['c:/good'].verifyIn, 'worktree');
  assert.deepEqual(r.projects['c:/good'].verify.commands[0].needs, ['typecheck']);
  assert.deepEqual(Object.keys(r.invalid), ['c:/bad']);
  assert.ok(r.invalid['c:/bad'].errors.some(e => e.includes('true 或 false')));
  assert.ok(r.invalid['c:/bad'].errors.some(e => e.includes('copy 或 worktree')));
  assert.ok(r.errors.every(e => e.startsWith('projects.c:/bad')), JSON.stringify(r.errors));
  const merged = applyProject(base().flow, r.projects['c:/good']);
  assert.deepEqual(merged.errors, []);
  assert.deepEqual(merged.flow.verify.commands.map(c => c.id), ['typecheck', 'unit', 'lint']);
  // replace 時 needs 指不到仍是錯誤(合併後檢查)
  const rep = parseProjectsFile('projects:\n  x:\n    verify: { mode: replace, commands: [{ id: a, run: b, timeout: 1, needs: [zz] }] }\n');
  assert.ok(rep.invalid.x.errors.some(e => e.includes('不存在的「zz」')));
  // 寫回:寫錯的專案原樣保留,改好的專案用新設定
  const back = parseProjectsFile(dumpProjectsFile(r.projects, r.invalid));
  assert.deepEqual(back.projects, r.projects);
  assert.deepEqual(back.invalid['c:/bad'].raw, r.invalid['c:/bad'].raw);
  const fixed = { ...r.projects, 'c:/bad': { projectId: 'c:/bad', roles: { implementer: 'someone' }, allowDesktopVerify: true } };
  const back2 = parseProjectsFile(dumpProjectsFile(fixed, r.invalid));
  assert.deepEqual(back2.invalid, {});
  assert.equal(back2.projects['c:/bad'].allowDesktopVerify, true);
});

test('projects.yaml:解析、預設不允許桌面核實、寫回去讀得回來', () => {
  const text = [
    'projects:',
    '  c:/repo/vault:',
    '    roles: { implementer: vault keeper, reviewer: claudia jr }',
    '    verify:',
    '      mode: replace',
    '      commands:',
    '        - { id: tc, run: npm run typecheck, timeout: 300 }',
    '        - { id: smoke, run: "node tests/smoke.js --flag \\"x\\"", timeout: 120, needs: [tc], desktop: true }',
    '    allowed_paths: [src/renderer/**, "*.md"]',
    '  c:/repo/other:',
    '    roles: { implementer: Hagemi }',
  ].join('\n');
  const r = parseProjectsFile(text);
  assert.deepEqual(r.errors, []);
  const v = r.projects['c:/repo/vault'];
  assert.equal(v.allowDesktopVerify, false);
  assert.equal(v.roles.reviewer, 'claudia jr');
  assert.equal(v.verify.mode, 'replace');
  assert.equal(v.verify.commands[1].run, 'node tests/smoke.js --flag "x"');
  assert.equal(v.verify.commands[1].desktop, true);
  assert.deepEqual(v.allowedPaths, ['src/renderer/**', '*.md']);
  assert.equal(r.projects['c:/repo/other'].verify, undefined);
  assert.equal(r.projects['c:/repo/other'].allowedPaths, undefined);
  const back = parseProjectsFile(dumpProjectsFile(r.projects));
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.projects, r.projects);
  assert.deepEqual(parseProjectsFile('').projects, {});
  assert.deepEqual(back.invalid, {});
  assert.ok(parseProjectsFile('projects:\n  x:\n    verify: { mode: merge, commands: [] }\n').errors.some(e => e.includes('replace 或 append')));
  assert.ok(parseProjectsFile('projects:\n  x:\n    verify: { commands: [{ id: a, run: b }] }\n').errors.some(e => e.includes('必須有逾時')));
  assert.ok(parseProjectsFile('projects:\n  x:\n    allow_desktop_verify: "yes"\n').errors.some(e => e.includes('true 或 false')));
});

test('使用者範本:讀 flows/*.yaml、略過 projects.yaml、寫錯的也列出來', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-flowdef-'));
  try {
    writeFileSync(join(dir, 'a.yaml'), TEMPLATE.replace('id: implement-review', 'id: my-flow'));
    writeFileSync(join(dir, 'b.yml'), 'id: broken\n');
    writeFileSync(join(dir, 'projects.yaml'), 'projects: {}\n');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    const list = loadUserTemplates(dir);
    assert.deepEqual(list.map(l => l.file.split(/[\\/]/).pop()), ['a.yaml', 'b.yml']);
    assert.equal(list[0].flow.id, 'my-flow');
    assert.equal(list[0].flow.source, 'user');
    assert.equal(list[1].flow, null);
    assert.ok(list[1].errors.length > 0);
    assert.deepEqual(loadUserTemplates(join(dir, '不存在')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

console.log(`通過 ${passed} 項`);
