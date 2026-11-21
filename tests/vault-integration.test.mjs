// 驗收:記憶庫與管理 app 的對接(長期記憶階段 4.5):統計檔內容、封存的圖像快照與欄位、`_` 資料夾不被索引、喚醒網址、原子寫入與限頻。
// 用法:node --no-warnings tests/vault-integration.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArchive, writeArchive } from '../src/main/memory-archive.ts';
import { computeNodeStats } from '../src/shared/node-stats.ts';
import { MemoryVault, README, entryFromFile, parseFrontMatter, readmeUpdate } from '../src/main/memory-vault.ts';
import { characterImages, snapshotDir } from '../src/main/vault-images.ts';
import { atomicWriteJson, buildVaultStats, readArchives, StatsWriter } from '../src/main/vault-stats.ts';
import { findWakeUrl, parseWakeUrl } from '../src/main/wake.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('[ok]', name); };
const tmp = () => mkdtempSync(join(tmpdir(), 'nexus-vi-'));
const NOW = new Date(2026, 10, 21, 15, 30);
const T0 = new Date(2026, 10, 20, 9, 0).getTime();
let n = 0;
const task = (agentId, status, o = {}) => ({ id: `t${++n}`, agentId, agentName: agentId, backend: 'claude', model: 'sonnet', title: `任務${n}`, status, note: '', steps: [], subs: [], startedAt: T0 + n * 60000, endedAt: status === 'running' ? null : T0 + n * 60000 + 90000, project: { id: 'p', name: '專案甲' }, ...o });
const node = { id: 'n1', name: 'Hagemi', backend: 'claude', backendLabel: 'Claude Code', model: 'sonnet', character: '小圓', createdAt: T0, sessionId: 'sess-1', cwd: 'C:/work' };

// 立繪資料夾:小圓有 avatar.webp 與 neutral.png
const portraits = tmp();
mkdirSync(join(portraits, '小圓'));
writeFileSync(join(portraits, '小圓', 'chibi_avatar.webp'), 'AVATAR');
writeFileSync(join(portraits, '小圓', 'neutral.png'), 'PORTRAIT');
mkdirSync(join(portraits, '空角色'));

await test('圖像查找:頭像(avatar、chibi_avatar)與 neutral;沒有角色或沒有圖就是 null;路徑跳脫被擋', () => {
  const r = characterImages(portraits, '小圓');
  assert.ok(r.avatar.endsWith('chibi_avatar.webp') && r.portrait.endsWith('neutral.png'));
  assert.deepEqual(characterImages(portraits, '空角色'), { avatar: null, portrait: null });
  assert.deepEqual(characterImages(portraits, ''), { avatar: null, portrait: null });
  assert.deepEqual(characterImages(portraits, '../小圓'), { avatar: null, portrait: null });
});

await test('封存:複製圖像快照,頭像、立繪屬性是相對封存檔的路徑;統計與接回用的欄位', () => {
  const vault = tmp();
  const tasks = [task('n1', 'done', { verdict: 'accepted' }), task('n1', 'failed'), task('n1', 'done', { verdict: 'rejected' })];
  const r = writeArchive(vault, { node, stats: computeNodeStats(tasks).get('n1'), tasks, traits: '', summary: '', summarySource: '無', noSummaryReason: 'x', cases: ['2026-0001', '2026-0002'], now: NOW, images: characterImages(portraits, '小圓') });
  const meta = parseFrontMatter(readFileSync(join(vault, r.path), 'utf8')).meta;
  assert.equal(meta.get('頭像'), '_圖像/n1/avatar.webp');
  assert.equal(meta.get('立繪'), '_圖像/n1/portrait.png');
  assert.equal(readFileSync(join(vault, 'nodes/封存/_圖像/n1/avatar.webp'), 'utf8'), 'AVATAR');
  assert.equal(readFileSync(join(vault, 'nodes/封存/_圖像/n1/portrait.png'), 'utf8'), 'PORTRAIT');
  assert.equal(snapshotDir('n1'), 'nodes/封存/_圖像/n1');
  const g = k => meta.get(k);
  assert.deepEqual([g('任務數'), g('完成數'), g('完成率'), g('驗收數'), g('退回數'), g('判例數')], ['3', '2', '0.67', '1', '1', '2']);
  assert.deepEqual([g('後台'), g('後台ID'), g('sessionId'), g('工作目錄')], ['Claude Code', 'claude', 'sess-1', 'C:/work']);
});

