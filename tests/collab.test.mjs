// 驗收:協作過程可視化的純邏輯(src/shared/collab.ts)、遠端權限的過濾(src/main/access.ts)與分派紀錄的資料表(src/main/store.ts)。
// 用法:在 app 資料夾執行 node --no-warnings tests/collab.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLinks, dispatchRow, dispatchTitle, durationText, sameLinks, sourceLabel, trimDispatches, DISPATCH_MAX } from '../src/shared/collab.ts';
import { filterDispatches, filterLinks, filterSnapshot, filterUpdate } from '../src/main/access.ts';
import { Store } from '../src/main/store.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const P = (id, callerId, targetId, extra = {}) => ({ id, callerId, targetId, status: 'running', createdAt: 100, ...extra });
const D = (id, startedAt, extra = {}) => ({ id, startedAt, endedAt: null, fromId: 'a', fromName: 'A', toId: 'b', toName: 'B', title: 't', status: 'running', ...extra });

test('呼叫請求變成 ask 連線;已結束的與會議裡的發言回合不單獨畫', () => {
  const links = buildLinks([P('r1', 'a', 'b', { label: '請看一下設計' }), P('r2', 'a', 'c', { status: 'done' }), P('r3', 'h', 'p1', { meetingId: 'm1' })], []);
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], { id: 'r1', kind: 'ask', from: 'a', to: ['b'], label: '請看一下設計', startedAt: 100, active: true });
});

test('會議:主持人連到每位參與者,標出目前發言者;結束的不畫', () => {
  const m = { id: 'm1', callerId: 'h', participantIds: ['p1', 'p2'], status: 'running', createdAt: 50, topic: '討論', currentTargetId: 'p2' };
  const [l] = buildLinks([], [m, { ...m, id: 'm2', status: 'done' }]);
  assert.equal(l.kind, 'meeting'); assert.equal(l.from, 'h'); assert.deepEqual(l.to, ['p1', 'p2']); assert.equal(l.speaker, 'p2');
  assert.equal(buildLinks([], [{ ...m, currentTargetId: null }])[0].speaker, undefined);
  assert.equal(buildLinks([], [{ ...m, currentTargetId: 'zzz' }])[0].speaker, undefined);
});

test('連線依開始時間排序;內容相同判斷', () => {
  const l = buildLinks([P('b', 'a', 'x', { createdAt: 5 }), P('a', 'a', 'y', { createdAt: 2 })], []);
  assert.deepEqual(l.map(x => x.id), ['a', 'b']);
  assert.ok(sameLinks(l, structuredClone(l))); assert.ok(!sameLinks(l, l.slice(1)));
});

test('權限過濾:ask 兩端都看得到才留;會議只留看得到的參與者', () => {
  const see = id => ['a', 'b', 'h', 'p1'].includes(id);
  const links = buildLinks([P('r1', 'a', 'b'), P('r2', 'a', 'c'), P('r3', 'c', 'a')], [{ id: 'm1', callerId: 'h', participantIds: ['p1', 'p2'], status: 'running', createdAt: 1, currentTargetId: 'p2' }, { id: 'm2', callerId: 'c', participantIds: ['a'], status: 'running', createdAt: 2 }]);
  const out = filterLinks(links, see);
  assert.deepEqual(out.map(l => l.id).sort(), ['m1', 'r1']);
  const m = out.find(l => l.id === 'm1');
  assert.deepEqual(m.to, ['p1']); assert.equal(m.speaker, undefined);
});

test('filterSnapshot / filterUpdate 帶著連線與分派紀錄過濾;完整角色原樣', () => {
  const access = { role: 'viewer', agents: ['a', 'b'] };
  const rootOf = id => id;
  const links = buildLinks([P('r1', 'a', 'b'), P('r2', 'a', 'c')], []);
  const dispatches = [D('d1', 1), D('d2', 2, { toId: 'c' })];
  const s = filterSnapshot({ agents: [], tasks: [], links, dispatches }, access, rootOf);
  assert.deepEqual(s.links.map(l => l.id), ['r1']); assert.deepEqual(s.dispatches.map(d => d.id), ['d1']);
  const u = filterUpdate({ links }, access, rootOf);
  assert.deepEqual(u.links.map(l => l.id), ['r1']);
  assert.equal(filterUpdate({ links: [] }, access, rootOf).links.length, 0);
  assert.equal(filterSnapshot({ agents: [], tasks: [], links, dispatches }, { role: 'full', agents: null }, rootOf).links.length, 2);
  assert.deepEqual(filterDispatches(dispatches, id => id !== 'a'), []);
});

