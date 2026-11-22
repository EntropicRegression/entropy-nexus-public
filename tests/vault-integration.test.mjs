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
import { archiveProjects, atomicWriteJson, buildVaultStats, isProjectPath, readArchives, StatsWriter } from '../src/main/vault-stats.ts';
import { canResume, findWakeUrl, parseWakeUrl, wakeTargetOf } from '../src/main/wake.ts';
import { parseChiefTerms, updateChiefTerms, wasChief } from '../src/main/chief-tenure.ts';
import { projectKindFromPath } from '../src/main/project.ts';

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
  // 專案清單(2026-11-22 起):和 專案 同序
  assert.deepEqual([g('專案ID'), g('專案')], [['p'], ['專案甲']]);
});

await test('封存檔的專案清單:只剩封存檔的節點,統計檔改用它的 專案/專案ID;沒有清單的舊封存檔照舊是空的', () => {
  const vault = tmp();
  const proj = [{ id: 'c:/work/star-app', name: 'star-app' }, { id: 'c:/shared/test', name: 'test' }];
  const tasks = [task('n1', 'done', { project: proj[0] }), task('n1', 'done', { project: proj[1] })];
  const r = writeArchive(vault, { node: { ...node, id: 'arch1', name: '封存者' }, stats: computeNodeStats(tasks).get('n1'), tasks, traits: '', summary: '', summarySource: '無', noSummaryReason: '', cases: [], now: NOW });
  const old = writeArchive(vault, { node: { ...node, id: 'arch0', name: '舊封存' }, stats: undefined, tasks: [], traits: '', summary: '', summarySource: '無', noSummaryReason: '', cases: [], now: NOW });
  const entry = rel => entryFromFile(rel, readFileSync(join(vault, rel), 'utf8'), 1, 1);
  const archives = readArchives(vault, [entry(r.path), entry(old.path)]);
  const a1 = archives.find(a => a.nodeId === 'arch1');
  assert.deepEqual(a1.projects.map(p => p.id).sort(), ['c:/shared/test', 'c:/work/star-app']);
  assert.deepEqual(archives.find(a => a.nodeId === 'arch0').projects, []);
  const out = buildVaultStats({ now: NOW.getTime(), portraitsDir: portraits, live: [], removed: [], archives, tasks: [], cases: [], dispatches: [], meetings: [], cliSessions: null,
    dirExists: () => true, images: () => ({ avatar: null, portrait: null }), projectKind: id => (id.includes('shared') ? '資料夾' : 'git') });
  const n = out.節點.arch1;
  assert.deepEqual(n.專案ID.slice().sort(), ['c:/shared/test', 'c:/work/star-app']);
  assert.equal(n.專案.length, n.專案ID.length);
  assert.deepEqual(n.專案任務數, [0, 0], '沒有任務紀錄:近 90 天任務數都是 0');
  assert.deepEqual(out.專案表['c:/work/star-app'], { 名稱: 'star-app', 類型: 'git' });
  assert.deepEqual([out.節點.arch0.專案, out.節點.arch0.專案ID], [[], []]);
  // 長度不符或不是路徑形式的清單整個不用
  assert.deepEqual(archiveProjects(['c:/a', 'c:/b'], ['a']), []);
  assert.deepEqual(archiveProjects(['名稱'], ['名稱']), []);
  assert.deepEqual(archiveProjects('c:/a', 'a'), [{ id: 'c:/a', name: 'a' }]);
});