await test('封存:沒有角色或沒有圖像時省略 頭像、立繪;沒有 session 時省略 sessionId', () => {
  const vault = tmp();
  const bare = { ...node, character: '', sessionId: null, cwd: '' };
  const a = buildArchive({ node: bare, stats: undefined, tasks: [], traits: '', summary: '', summarySource: '無', noSummaryReason: '', cases: [], now: NOW });
  assert.equal(a.meta.頭像, undefined);
  const r = writeArchive(vault, { node: bare, stats: undefined, tasks: [], traits: '', summary: '', summarySource: '無', noSummaryReason: '', cases: [], now: NOW, images: characterImages(portraits, '空角色') });
  const meta = parseFrontMatter(readFileSync(join(vault, r.path), 'utf8')).meta;
  assert.equal(meta.has('頭像') || meta.has('立繪') || meta.has('sessionId') || meta.has('完成率'), false);
  assert.equal(meta.get('任務數'), '0');
  assert.equal(existsSync(join(vault, 'nodes/封存/_圖像')), false);
});

await test('索引:底線開頭的資料夾整個略過(圖像快照、其他附屬資料)', () => {
  const vault = tmp();
  writeArchive(vault, { node, stats: undefined, tasks: [], traits: '', summary: '', summarySource: '無', noSummaryReason: '', cases: [], now: NOW, images: characterImages(portraits, '小圓') });
  mkdirSync(join(vault, 'nodes/封存/_圖像/n1/子'), { recursive: true });
  writeFileSync(join(vault, 'nodes/封存/_圖像/n1/不是記憶.md'), '---\n種類: node\n---\n# 假的\n');
  mkdirSync(join(vault, 'knowledge/_附件'), { recursive: true });
  writeFileSync(join(vault, 'knowledge/_附件/筆記.md'), '# 附件\n');
  writeFileSync(join(vault, 'knowledge/正常.md'), '# 正常\n');
  const rows = new Map();
  const v = new MemoryVault(vault, { memoryAll: () => [...rows.values()], memoryPut: e => rows.set(e.path, e), memoryDelete: p => rows.delete(p) });
  v.rescan();
  const paths = [...rows.keys()].sort();
  assert.equal(paths.length, 2, paths.join(','));
  assert.ok(paths.some(p => p.startsWith('nodes/封存/Hagemi-')) && paths.includes('knowledge/正常.md'));
  v.init();
  assert.ok(readFileSync(join(vault, '說明.md'), 'utf8').includes('底線 _ 開頭的資料夾'));
});

const entryOf = (vault, rel) => entryFromFile(rel, readFileSync(join(vault, rel), 'utf8'), 1, 1);

