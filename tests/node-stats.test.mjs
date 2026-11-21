// 驗收:節點統計(src/shared/node-stats.ts):完成率與驗收率分開、沒有資料的情況、耗時與花費、專案,
// 以及總管守則「各節點近況」段落的排序與字數截斷。
// 用法:node --no-warnings tests/node-stats.test.mjs
import assert from 'node:assert/strict';
import { chiefStatsSection, computeNodeStats, computeProjectStats, emptyStats, formatDuration, statsLine } from '../src/shared/node-stats.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-11-21T12:00:00');
let n = 0;
const task = (agentId, status, o = {}) => {
  const startedAt = o.startedAt ?? NOW - DAY;
  return { id: `t${++n}`, agentId, agentName: agentId, backend: 'claude', model: '', title: 't', status, note: '', steps: [], subs: [], startedAt, endedAt: status === 'running' || status === 'awaiting' ? null : startedAt + (o.ms ?? 60000), ...o };
};

test('完成率:完成 /(完成+失敗+中斷),進行中的不算', () => {
  const s = computeNodeStats([task('a', 'done'), task('a', 'done'), task('a', 'done'), task('a', 'failed'), task('a', 'interrupted'), task('a', 'running'), task('a', 'awaiting')]).get('a');
  assert.deepEqual([s.tasks, s.done, s.failed, s.interrupted, s.running], [7, 3, 1, 1, 2]);
  assert.equal(s.completionRate, 3 / 5);
});

test('驗收率和完成率分開:完成的任務沒人驗收就是 null,退回的任務不影響完成率', () => {
  const s = computeNodeStats([task('a', 'done'), task('a', 'done', { verdict: 'accepted' }), task('a', 'done', { verdict: 'rejected' }), task('a', 'done', { verdict: 'accepted' }), task('a', 'done', { verdict: null })]).get('a');
  assert.equal(s.completionRate, 1);
  assert.deepEqual([s.accepted, s.rejected], [2, 1]);
  assert.equal(s.acceptanceRate, 2 / 3);
  const none = computeNodeStats([task('b', 'done'), task('b', 'failed')]).get('b');
  assert.equal(none.completionRate, 0.5);
  assert.equal(none.acceptanceRate, null);
  assert.deepEqual([none.accepted, none.rejected], [0, 0]);
});

test('沒有已結束的任務:完成率是 null;沒有任何任務的節點不在結果裡', () => {
  const m = computeNodeStats([task('a', 'running')]);
  assert.equal(m.get('a').completionRate, null);
  assert.equal(m.get('a').avgDoneMs, null);
  assert.equal(m.has('zzz'), false);
  assert.equal(emptyStats('zzz').tasks, 0);
});

test('平均耗時只算完成的任務;花費加總;最近交辦時間', () => {
  const s = computeNodeStats([
    task('a', 'done', { ms: 60000, cost: { tokens: 1000, usd: 0.01 }, startedAt: NOW - 3 * DAY }),
    task('a', 'done', { ms: 180000, cost: { tokens: 500, usd: 0.02 }, startedAt: NOW - 2 * DAY }),
    task('a', 'failed', { ms: 9 * 3600 * 1000, startedAt: NOW - DAY }),
    task('a', 'done', { ms: 120000 }),
  ]).get('a');
  assert.equal(s.avgDoneMs, 120000);
  assert.deepEqual(s.cost.tokens, 1500);
  assert.ok(Math.abs(s.cost.usd - 0.03) < 1e-9);
  assert.equal(s.lastActive, NOW - DAY);
});

test('專案:舊任務沒有專案欄位不報錯;依最近一次排序;名稱用最新的', () => {
  const p1 = { id: 'p1', name: 'Old Name' }, p2 = { id: 'p2', name: 'Two' };
  const s = computeNodeStats([task('a', 'done'), task('a', 'done', { project: p1, startedAt: NOW - 5 * DAY }), task('a', 'done', { project: p2, startedAt: NOW - 3 * DAY }), task('a', 'done', { project: { id: 'p1', name: 'New Name' }, startedAt: NOW - 4 * DAY })]).get('a');
  assert.deepEqual(s.projects.map(p => [p.id, p.name, p.tasks]), [['p2', 'Two', 1], ['p1', 'New Name', 2]]);
  const byProject = computeProjectStats([task('a', 'done', { project: p1 }), task('b', 'failed', { project: p1 }), task('b', 'done', { project: p2 })]);
  assert.equal(byProject.get('p1').tasks, 2);
  assert.equal(byProject.get('p1').completionRate, 0.5);
  assert.equal(byProject.get('p2').done, 1);
});