await test('協作專案不含總管:依交辦產生的任務的專案彙總;沒有任務時用指定的專案;總管與名稱形式的專案不算;舊欄位不變', () => {
  const now = NOW.getTime();
  const app = { id: 'c:/work/app', name: 'app' }, site = { id: 'd:/repo/site', name: 'site' };
  const tasks = [task('y', 'done', { id: 'ty1', project: app }), task('y', 'done', { id: 'ty2', project: site }), task('y', 'done', { id: 'ty3', project: app })];
  const out = buildVaultStats({ now, portraitsDir: portraits, live: [], removed: [], archives: [], tasks, cases: [], meetings: [], cliSessions: null,
    dirExists: () => true, images: () => ({ avatar: null, portrait: null }), chiefId: 'chief',
    dispatches: [
      { id: 'd1', startedAt: now - 3000, fromId: 'x', toId: 'y', taskId: 'ty1' },
      { id: 'd2', startedAt: now - 2000, fromId: 'x', toId: 'y', taskId: 'ty2', project: app }, // 任務的專案優先(site)
      { id: 'd3', startedAt: now - 1000, fromId: 'x', toId: 'y', taskId: 'ty3' },
      { id: 'd4', startedAt: now - 1000, fromId: 'x', toId: 'z', project: site }, // 沒有任務:用指定的專案
      { id: 'd5', startedAt: now - 1000, fromId: 'chief', toId: 'y', taskId: 'ty1' }, // 總管:不算
      { id: 'd6', startedAt: now - 1000, fromId: 'x', toId: 'w' }, // 沒有專案:不算
      { id: 'd7', startedAt: now - 1000, fromId: 'x', toId: 'w', project: { id: '舊名稱', name: '舊名稱' } }, // 名稱形式:不算
      { id: 'd8', startedAt: now - 40 * 86400000, fromId: 'x', toId: 'y', taskId: 'ty1' }, // 超過 30 天:不算
    ] });
  const rows = out.協作專案不含總管.map(c => [c.從, c.到, c.專案ID, c.專案, c.次數]).sort((a, b) => (a.join() < b.join() ? -1 : 1));
  assert.deepEqual(rows, [['x', 'y', 'c:/work/app', 'app', 2], ['x', 'y', 'd:/repo/site', 'site', 1], ['x', 'z', 'd:/repo/site', 'site', 1]]);
  assert.ok(out.協作專案不含總管.every(c => typeof c.最後 === 'string' && !Number.isNaN(Date.parse(c.最後))));
  // 舊欄位意義不變:協作不含總管 依 從→到 彙總,含沒有專案的交辦
  assert.deepEqual(out.協作不含總管.map(c => [c.從, c.到, c.次數]).sort(), [['x', 'w', 2], ['x', 'y', 3], ['x', 'z', 1]]);
  assert.ok('d:/repo/site' in out.專案表 && !('舊名稱' in out.專案表));
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
  // 舊欄位都在;2026-11-22 起另有專案表、總管任期與不含總管的協作、同席(只新增,不改舊欄位)
  assert.deepEqual(Object.keys(out).sort(), ['協作', '同席', '圖像目錄', '更新時間', '節點', '專案表', '總管任期', '協作不含總管', '同席不含總管', '協作專案不含總管'].sort());
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

await test('專案星系第一版:專案表兩種類型、總管旗標、專案任務數(近 90 天,和專案ID同序同長度)', () => {
  const now = NOW.getTime();
  const D = 86400000;
  const git = { id: 'c:/work/app', name: 'app', git: true };
  const folder = { id: 'c:/shared/test', name: 'test', git: false };
  const old = { id: 'c:/old/legacy', name: 'legacy' }; // 舊任務:沒有記下類型
  const tasks3 = [
    task('a1', 'done', { project: git, startedAt: now - 10 * D }),
    task('a1', 'done', { project: git, startedAt: now - 20 * D }),
    task('a1', 'done', { project: folder, startedAt: now - 5 * D }),
    task('a1', 'done', { project: old, startedAt: now - 120 * D }), // 超過 90 天:列在專案,任務數 0
    task('a1', 'done', { project: git, startedAt: now - 1 * D, source: 'archive' }), // 不是工作任務,不算
    task('b2', 'done', { project: folder, startedAt: now - 2 * D }),
  ];
  const asked = [];
  const mk = o => ({ now, portraitsDir: portraits, live: [{ id: 'a1', name: '甲', character: '', backend: 'claude', sessionId: null, cwd: 'C:/w', state: 'idle' }, { id: 'b2', name: '乙', character: '', backend: 'claude', sessionId: null, cwd: 'C:/w', state: 'idle' }],
    removed: [], archives: [], tasks: tasks3, cases: [
      { path: 'cases/x/1.md', kind: 'case', scope: '專案', projectId: 'd:/repo/other', nodeId: 'a1' },
      // 舊判例沒有 專案ID:主控台讀到的是名稱或資料夾名稱,不能進專案表
      { path: 'cases/app/2.md', kind: 'case', scope: '專案', projectId: 'app', nodeId: 'a1' },
      { path: 'cases/舊專案/3.md', kind: 'case', scope: '專案', projectId: '舊專案', nodeId: 'b2' },
    ], dispatches: [], meetings: [], cliSessions: null, dirExists: () => true,
    images: () => ({ avatar: null, portrait: null }), projectKind: id => { asked.push(id); return id === 'd:/repo/other' ? 'git' : '資料夾'; }, ...o });
  const out = buildVaultStats(mk({ chiefId: 'b2' }));
  const a = out.節點.a1;
  assert.equal(a.專案ID.length, a.專案.length);
  assert.equal(a.專案任務數.length, a.專案ID.length, '專案任務數和專案ID同長度');
  const count = Object.fromEntries(a.專案ID.map((id, k) => [id, a.專案任務數[k]]));
  assert.deepEqual(count, { 'c:/work/app': 2, 'c:/shared/test': 1, 'c:/old/legacy': 0 });
  assert.deepEqual(out.專案表['c:/work/app'], { 名稱: 'app', 類型: 'git' });
  assert.deepEqual(out.專案表['c:/shared/test'], { 名稱: 'test', 類型: '資料夾' });
  assert.equal(out.專案表['c:/old/legacy'].類型, '資料夾', '舊任務沒記類型:問 projectKind');
  assert.equal(out.專案表['d:/repo/other'].類型, 'git', '判例裡的專案也列進專案表');
  assert.ok(asked.includes('c:/old/legacy') && !asked.includes('c:/work/app'), '任務已記下類型的不再判斷');
  // 名稱形式的鍵不進專案表(不會多出假的「資料夾」),也不會被拿去判斷類型
  assert.ok(!('app' in out.專案表) && !('舊專案' in out.專案表), Object.keys(out.專案表).join());
  assert.ok(Object.keys(out.專案表).every(isProjectPath), '專案表的鍵都是路徑形式');
  assert.ok(!asked.includes('app') && !asked.includes('舊專案'));
  assert.deepEqual(Object.keys(out.專案表).sort(), ['c:/old/legacy', 'c:/shared/test', 'c:/work/app', 'd:/repo/other']);
  // 既有欄位不受影響:判例數仍計入舊判例
  assert.equal(out.節點.a1.判例數, 2);
  assert.equal(out.節點.b2.判例數, 1);
  for (const id of ['c:/a/b', 'C:/A/B', '/home/x/repo', '//server/share/repo']) assert.equal(isProjectPath(id), true, id);
  for (const id of ['app', '舊專案', 'cases', '', null, undefined, 'a:b']) assert.equal(isProjectPath(id), false, String(id));
  // 總管旗標:換總管前後
  assert.equal(out.節點.b2.總管, true);
  assert.equal(a.總管, false);
  const after = buildVaultStats(mk({ chiefId: 'a1' }));
  assert.equal(after.節點.a1.總管, true);
  assert.equal(after.節點.b2.總管, false);
  // 沒有總管、也沒傳新欄位時(舊呼叫方式)不會壞:舊欄位照舊
  const plain = buildVaultStats(mk({ projectKind: undefined }));
  assert.equal(plain.節點.a1.總管, false);
  assert.deepEqual(plain.總管任期, []);
  for (const k of ['名稱', '角色', '狀態', '任務數', '完成數', '完成率', '驗收數', '退回數', '判例數', '專案', '專案ID', '頭像路徑', '立繪路徑', 'session']) assert.ok(k in plain.節點.a1, k);
  for (const k of ['更新時間', '圖像目錄', '節點', '協作', '同席']) assert.ok(k in plain, k);
});

await test('總管任期:換人時結束舊任期、開新任期;依任期判斷當時是不是總管', () => {
  let terms = updateChiefTerms([], { id: 'c1', name: '總管一' }, 1000);
  assert.deepEqual(terms, [{ id: 'c1', name: '總管一', from: 1000, to: null }]);
  assert.deepEqual(updateChiefTerms(terms, { id: 'c1', name: '總管一' }, 1500), terms, '同一個人不變:不開新任期');
  terms = updateChiefTerms(terms, { id: 'c2', name: '總管二' }, 2000);
  assert.deepEqual(terms, [{ id: 'c1', name: '總管一', from: 1000, to: 2000 }, { id: 'c2', name: '總管二', from: 2000, to: null }]);
  terms = updateChiefTerms(terms, null, 3000);
  assert.equal(terms[1].to, 3000);
  assert.deepEqual(parseChiefTerms(JSON.stringify(terms)), terms);
  assert.deepEqual(parseChiefTerms('壞掉'), []);
  assert.deepEqual(parseChiefTerms('[{"id":1}]'), []);
  assert.equal(wasChief(terms, null, 'c1', 1500), true);
  assert.equal(wasChief(terms, null, 'c1', 2500), false, '換人之後不是');
  assert.equal(wasChief(terms, null, 'c2', 2500), true);
  assert.equal(wasChief(terms, null, 'c2', 3500), false, '解除之後不是');
  assert.equal(wasChief(terms, 'c9', 'c9', 500), true, '任期紀錄開始之前,以現任總管判斷');
  assert.equal(wasChief([], 'c9', 'c9', 99999), true);
});

await test('不含總管的協作與同席:標記為總管發出、或當時一端是總管的不算;舊欄位照舊全部算', () => {
  const now = NOW.getTime();
  const terms = [{ id: 'old', name: '前任', from: now - 20000, to: now - 10000 }, { id: 'cur', name: '現任', from: now - 10000, to: null }];
  const out = buildVaultStats({ now, portraitsDir: portraits, live: [], removed: [], archives: [], tasks: [], cases: [], cliSessions: null, dirExists: () => true,
    images: () => ({ avatar: null, portrait: null }), chiefId: 'cur', chiefTerms: terms,
    dispatches: [
      { id: 'd1', startedAt: now - 1000, fromId: 'x', toId: 'y' },
      { id: 'd2', startedAt: now - 1000, fromId: 'cur', toId: 'y' }, // 現任總管發出(依任期)
      { id: 'd3', startedAt: now - 15000, fromId: 'old', toId: 'y' }, // 前任在任時發出
      { id: 'd4', startedAt: now - 1000, fromId: 'old', toId: 'y' }, // 前任卸任後發出:算
      { id: 'd5', startedAt: now - 1000, fromId: 'x', toId: 'z', fromChief: true }, // 記錄當下標記為總管發出
      { id: 'd6', startedAt: now - 1000, fromId: 'y', toId: 'cur' }, // 交辦給總管:不算
    ],
    meetings: [
      { id: 'm1', startedAt: now - 1000, endedAt: now, ids: ['x', 'y', 'cur'] }, // 總管只是參與者:拿掉總管後 x、y 仍算
      { id: 'm2', startedAt: now - 1000, endedAt: now, ids: ['cur', 'x', 'y'] }, // 總管召開:不算
      { id: 'm3', startedAt: now - 1000, endedAt: now, ids: ['x', 'y'], chiefHost: true }, // 標記為總管召開:不算
    ] });
  assert.equal(out.協作.length, 6 - 1, '舊欄位 協作 不變(依 從→到 彙總,old→y 兩筆合併)');
  assert.deepEqual(out.協作不含總管.map(c => [c.從, c.到, c.次數]).sort(), [['old', 'y', 1], ['x', 'y', 1]]);
  assert.deepEqual(out.同席.map(s => s.節點.join()), ['cur,x,y', 'x,y']);
  assert.deepEqual(out.同席不含總管, [{ 節點: ['x', 'y'], 次數: 1 }]);
  assert.deepEqual(out.總管任期.map(t => [t.節點, t.結束 === null]), [['old', false], ['cur', true]]);
});

await test('專案類型只看檔案:有 .git 或是 bare 版本庫算 git,其餘與不存在的路徑算資料夾', () => {
  const has = set => p => set.has(p.replace(/\\/g, '/'));
  assert.equal(projectKindFromPath('c:/r', has(new Set(['c:/r/.git']))), 'git');
  assert.equal(projectKindFromPath('c:/bare', has(new Set(['c:/bare/HEAD', 'c:/bare/objects']))), 'git');
  assert.equal(projectKindFromPath('c:/plain', has(new Set(['c:/plain/HEAD']))), '資料夾');
  assert.equal(projectKindFromPath('c:/gone', () => false), '資料夾');
  assert.equal(projectKindFromPath('c:/err', () => { throw new Error('x'); }), '資料夾');
});

await test('可接回與喚醒用同一個判斷:統計檔標可接回的一定喚醒得回;只存在於封存檔、超過已終止清單上限的不標', () => {
  const now = NOW.getTime();
  const exists = p => !p.startsWith('C:/gone');
  const live = [{ id: 'on1', name: '在線', character: '', backend: 'claude', sessionId: 's-on', cwd: 'C:/w', state: 'idle', parentId: null }];
  // 資料庫的已終止節點清單(主控台只取最近 200 個;清單外的節點只剩封存檔)
  const removed = [
    { id: 'r-ok', name: '可接回', character: '', backend: 'claude', sessionId: 's-ok', cwd: 'C:/w', model: '' },
    { id: 'r-gone', name: '目錄沒了', character: '', backend: 'codex', sessionId: 's-gone', cwd: 'C:/gone/x', model: '' },
  ];
  // 只存在於封存檔:CLI 自己的紀錄裡有這個 session、工作目錄也在(舊規則會標可接回)
  const archives = [{ nodeId: 'a-only', name: '只有封存檔', character: '', backend: 'claude', sessionId: 's-arch', cwd: 'C:/w', tasks: 1, done: 1, completionRate: 1, accepted: 1, rejected: 0, cases: 0, avatar: null, portrait: null, at: now - 1000 },
    // 超過清單上限:資料庫還有這個節點,但不在 loadRemovedAgents 取回的 200 個裡,只能從封存檔看到
    { nodeId: 'r-old', name: '超過上限', character: '', backend: 'claude', sessionId: 's-old', cwd: 'C:/w', tasks: 0, done: 0, completionRate: null, accepted: 0, rejected: 0, cases: 0, avatar: null, portrait: null, at: now - 2000 }];
  const out = buildVaultStats({ now, portraitsDir: portraits, live, removed, archives, tasks: [], cases: [], dispatches: [], meetings: [],
    cliSessions: new Set(['claude:s-arch', 'claude:s-old', 'claude:s-ok', 'codex:s-gone']), dirExists: exists, images: () => ({ avatar: null, portrait: null }) });
  const can = id => out.節點[id].session.可接回;
  assert.deepEqual(['on1', 'r-ok', 'r-gone', 'a-only', 'r-old'].map(can), [false, true, false, false, false]);
  assert.equal(out.節點['a-only'].session.CLI有紀錄, true, 'CLI 有紀錄仍照實報告,只是不算可接回');
  // 喚醒網址的判斷:和統計檔一致
  for (const id of Object.keys(out.節點)) {
    const t = wakeTargetOf(id, live, removed, exists);
    assert.equal(t?.kind === 'removed', can(id), id);
  }
  assert.equal(wakeTargetOf('on1', live, removed, exists).kind, 'board');
  assert.deepEqual(wakeTargetOf('r-gone', live, removed, exists), { kind: 'unavailable', name: '目錄沒了', reason: '原本的工作目錄已經不存在' });
  assert.equal(wakeTargetOf('a-only', live, removed, exists), null, '只有封存檔:找不到(不會用新的節點 ID 接回)');
  assert.deepEqual(wakeTargetOf('r-ok', live, removed, exists).input, { backend: 'claude', sessionId: 's-ok', cwd: 'C:/w', agentId: 'r-ok', name: '可接回', character: '', model: '' });
  assert.equal(canResume({ sessionId: null, cwd: 'C:/w' }, true, exists), false);
  assert.equal(canResume({ sessionId: 's', cwd: '' }, true, exists), false);
  assert.equal(canResume({ sessionId: 's', cwd: 'C:/w' }, false, exists), false);
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