await test('統計:節點的數字、狀態、圖像路徑、session 狀態、協作與同席', () => {
  const vault = tmp();
  const tasks1 = [task('n1', 'done', { verdict: 'accepted' }), task('n1', 'failed'), task('n1', 'done', { source: 'archive' })];
  const r = writeArchive(vault, { node: { ...node, id: 'old1', name: '舊的', sessionId: 'sess-old' }, stats: undefined, tasks: [], traits: '', summary: '', summarySource: '無', noSummaryReason: '', cases: ['2026-0001'], now: NOW, images: characterImages(portraits, '小圓') });
  const archives = readArchives(vault, [entryOf(vault, r.path)]);
  assert.equal(archives.length, 1);
  assert.ok(archives[0].avatar.endsWith('avatar.webp'));
  assert.equal(archives[0].backend, 'claude');
  const now = NOW.getTime();
  const mk = o => ({ now, portraitsDir: portraits, live: [], removed: [], archives: [], tasks: [], cases: [], dispatches: [], meetings: [], cliSessions: new Set(['claude:sess-2']), dirExists: p => p !== 'C:/gone', images: c => characterImages(portraits, c), ...o });
  const out = buildVaultStats(mk({
    live: [{ id: 'n1', name: 'Hagemi', character: '小圓', backend: 'claude', sessionId: 'sess-1', cwd: 'C:/work', state: 'idle' }, { id: 'n3', name: '睡著', character: '', backend: 'claude', sessionId: null, cwd: 'C:/work', state: 'sleeping' }],
    removed: [{ id: 'n2', name: '走了', character: '', backend: 'claude', sessionId: 'sess-2', cwd: 'C:/work' }, { id: 'n4', name: '目錄沒了', character: '', backend: 'claude', sessionId: 'sess-4', cwd: 'C:/gone' }],
    archives, tasks: tasks1,
    cases: [{ path: 'cases/p/a.md', kind: 'case', nodeId: 'n1' }, { path: 'cases/p/b.md', kind: 'case', nodeId: 'n1' }, { path: 'cases/p/c.md', kind: 'case', nodeId: 'zzz' }],
    dispatches: [
      { id: 'd1', startedAt: now - 1000, fromId: 'n1', toId: 'n2' }, { id: 'd2', startedAt: now - 5000, fromId: 'n1', toId: 'n2' },
      { id: 'd3', startedAt: now - 40 * 86400000, fromId: 'n1', toId: 'n2' }, { id: 'd4', startedAt: now - 2000, fromId: 'n2', toId: 'n1' },
    ],
    meetings: [{ id: 'm1', startedAt: now - 1000, endedAt: now, ids: ['n1', 'n2', 'n3'] }, { id: 'm2', startedAt: now - 2000, endedAt: now, ids: ['n3', 'n2', 'n1'] }, { id: 'm0', startedAt: now - 40 * 86400000, endedAt: now - 40 * 86400000, ids: ['n1', 'n2'] }],
  }));
  assert.deepEqual(Object.keys(out).sort(), ['協作', '同席', '圖像目錄', '更新時間', '節點'].sort());
  assert.equal(out.圖像目錄, portraits);
  assert.equal(out.更新時間, NOW.toISOString());
  const a = out.節點.n1;
  // 排除 archive 來源的任務:3 個任務裡算 2 個(1 完成、1 失敗)
  assert.deepEqual([a.名稱, a.角色, a.狀態, a.任務數, a.完成數, a.完成率, a.驗收數, a.退回數, a.判例數, a.專案], ['Hagemi', '小圓', '線上', 2, 1, 0.5, 1, 0, 2, ['專案甲']]);
  assert.ok(a.頭像路徑.endsWith('chibi_avatar.webp') && a.立繪路徑.endsWith('neutral.png'));
  assert.deepEqual(a.session, { 後台: 'claude', sessionId: 'sess-1', 主控台有紀錄: true, CLI有紀錄: false, 工作目錄存在: true, 可接回: false });
  assert.equal(out.節點.n3.狀態, '休眠');
  assert.equal(out.節點.n3.角色, null);
  assert.equal(out.節點.n3.頭像路徑, null);
  const b = out.節點.n2;
  assert.equal(b.狀態, '封存');
  assert.deepEqual(b.session, { 後台: 'claude', sessionId: 'sess-2', 主控台有紀錄: true, CLI有紀錄: true, 工作目錄存在: true, 可接回: true });
  assert.equal(out.節點.n4.session.可接回, false);
  const o = out.節點.old1;
  assert.deepEqual([o.狀態, o.任務數, o.判例數, o.session.主控台有紀錄, o.session.CLI有紀錄, o.session.可接回], ['封存', 0, 1, false, false, false]);
  assert.ok(o.頭像路徑.includes('_圖像') && o.頭像路徑.endsWith('avatar.webp'));
  assert.deepEqual(out.協作.map(c => [c.從, c.到, c.次數]), [['n1', 'n2', 2], ['n2', 'n1', 1]]);
  assert.equal(out.協作[0].最後, new Date(now - 1000).toISOString());
  assert.deepEqual(out.同席, [{ 節點: ['n1', 'n2', 'n3'], 次數: 2 }]);
  // CLI 清單還沒查到:CLI有紀錄 是 null,不影響 JSON 序列化
  const p = buildVaultStats(mk({ cliSessions: null, removed: [{ id: 'n2', name: '走了', character: '', backend: 'claude', sessionId: 'sess-2', cwd: 'C:/work' }] }));
  assert.equal(p.節點.n2.session.CLI有紀錄, null);
  assert.ok(JSON.parse(JSON.stringify(p)).節點.n2);
});

