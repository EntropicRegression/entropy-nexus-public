// 驗收:總覽儀表的計算(src/shared/dashboard.ts)與每日紀錄的資料表(src/main/store.ts)。
// 每週額度的判斷、每日起點與今天的用量(含當天重置、跨日、缺資料)、預算與提醒的門檻、花費依日期彙總、任務統計。
// 用法:在 app 資料夾執行 node --no-warnings tests/dashboard.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  budgetLevel, budgetStatus, budgetWindow, countTasks, dashWarnings, defaultDailyBudget, localDate, nextBaseline, normalizeBudget, quotaReset, quotaWarnPercent,
  shiftDate, statusGroups, sumSpend, todayUsedPercent, totalTasks, warningText, weekStart, formatTokens, formatUsd,
} from '../src/shared/dashboard.ts';
import { filterSnapshot, filterUpdate } from '../src/main/access.ts';
import { Store } from '../src/main/store.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const win = (label, used, extra = {}) => ({ label, used, resetsAt: null, ...extra });
const LABELS = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };

// ---------- 日期
test('本機日期、移動日期、週一起算的本週', () => {
  assert.equal(localDate(new Date(2026, 10, 21, 23, 59).getTime()), '2026-11-21');
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  assert.equal(weekStart('2026-11-21'), '2026-11-16'); // 週六 → 那一週的週一
  assert.equal(weekStart('2026-11-16'), '2026-11-16'); // 週一就是自己
  assert.equal(weekStart('2026-11-22'), '2026-11-16'); // 週日算在同一週
  assert.equal(weekStart('2026-11-23'), '2026-11-23');
});

// ---------- 每週額度的判斷
test('每週額度:不分模型的「每週」優先,不會選到模型專屬的每週額度', () => {
  const r = budgetWindow([win('5 小時', 0.9), win('每週(Opus)', 0.8, { group: 'Opus', match: ['opus'] }), win('每週', 0.3)]);
  assert.equal(r.window.label, '每週');
  assert.equal(r.window.used, 0.3);
  assert.equal(r.days, 7);
});
test('每週額度:只有依模型分組的每週額度時(Antigravity),取用量最高的那一組', () => {
  const r = budgetWindow([win('5 小時', 0.2, { group: 'Flash' }), win('每週', 0.1, { group: 'Flash' }), win('5 小時', 0.9, { group: 'Pro' }), win('每週', 0.45, { group: 'Pro' })]);
  assert.equal(r.window.group, 'Pro');
  assert.equal(r.window.used, 0.45);
});
test('每週額度:沒有每週但有以天計算的額度時取最長的;只有小時的額度、沒有資料、空值都回傳 null', () => {
  const r = budgetWindow([win('5 小時', 0.5), win('3 天', 0.2), win('14 天', 0.6)]);
  assert.equal(r.window.label, '14 天');
  assert.equal(r.days, 14);
  assert.equal(budgetWindow([win('5 小時', 0.5), win('1 小時', 0.1)]), null);
  assert.equal(budgetWindow([]), null);
  assert.equal(budgetWindow(undefined), null);
  assert.equal(budgetWindow([{ label: '每週', used: Number.NaN, resetsAt: null }]), null);
});
test('預設每日預算:每週額度的 1/7(14.3%),視窗長度不同時跟著變', () => {
  assert.equal(defaultDailyBudget(), 14.3);
  assert.equal(defaultDailyBudget(7), 14.3);
  assert.equal(defaultDailyBudget(14), 7.1);
});
test('整理每日預算的設定值:0 到 100、小數一位;不合法的當成沒有設定', () => {
  assert.equal(normalizeBudget(20), 20);
  assert.equal(normalizeBudget('12.34'), 12.3);
  assert.equal(normalizeBudget(0), 0);
  assert.equal(normalizeBudget(100), 100);
  for (const bad of [-1, 101, 'abc', null, undefined, '', Number.NaN]) assert.equal(normalizeBudget(bad), null);
});