test('耗時的寫法', () => {
  assert.equal(formatDuration(45000), '45 秒');
  assert.equal(formatDuration(200000), '3 分 20 秒');
  assert.equal(formatDuration(300000), '5 分');
  assert.equal(formatDuration(3900000), '1 小時 5 分');
});

const node = (id, name = id, model = '') => ({ id, name, backendLabel: 'Claude Code', model });

test('單一節點的一行:數字、尚無驗收、專案', () => {
  const s = computeNodeStats([task('a', 'done', { ms: 200000, project: { id: 'p', name: 'repo' } }), task('a', 'done', { verdict: 'accepted' }), task('a', 'failed', { verdict: 'rejected' })]).get('a');
  const line = statsLine(node('a', '小明', 'opus'), s);
  assert.equal(line, '- 小明(Claude Code · opus):完成率 67%(2/3),驗收率 50%(1/2),平均耗時 2 分 10 秒,近期專案 repo');
  assert.equal(statsLine(node('b', '乙'), computeNodeStats([task('b', 'done')]).get('b')), '- 乙(Claude Code):完成率 100%(1/1),驗收率 尚無驗收,平均耗時 1 分 0 秒'.replace('1 分 0 秒', '1 分'));
  assert.equal(statsLine(node('c', '丙'), undefined), '- 丙(Claude Code):尚無任務紀錄');
});

test('段落:近 30 天有任務的在前(最近的最前面),其餘接後面;沒有節點是空字串', () => {
  const stats = computeNodeStats([task('old', 'done', { startedAt: NOW - 40 * DAY }), task('mid', 'done', { startedAt: NOW - 10 * DAY }), task('new', 'done', { startedAt: NOW - DAY })]);
  const text = chiefStatsSection([node('none'), node('old'), node('mid'), node('new')], stats, NOW);
  const order = text.split('\n').slice(1).map(l => l.slice(2, l.indexOf('(')));
  assert.deepEqual(order, ['new', 'mid', 'old', 'none']);
  assert.ok(text.startsWith('各節點的近況'));
  assert.equal(chiefStatsSection([], stats, NOW), '');
});

test('段落:超過字數時先捨去沒有近期任務的節點,結尾寫另有 N 個節點', () => {
  const nodes = [];
  const tasks = [];
  for (let i = 0; i < 30; i++) {
    nodes.push(node(`n${i}`, `節點${String(i).padStart(2, '0')}`, 'claude-opus-4-1'));
    // 偶數號最近有任務,奇數號 60 天前
    tasks.push(task(`n${i}`, 'done', { startedAt: NOW - (i % 2 === 0 ? i : 60 + i) * 3600 * 1000 * (i % 2 === 0 ? 1 : 24), project: { id: 'p', name: '專案甲' } }));
  }
  const stats = computeNodeStats(tasks);
  const text = chiefStatsSection(nodes, stats, NOW, 1500);
  assert.ok(text.length <= 1500, `長度 ${text.length}`);
  const lines = text.split('\n');
  const footer = lines.at(-1);
  const kept = lines.length - 2;
  assert.match(footer, /^另有 \d+ 個節點,可用 list_nodes 查看$/);
  assert.equal(Number(/\d+/.exec(footer)[0]), 30 - kept);
  assert.ok(kept > 5 && kept < 30);
  // 保留下來的全是近期有任務的(偶數號),被捨去的先是沒有近期任務的
  const keptNames = lines.slice(1, -1).map(l => l.slice(2, l.indexOf('(')));
  const dropped = nodes.map(x => x.name).filter(nm => !keptNames.includes(nm));
  assert.equal(dropped.length, 30 - kept);
  assert.ok(dropped.every(nm => Number(nm.slice(2)) % 2 === 1), `被捨去的應該都是沒有近期任務的:${dropped.join()}`);
  assert.equal(keptNames.filter(nm => Number(nm.slice(2)) % 2 === 0).length, 15, '近期有任務的 15 個節點都要保留');
  // 預算很小時至少留一行,且仍有結尾
  const tiny = chiefStatsSection(nodes, stats, NOW, 10);
  assert.equal(tiny.split('\n').length, 3);
  // 剛好放得下全部時不寫結尾
  const full = chiefStatsSection(nodes.slice(0, 3), stats, NOW, 1500);
  assert.ok(!full.includes('另有'));
});

console.log(`通過(${passed} 項)`);