await test('統計:專案ID 和專案名稱同序同長度,同名不同專案的 ID 不同;沒有任務的節點兩個都是空清單', () => {
  const now = NOW.getTime();
  const tasks2 = [
    task('m1', 'done', { project: { id: 'c:/a/app', name: 'app' }, startedAt: now - 3000 }),
    task('m1', 'done', { project: { id: 'd:/b/app', name: 'app' }, startedAt: now - 2000 }),
    task('m1', 'done', { project: { id: 'c:/a/app', name: 'app' }, startedAt: now - 1000 }),
    task('m1', 'done', { project: undefined, startedAt: now - 500 }),
  ];
  const out = buildVaultStats({ now, portraitsDir: portraits, live: [{ id: 'm1', name: '甲', character: '', backend: 'claude', sessionId: null, cwd: 'C:/w', state: 'idle' }],
    removed: [{ id: 'm2', name: '乙', character: '', backend: 'claude', sessionId: 's', cwd: 'C:/w' }], archives: [], tasks: tasks2, cases: [], dispatches: [], meetings: [], cliSessions: null, dirExists: () => true, images: () => ({ avatar: null, portrait: null }) });
  const m = out.節點.m1;
  // 最近做的排前面:c:/a/app(最後一筆在 now-1000)、d:/b/app;舊任務沒有專案欄位就不列入
  assert.deepEqual(m.專案ID, ['c:/a/app', 'd:/b/app']);
  assert.deepEqual(m.專案, ['app', 'app'], '名稱欄位維持原樣(同名照列)');
  assert.equal(m.專案ID.length, m.專案.length);
  assert.equal(new Set(m.專案ID).size, 2, '同名不同專案算兩個');
  assert.deepEqual([out.節點.m2.專案, out.節點.m2.專案ID], [[], []]);
  // 舊欄位都還在(向下相容)
  for (const k of ['名稱', '角色', '狀態', '任務數', '完成數', '完成率', '驗收數', '退回數', '判例數', '專案', '頭像路徑', '立繪路徑', 'session']) assert.ok(k in m, k);
});

await test('說明檔:新版提到熱度檔與 .vault-awards.json;主控台寫過的舊版會換新,使用者改過的不動', () => {
  assert.ok(README.includes('.vault-awards.json 是記憶寶庫管理 App 專屬檔,用來記錄手動頒發的光暈;主控台不讀不寫,請勿手動刪除。'));
  assert.ok(README.includes('.nexus-heat.json') && README.includes('.nexus-stats.json') && !README.includes('還不會寫入'));
  assert.equal(readmeUpdate(null), README, '沒有檔案就寫新版');
  assert.equal(readmeUpdate(README), null, '已經是新版不動');
  assert.equal(readmeUpdate(README.replace(/\n/g, '\r\n')), null, '換行不同也算新版');
  assert.equal(readmeUpdate(`${README}\n我自己加的筆記\n`), null, '使用者改過不動');
  assert.equal(readmeUpdate(''), null, '讀不到內容不動');
  // 實際資料夾:舊版說明檔(第二版,有 .nexus-stats.json 那行)啟動時換成新版;改過的保留
  const v2 = README
    .replace(/記憶庫根目錄的 \.nexus-stats\.json\(節點統計\)[^\n]*\n\.vault-awards\.json[^\n]*\n/, '記憶庫根目錄的 .nexus-stats.json 是主控台定期寫出的節點統計(給管理 app 讀),.tmp 結尾的是寫入中的暫存檔,請忽略。\n')
    .replace(/主控台負責建立索引;[^\n]*\n節點會透過記憶工具寫入[^\n]*\n/, '主控台只負責讀取與建立索引;檔案在外面被修改、新增、刪除後會自動重新讀取。\n目前 agent 還不會寫入這裡(之後的版本才會),但放進來的檔案已經會被索引。\n');
  assert.notEqual(v2, README);
  assert.equal(readmeUpdate(v2), README, '第二版會換新');
  const v1 = v2.replace('以底線 _ 開頭的資料夾(例如 nodes/封存/_圖像/)是附屬資料(圖像快照等),不是記憶:不會被索引,記憶庫管理 app 也應忽略。\n記憶庫根目錄的 .nexus-stats.json 是主控台定期寫出的節點統計(給管理 app 讀),.tmp 結尾的是寫入中的暫存檔,請忽略。\n\n', '');
  assert.notEqual(v1, v2);
  assert.equal(readmeUpdate(`\uFEFF${v1.replace(/\n/g, '\r\n')}`), README, '第一版(含 BOM、CRLF)會換新');
  const store = { memoryAll: () => [], memoryPut() {}, memoryDelete() {} };
  const d1 = tmp();
  writeFileSync(join(d1, '說明.md'), v2);
  new MemoryVault(d1, store).init();
  assert.equal(readFileSync(join(d1, '說明.md'), 'utf8'), README);
  const d2 = tmp();
  writeFileSync(join(d2, '說明.md'), `${v2}\n我的註記\n`);
  new MemoryVault(d2, store).init();
  assert.equal(readFileSync(join(d2, '說明.md'), 'utf8'), `${v2}\n我的註記\n`);
});