// ---------- 每日起點與今天的用量
const D = '2026-11-21';
test('起點:今天第一次讀到的讀數就是起點,今天的用量是 0;之後的讀數減起點', () => {
  let b = nextBaseline(null, 'claude', { date: D, used: 0.3, resetsAt: 1000 });
  assert.deepEqual(b, { date: D, backend: 'claude', base: 0.3, last: 0.3, resetsAt: 1000, warned: false });
  assert.equal(todayUsedPercent(b, D, 0), 0);
  b = nextBaseline(b, 'claude', { date: D, used: 0.362, resetsAt: 1000 });
  assert.equal(b.base, 0.3);
  assert.equal(todayUsedPercent(b, D, 0), 6.2);
});
test('起點:每週額度在當天重置(讀數大幅下降)→ 起點歸零,從重置後重新累計', () => {
  let b = nextBaseline(null, 'claude', { date: D, used: 0.8, resetsAt: 1000 });
  b = nextBaseline(b, 'claude', { date: D, used: 0.95, resetsAt: 1000 });
  assert.equal(todayUsedPercent(b, D, 0), 15);
  b = nextBaseline(b, 'claude', { date: D, used: 0.04, resetsAt: 1000 + 7 * 86400 });
  assert.equal(b.base, 0);
  assert.equal(todayUsedPercent(b, D, 0), 4);
  b = nextBaseline(b, 'claude', { date: D, used: 0.1, resetsAt: 1000 + 7 * 86400 });
  assert.equal(todayUsedPercent(b, D, 0), 10);
});
test('起點:重置後已經用回超過原本的起點,靠重置時間往後跳判斷得出來', () => {
  // 起點 10%、用到 12%,重置後下一次讀到 11%(降幅很小,但重置時間跳了一週)
  let b = nextBaseline(null, 'codex', { date: D, used: 0.10, resetsAt: 5000 });
  b = nextBaseline(b, 'codex', { date: D, used: 0.12, resetsAt: 5000 });
  assert.equal(quotaReset(b, { used: 0.11, resetsAt: 5000 + 7 * 86400 }), true);
  b = nextBaseline(b, 'codex', { date: D, used: 0.11, resetsAt: 5000 + 7 * 86400 });
  assert.equal(b.base, 0);
  assert.equal(todayUsedPercent(b, D, 0), 11);
});
test('起點:讀數小幅低於起點(誤差)不算重置,今天的用量不會是負的', () => {
  let b = nextBaseline(null, 'claude', { date: D, used: 0.30, resetsAt: null });
  b = nextBaseline(b, 'claude', { date: D, used: 0.29, resetsAt: null });
  assert.equal(quotaReset({ last: 0.30, resetsAt: null }, { used: 0.29, resetsAt: null }), false);
  assert.equal(b.base, 0.29);
  assert.equal(todayUsedPercent(b, D, 0), 0);
  b = nextBaseline(b, 'claude', { date: D, used: 0.33, resetsAt: null });
  assert.equal(todayUsedPercent(b, D, 0), 4);
});
test('跨日:昨天有讀數而且額度沒重置 → 沿用昨天最後的讀數當起點;今天還沒有讀數時算 0', () => {
  const y = { date: shiftDate(D, -1), backend: 'claude', base: 0.2, last: 0.35, resetsAt: Math.floor(new Date(2026, 10, 25).getTime() / 1000), warned: true };
  const now = new Date(2026, 10, 21, 8).getTime();
  assert.equal(todayUsedPercent(y, D, now), 0);
  const b = nextBaseline(y, 'claude', { date: D, used: 0.41, resetsAt: y.resetsAt });
  assert.equal(b.date, D);
  assert.equal(b.base, 0.35);
  assert.equal(b.warned, false); // 新的一天,語音提醒重新計
  assert.equal(todayUsedPercent(b, D, now), 6);
});
test('跨日:額度在夜裡重置、或上一筆紀錄是更早以前 → 今天第一筆讀數當起點', () => {
  const y = { date: shiftDate(D, -1), backend: 'claude', base: 0.2, last: 0.9, resetsAt: 100, warned: false };
  assert.equal(nextBaseline(y, 'claude', { date: D, used: 0.03, resetsAt: 100 + 7 * 86400 }).base, 0.03);
  const old = { ...y, date: shiftDate(D, -3), last: 0.1 };
  assert.equal(nextBaseline(old, 'claude', { date: D, used: 0.5, resetsAt: null }).base, 0.5);
});
test('缺資料:沒有任何紀錄、紀錄太舊、昨天的額度已經過了重置時間 → 今天的用量未知(null)', () => {
  const now = new Date(2026, 10, 21, 8).getTime();
  assert.equal(todayUsedPercent(null, D, now), null);
  assert.equal(todayUsedPercent({ date: shiftDate(D, -2), backend: 'claude', base: 0, last: 0.5, resetsAt: null, warned: false }, D, now), null);
  assert.equal(todayUsedPercent({ date: shiftDate(D, -1), backend: 'claude', base: 0, last: 0.5, resetsAt: Math.floor(now / 1000) - 60, warned: false }, D, now), null);
});
test('讀數超出 0 到 1 的範圍會被夾住', () => {
  assert.equal(nextBaseline(null, 'claude', { date: D, used: 1.4, resetsAt: null }).last, 1);
  assert.equal(nextBaseline(null, 'claude', { date: D, used: -0.2, resetsAt: null }).base, 0);
});