test('任務來源標籤', () => {
  assert.equal(sourceLabel({ source: 'desktop' }, 'c'), '');
  assert.equal(sourceLabel({}, 'c'), '');
  assert.equal(sourceLabel({ source: 'interop', from: { id: 'c', name: '總管' } }, 'c'), '由總管交辦');
  assert.equal(sourceLabel({ source: 'interop', from: { id: 'x', name: 'Beta' } }, 'c'), '由 Beta 交辦');
  assert.equal(sourceLabel({ source: 'interop', from: { id: 'x', name: 'Beta' } }, null), '由 Beta 交辦');
  assert.equal(sourceLabel({ source: 'interop', from: { id: 'c', name: '總管', meeting: true } }, 'c'), '會議');
  assert.equal(sourceLabel({ source: 'interop' }, 'c'), '由其他節點交辦');
  assert.equal(sourceLabel({ source: 'remote' }, 'c'), '遠端');
  assert.equal(sourceLabel({ source: 'autopilot' }, 'c'), '模擬自動運作');
});

test('分派紀錄:保留 30 天與最多 50 筆、新的在前', () => {
  const now = 100 * 86400000;
  const list = [D('old', now - 31 * 86400000), D('edge', now - 30 * 86400000), D('new', now - 1000)];
  assert.deepEqual(trimDispatches(list, now).map(d => d.id), ['new', 'edge']);
  const many = Array.from({ length: 70 }, (_, i) => D(`d${i}`, now - i * 1000));
  const t = trimDispatches(many, now);
  assert.equal(t.length, DISPATCH_MAX); assert.equal(t[0].id, 'd0');
});

test('分派紀錄的列:狀態、耗時、任務花費', () => {
  const tasks = [{ id: 't1', cost: { tokens: 1500, usd: 0.02 } }, { id: 't2', cost: { tokens: 0, usd: 0 } }];
  const r = dispatchRow(D('d', 1000, { endedAt: 46000, status: 'done', taskId: 't1' }), 99999, tasks);
  assert.deepEqual(r, { status: '完成', durationMs: 45000, cost: { tokens: 1500, usd: 0.02 } });
  assert.equal(dispatchRow(D('d', 1000, { taskId: 't2' }), 4000, tasks).cost, null);
  assert.equal(dispatchRow(D('d', 1000), 4000, tasks).durationMs, 3000);
  assert.equal(dispatchRow(D('d', 1000, { status: 'timeout', endedAt: 2000 }), 4000, []).status, '逾時');
  assert.equal(dispatchRow(D('d', 1000, { status: 'failed', endedAt: 2000 }), 4000, []).status, '失敗');
  assert.equal(dispatchRow(D('d', 1000), 4000, []).status, '進行中');
});

test('標題與耗時文字', () => {
  assert.equal(dispatchTitle('  請幫我\n看一下   設計  '), '請幫我 看一下 設計');
  assert.equal(dispatchTitle('字'.repeat(100)).length, 60);
  assert.equal(dispatchTitle('   '), '(沒有內容)');
  assert.equal(durationText(45000), '45 秒'); assert.equal(durationText(200000), '3 分 20 秒'); assert.equal(durationText(3900000), '1 小時 5 分'); assert.equal(durationText(120000), '2 分');
});

test('資料表:存檔、更新、讀回(新的在前)、清掉過期', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-collab-'));
  const store = new Store(join(dir, 'nexus.db'));
  try {
    store.saveDispatch(D('d1', 1000)); store.saveDispatch(D('d2', 2000)); store.saveDispatch(D('d3', 3000));
    store.saveDispatch(D('d2', 2000, { status: 'done', endedAt: 2500, taskId: 'tk' }));
    let list = store.loadDispatches(50);
    assert.deepEqual(list.map(d => d.id), ['d3', 'd2', 'd1']);
    assert.equal(list[1].status, 'done'); assert.equal(list[1].taskId, 'tk');
    assert.equal(store.loadDispatches(2).length, 2);
    store.pruneDispatches(2000);
    list = store.loadDispatches(50);
    assert.deepEqual(list.map(d => d.id), ['d3', 'd2']);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

console.log(`全部通過(${passed} 項)`);