await test('喚醒網址:解析與驗證', () => {
  assert.deepEqual(parseWakeUrl('entropy-nexus://wake?node=abc-123_X'), { ok: true, node: 'abc-123_X' });
  assert.deepEqual(parseWakeUrl('ENTROPY-NEXUS://WAKE/?node=a1'), { ok: true, node: 'a1' });
  for (const bad of ['', 'garbage', 'https://wake?node=a', 'entropy-nexus://wake', 'entropy-nexus://wake?node=', 'entropy-nexus://wake?node=a&node=b',
    'entropy-nexus://wake?node=../x', 'entropy-nexus://wake?node=a%20b', 'entropy-nexus://open?node=a', 'entropy-nexus://wake/x?node=a', `entropy-nexus://wake?node=${'a'.repeat(65)}`]) {
    assert.equal(parseWakeUrl(bad).ok, false, bad);
  }
  assert.equal(findWakeUrl(['a.exe', '--x', 'entropy-nexus://wake?node=a']), 'entropy-nexus://wake?node=a');
  assert.equal(findWakeUrl(['a.exe']), null);
});

await test('原子寫入:寫入成功、EPERM 重試後成功、重試用盡回傳 false 並清暫存檔', async () => {
  const dir = tmp();
  const file = join(dir, 's.json');
  assert.equal(await atomicWriteJson(file, { a: 1 }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 1 });
  assert.equal(existsSync(`${file}.tmp`), false);
  let calls = 0;
  const sleeps = [];
  const flaky = (from, to) => { if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); return renameReal(from, to); };
  const { renameSync: renameReal } = await import('node:fs');
  assert.equal(await atomicWriteJson(file, { a: 2 }, { rename: flaky, sleep: async ms => { sleeps.push(ms); } }), true);
  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 });
  calls = 0;
  const never = () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
  assert.equal(await atomicWriteJson(file, { a: 3 }, { rename: never, attempts: 3, sleep: async () => {} }), false);
  assert.equal(calls, 3);
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { a: 2 }, '失敗時保留上一份');
  // 不可重試的錯誤馬上放棄
  calls = 0;
  assert.equal(await atomicWriteJson(file, { a: 4 }, { rename: () => { calls++; throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, sleep: async () => {} }), false);
  assert.equal(calls, 1);
});

await test('限頻:5 秒內多次請求合併成一次寫入,失敗會再排一次', async () => {
  let t = 1000;
  const writes = [];
  let ok = true;
  const w = new StatsWriter(() => ({ at: t }), async d => { writes.push(d.at); return ok; }, 80, () => t);
  w.request(); w.request();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(writes.length, 1, '第一次立刻寫(兩次請求合併)');
  t += 10;
  w.request(); w.request(); w.request();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(writes.length, 1, '間隔不到下限先不寫');
  await new Promise(r => setTimeout(r, 120));
  assert.equal(writes.length, 2, '到時間後合併寫一次');
  ok = false;
  t += 200;
  w.request();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(writes.length, 3);
  ok = true;
  t += 200;
  await new Promise(r => setTimeout(r, 150));
  assert.equal(writes.length, 4, '寫入失敗後下一輪重試');
  w.stop();
});

console.log(`\n${passed} 項通過`);