// ---------- 預算與提醒的門檻
test('預算等級:八成以上是快用完,超過才算超過(剛好等於不算),沒有預算或沒有讀數是 none', () => {
  assert.equal(budgetLevel(5, 14.3), 'ok');
  assert.equal(budgetLevel(11.4, 14.3), 'ok');
  assert.equal(budgetLevel(11.5, 14.3), 'near');
  assert.equal(budgetLevel(14.3, 14.3), 'near');
  assert.equal(budgetLevel(14.4, 14.3), 'over');
  assert.equal(budgetLevel(50, 0), 'none');
  assert.equal(budgetLevel(null, 14.3), 'none');
});
test('預算狀況:預設值、自訂值、沒有每週額度、後台不提供額度', () => {
  const usage = { backend: 'claude', windows: [win('5 小時', 0.5), win('每週', 0.5)], unsupported: false, updatedAt: 1 };
  const b = { date: D, backend: 'claude', base: 0.3, last: 0.5, resetsAt: null, warned: false };
  assert.deepEqual(budgetStatus('claude', usage, b, null, D, 0), { backend: 'claude', window: '每週', days: 7, budget: 14.3, custom: false, used: 20, level: 'over' });
  assert.deepEqual(budgetStatus('claude', usage, b, 25, D, 0), { backend: 'claude', window: '每週', days: 7, budget: 25, custom: true, used: 20, level: 'near' });
  assert.equal(budgetStatus('claude', usage, b, 0, D, 0).level, 'none');
  const hours = { backend: 'codex', windows: [win('5 小時', 0.5)], unsupported: false, updatedAt: 1 };
  assert.deepEqual(budgetStatus('codex', hours, null, null, D, 0), { backend: 'codex', window: null, days: 7, budget: 14.3, custom: false, used: null, level: 'none' });
  assert.equal(budgetStatus('codex', { ...usage, backend: 'codex', unsupported: true }, b, null, D, 0).window, null);
  assert.equal(budgetStatus('codex', undefined, null, null, D, 0).window, null);
  const grouped = { backend: 'antigravity', windows: [win('每週', 0.4, { group: 'Pro' })], unsupported: false, updatedAt: 1 };
  assert.equal(budgetStatus('antigravity', grouped, null, null, D, 0).window, 'Pro 每週');
});
test('額度快滿的門檻:90%,設了額度上限時是上限前 5%(取較低的)', () => {
  assert.equal(quotaWarnPercent(0), 90);
  assert.equal(quotaWarnPercent(100), 90);
  assert.equal(quotaWarnPercent(80), 75);
  assert.equal(quotaWarnPercent(3), 0);
});
test('提醒:超過預算、額度快滿、節點異常太久、預算快用完,依嚴重程度排序', () => {
  const now = 10_000_000;
  const input = {
    usage: [
      { backend: 'claude', windows: [win('5 小時', 0.91, { resetsAt: 123 }), win('每週', 0.5)], unsupported: false, updatedAt: 1 },
      { backend: 'codex', windows: [win('每週', 0.89)], unsupported: false, updatedAt: 1 },
      { backend: 'antigravity', windows: [win('每週', 0.99)], unsupported: true, updatedAt: 1 },
    ],
    budgets: [
      { backend: 'claude', window: '每週', days: 7, budget: 14.3, custom: false, used: 20, level: 'over' },
      { backend: 'codex', window: '每週', days: 7, budget: 14.3, custom: false, used: 12, level: 'near' },
      { backend: 'antigravity', window: '每週', days: 7, budget: 14.3, custom: false, used: 1, level: 'ok' },
    ],
    quotaStop: 0,
    agents: [
      { id: 'a', name: '甲', state: 'error', parentId: null, stateSince: now - 11 * 60000 },
      { id: 'b', name: '乙', state: 'lost', parentId: null, stateSince: now - 9 * 60000 },
      { id: 'c', name: '丙', state: 'error', parentId: 'a', stateSince: now - 60 * 60000 },
      { id: 'd', name: '丁', state: 'idle', parentId: null, stateSince: now - 60 * 60000 },
      { id: 'e', name: '戊', state: 'error', parentId: null },
    ],
    now,
  };
  const w = dashWarnings(input);
  assert.deepEqual(w.map(x => x.kind + (x.level ? `:${x.level}` : '')), ['budget:over', 'quota', 'fault', 'budget:near']);
  assert.equal(warningText(w[0], LABELS), 'Claude Code 今天已用 20%,超過每日預算 14.3%');
  assert.equal(warningText(w[1], LABELS), 'Claude Code 的5 小時額度已用 91%,快滿了');
  assert.equal(warningText(w[2], LABELS), '甲 出錯已經 11 分鐘');
  assert.equal(warningText(w[3], LABELS), 'Codex 今天已用 12%,快到每日預算 14.3%');
  // 額度上限 60% → 55% 起就提醒:Claude 的 5 小時、Codex 的每週都算,Claude 的每週(50%)不算
  assert.deepEqual(dashWarnings({ ...input, quotaStop: 60 }).filter(x => x.kind === 'quota').map(x => `${x.backend}/${x.label}`), ['claude/5 小時', 'codex/每週']);
  // 異常的門檻可以調:5 分鐘 → 乙(9 分鐘)也算
  assert.deepEqual(dashWarnings({ ...input, faultWarnMs: 5 * 60000 }).filter(x => x.kind === 'fault').map(x => x.agentName), ['甲', '乙']);
});

// ---------- 狀態數字
test('狀態數字:執行中、等你處理、排隊、異常各自包含哪些節點', () => {
  const a = (id, state, extra = {}) => ({ id, state, parentId: null, queued: [], ...extra });
  const g = statusGroups([
    a('1', 'working'), a('2', 'planning'), a('3', 'awaiting'), a('4', 'idle', { queued: [{}] }), a('5', 'error'), a('6', 'lost'), a('7', 'sleeping'),
    a('8', 'working', { parentId: '1' }), a('9', 'awaiting', { parentId: '1' }), a('10', 'error', { parentId: '1' }),
  ]);
  assert.deepEqual(g.running.map(x => x.id), ['1', '2']);
  assert.deepEqual(g.waiting.map(x => x.id), ['3', '9']);
  assert.deepEqual(g.queued.map(x => x.id), ['4']);
  assert.deepEqual(g.fault.map(x => x.id), ['5', '6']);
});

// ---------- 花費與任務
const rows = [
  { date: '2026-11-16', backend: 'claude', agentId: 'a', agentName: '甲', tokens: 1000, usd: 0.01 },
  { date: '2026-11-20', backend: 'claude', agentId: 'a', agentName: '甲', tokens: 2000, usd: 0.02 },
  { date: '2026-11-21', backend: 'claude', agentId: 'a', agentName: '甲改名', tokens: 3000, usd: 0.03 },
  { date: '2026-11-21', backend: 'codex', agentId: 'b', agentName: '乙', tokens: 9000, usd: 0 },
  { date: '2026-11-15', backend: 'codex', agentId: 'b', agentName: '乙', tokens: 500000, usd: 9 },
];
test('花費:今天與本週依後台、依節點加總;範圍外的日期不算', () => {
  const today = sumSpend(rows, '2026-11-21', '2026-11-21');
  assert.deepEqual(today.total, { tokens: 12000, usd: 0.03 });
  assert.deepEqual(today.byBackend, [{ backend: 'claude', tokens: 3000, usd: 0.03 }, { backend: 'codex', tokens: 9000, usd: 0 }]);
  assert.deepEqual(today.byAgent.map(r => [r.agentId, r.tokens]), [['b', 9000], ['a', 3000]]);
  const week = sumSpend(rows, '2026-11-16', '2026-11-21');
  assert.equal(week.total.tokens, 15000);
  assert.ok(Math.abs(week.total.usd - 0.06) < 1e-9);
  const a = week.byAgent.find(r => r.agentId === 'a');
  assert.equal(a.tokens, 6000);
  assert.equal(a.agentName, '甲改名');
  assert.deepEqual(sumSpend([], '2026-11-16', '2026-11-21'), { total: { tokens: 0, usd: 0 }, byBackend: [], byAgent: [] });
});
test('任務統計:交辦、完成、失敗、中斷、進行中(待授權算進行中)', () => {
  const per = countTasks([
    { agentId: 'a', status: 'done' }, { agentId: 'a', status: 'done' }, { agentId: 'a', status: 'failed' },
    { agentId: 'b', status: 'interrupted' }, { agentId: 'b', status: 'running' }, { agentId: 'b', status: 'awaiting' },
  ]);
  assert.deepEqual(per.find(r => r.agentId === 'a'), { agentId: 'a', assigned: 3, done: 2, failed: 1, interrupted: 0, running: 0 });
  assert.deepEqual(totalTasks(per), { assigned: 6, done: 2, failed: 1, interrupted: 1, running: 2 });
  assert.deepEqual(totalTasks([]), { assigned: 0, done: 0, failed: 0, interrupted: 0, running: 0 });
});
test('數字的顯示格式', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(20000), '20.0k');
  assert.equal(formatTokens(1234567), '1.23M');
  assert.equal(formatUsd(0), '—');
  assert.equal(formatUsd(0.08), '$0.080');
  assert.equal(formatUsd(1.5), '$1.50');
});

// ---------- 資料表:依日期彙總、額度起點、任務統計(真的寫進 SQLite 再讀出來)
const dir = mkdtempSync(join(tmpdir(), 'nexus-dash-'));
const store = new Store(join(dir, 'test.db'));
test('資料表:同一天、同一個後台、同一個節點的花費累加成一筆;不同天、不同節點分開', () => {
  store.addSpend('2026-11-20', 'claude', 'a', '甲', 1000, 0.01);
  store.addSpend('2026-11-21', 'claude', 'a', '甲', 2000, 0.02);
  store.addSpend('2026-11-21', 'claude', 'a', '甲改名', 500.4, 0.005);
  store.addSpend('2026-11-21', 'codex', 'b', '乙', 7000, 0);
  store.addSpend('2026-11-21', 'codex', 'b', '乙', -5, -1); // 負數不會倒扣
  const all = store.spendSince('2026-11-16');
  assert.equal(all.length, 3);
  const a21 = all.find(r => r.date === '2026-11-21' && r.agentId === 'a');
  assert.equal(a21.tokens, 2500);
  assert.ok(Math.abs(a21.usd - 0.025) < 1e-9);
  assert.equal(a21.agentName, '甲改名');
  assert.equal(all.find(r => r.agentId === 'b').tokens, 7000);
  assert.deepEqual(store.spendSince('2026-11-21').map(r => r.date), ['2026-11-21', '2026-11-21']);
  assert.equal(sumSpend(all, '2026-11-21', '2026-11-21').total.tokens, 9500);
});
test('資料表:額度起點每天每個後台一筆,讀出最近一天的;重複儲存是更新', () => {
  assert.equal(store.latestBaseline('claude'), null);
  store.saveBaseline({ date: '2026-11-20', backend: 'claude', base: 0.1, last: 0.2, resetsAt: 99, warned: true });
  store.saveBaseline({ date: '2026-11-21', backend: 'claude', base: 0.2, last: 0.25, resetsAt: null, warned: false });
  store.saveBaseline({ date: '2026-11-21', backend: 'claude', base: 0.2, last: 0.31, resetsAt: 500, warned: true });
  assert.deepEqual(store.latestBaseline('claude'), { date: '2026-11-21', backend: 'claude', base: 0.2, last: 0.31, resetsAt: 500, warned: true });
  assert.equal(store.latestBaseline('codex'), null);
});
test('資料表:任務記在交辦的那一天,狀態更新不會重複計;清除任務面板不影響統計', () => {
  store.recordTask('t1', '2026-11-21', 'a', 'running');
  store.recordTask('t1', '2026-11-21', 'a', 'done');
  store.recordTask('t2', '2026-11-21', 'b', 'failed');
  store.recordTask('t3', '2026-11-20', 'a', 'done');
  // 跨日才結束的任務仍算在交辦的那一天
  store.recordTask('t3', '2026-11-21', 'a', 'interrupted');
  store.deleteFinishedTasks();
  assert.deepEqual(totalTasks(countTasks(store.tasksOn('2026-11-21'))), { assigned: 2, done: 1, failed: 1, interrupted: 0, running: 0 });
  assert.deepEqual(store.tasksOn('2026-11-20'), [{ agentId: 'a', status: 'interrupted' }]);
});
test('資料表:太舊的每日紀錄會清掉', () => {
  store.pruneDaily('2026-11-21');
  assert.deepEqual(store.spendSince('2026-01-01').map(r => r.date), ['2026-11-21', '2026-11-21']);
  assert.equal(store.tasksOn('2026-11-20').length, 0);
  assert.equal(store.latestBaseline('claude').date, '2026-11-21');
});
store.close();
rmSync(dir, { recursive: true, force: true });

// ---------- 遠端裝置的權限:儀表資料只留看得到的節點
test('權限:限定節點的裝置只拿到範圍內節點的花費與任務統計;預算是帳號層級,照樣提供', () => {
  const dashboard = {
    date: D, weekStart: weekStart(D), faultWarnMs: 600000,
    budgets: [{ backend: 'claude', window: '每週', days: 7, budget: 14.3, custom: false, used: 20, level: 'over' }],
    spend: [{ ...rows[2] }, { ...rows[3] }, { date: D, backend: 'claude', agentId: 'gone', agentName: '已移除', tokens: 1, usd: 0 }],
    tasks: [{ agentId: 'a', assigned: 1, done: 1, failed: 0, interrupted: 0, running: 0 }, { agentId: 'b', assigned: 2, done: 0, failed: 2, interrupted: 0, running: 0 }],
  };
  const rootOf = id => (id === 'a' || id === 'b' ? id : null);
  const viewer = { role: 'viewer', agents: ['a'] };
  const snap = filterSnapshot({ agents: [], tasks: [], dashboard }, viewer, rootOf);
  assert.deepEqual(snap.dashboard.spend.map(r => r.agentId), ['a']);
  assert.deepEqual(snap.dashboard.tasks.map(r => r.agentId), ['a']);
  assert.deepEqual(snap.dashboard.budgets, dashboard.budgets);
  const upd = filterUpdate({ dashboard }, { role: 'operator', agents: ['b'] }, rootOf);
  assert.deepEqual(upd.dashboard.spend.map(r => r.agentId), ['b']);
  assert.deepEqual(upd.dashboard.tasks.map(r => r.agentId), ['b']);
  // 完整角色與「全部節點」的唯讀角色看得到全部(含已移除節點的花費)
  assert.equal(filterSnapshot({ agents: [], tasks: [], dashboard }, { role: 'full', agents: null }, rootOf).dashboard.spend.length, 3);
  assert.equal(filterSnapshot({ agents: [], tasks: [], dashboard }, { role: 'viewer', agents: null }, rootOf).dashboard.spend.length, 3);
  // 原本的資料不會被改動
  assert.equal(dashboard.spend.length, 3);
});
console.log(`通過 ${passed} 項`);
