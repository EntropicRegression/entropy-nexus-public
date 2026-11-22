// 驗收:記憶的 MCP 工具(src/main/memory-tools.ts):搜尋排序與範圍、判例可見度、寫入權限、節點側寫特長章節、
// 專案知識上限、過時判斷,以及總管守則裡的特長。用法:node tests/memory-tools.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { entryFromFile } = await import('../src/main/memory-vault.ts');
const { writeMemory } = await import('../src/main/memory-write.ts');
import { chiefStatsSection, STATS_BUDGET } from '../src/shared/node-stats.ts';
import { register } from 'node:module';
// 測試直接載入 .ts:src 裡的相對匯入沒有副檔名(給打包器用),這裡註冊一個解析規則補上 .ts
register('data:text/javascript,' + encodeURIComponent(String.raw`export async function resolve(s,c,n){if(/^\.\.?\//.test(s)&&!/\.\w+$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}`), import.meta.url);
const { getSection, memoryRead, memorySearch, memoryWrite, nodeProfilePath, readNodeStrengths, scoreText, searchMemory, setSection, staleReason } = await import('../src/main/memory-tools.ts');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOW = Date.parse('2026-11-21T00:00:00Z');
const DAY = 24 * 3600 * 1000;
const PROJ = { id: 'c:/work/alpha', name: 'alpha', root: 'c:/work/alpha' };
const nodes = [{ id: 'n1', name: 'Hagemi', backendLabel: 'Claude Code', model: 'opus' }, { id: 'n2', name: 'Codex 一號', backendLabel: 'Codex', model: '' }];

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-memtools-'));
  for (const d of ['nodes', 'cases', 'knowledge', 'preferences', 'meetings']) mkdirSync(join(dir, d), { recursive: true });
  const notes = [];
  const ahead = { n: null };
  const deps = {
    vaultDir: dir,
    list: () => {
      const out = [];
      const walk = (rel) => {
        for (const f of readdirSyncSafe(join(dir, rel))) {
          const r = `${rel}/${f.name}`;
          if (f.isDirectory()) walk(r); else if (f.name.endsWith('.md')) out.push(entryFromFile(r, readFileSync(join(dir, r), 'utf8'), 0, 0));
        }
      };
      for (const d of ['nodes', 'cases', 'knowledge', 'preferences', 'meetings']) walk(d);
      return out;
    },
    rescan: () => {},
    nodes: () => nodes,
    project: async () => PROJ,
    head: async () => 'abc1234',
    commitsAhead: async () => ahead.n,
    noteChief: t => notes.push(t),
    now: () => NOW,
    ...extra,
  };
  return { dir, deps, notes, ahead };
}
import { readdirSync } from 'node:fs';
const readdirSyncSafe = p => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };

const put = (dir, rel, meta, body) => writeMemory(dir, rel, meta, body, 'replace', new Date(NOW));
const CHIEF = { id: 'c0', name: '總管', cwd: 'c:/work/alpha', isChief: true };
const WORKER = { id: 'n1', name: 'Hagemi', cwd: 'c:/work/alpha', isChief: false };
const iso = ms => new Date(ms).toISOString();

test('關鍵字分數:標題比內文重、中文子字串、相鄰兩字退而求其次、大小寫不分', () => {
  assert.ok(scoreText('登入', '登入流程', '別的') > scoreText('登入', '別的', '登入'));
  assert.ok(scoreText('REDIS', 'x', 'we use redis cache') > 0);
  assert.equal(scoreText('完全不相干', '標題', '內文'), 0);
  assert.ok(scoreText('快取失效問題', '快取設定', '處理失效') > 0);
});

test('搜尋:範圍是全域加呼叫者的專案,別的專案的看不到', async () => {
  const { dir, deps } = setup();
  put(dir, 'knowledge/alpha/a.md', { 種類: 'knowledge', 範圍: '專案', 專案ID: PROJ.id, 專案: 'alpha', 更新時間: iso(NOW) }, '部署要先跑 migrate。');
  put(dir, 'knowledge/beta/b.md', { 種類: 'knowledge', 範圍: '專案', 專案ID: 'c:/work/beta', 專案: 'beta', 更新時間: iso(NOW) }, '部署要先關防火牆。');
  put(dir, 'preferences/p.md', { 種類: 'preference', 範圍: '全域', 標題: '部署偏好', 更新時間: iso(NOW) }, '部署前先問我。');
  const hits = await searchMemory(deps, WORKER, { query: '部署' });
  assert.deepEqual(hits.map(h => h.entry.path).sort(), ['knowledge/alpha/a.md', 'preferences/p.md']);
  const other = await searchMemory(deps, WORKER, { query: '部署', project: 'beta' });
  assert.ok(other.some(h => h.entry.path === 'knowledge/beta/b.md') && !other.some(h => h.entry.path === 'knowledge/alpha/a.md'));
  const onlyKnowledge = await searchMemory(deps, WORKER, { query: '部署', kind: 'knowledge' });
  assert.equal(onlyKnowledge.length, 1);
  await assert.rejects(searchMemory(deps, WORKER, { query: 'x', kind: 'zzz' }), /kind/);
});

test('搜尋:只有已確認的判例看得到(未確認、退回、沒寫狀態都不行)', async () => {
  const { dir, deps } = setup();
  for (const [i, st] of ['已確認', '未確認', '退回', ''].entries()) {
    put(dir, `cases/alpha/${i}-案由.md`, { 種類: 'case', 專案ID: PROJ.id, 案由: `快取問題${i}`, ...(st ? { 狀態: st } : {}), 更新時間: iso(NOW) }, '快取要清掉');
  }
  const hits = await searchMemory(deps, WORKER, { query: '快取' });
  assert.deepEqual(hits.map(h => h.entry.path), ['cases/alpha/0-案由.md']);
});

test('搜尋:呼叫者自己的側寫與判例排最前面', async () => {
  const { dir, deps } = setup();
  put(dir, 'cases/alpha/1-別人.md', { 種類: 'case', 專案ID: PROJ.id, 案由: '圖表 圖表 圖表', 狀態: '已確認', 節點ID: 'n9', 更新時間: iso(NOW) }, '圖表圖表圖表圖表');
  put(dir, 'cases/alpha/2-自己.md', { 種類: 'case', 專案ID: PROJ.id, 案由: '圖表偶爾壞', 狀態: '已確認', 節點ID: 'n1', 更新時間: iso(NOW - 5 * DAY) }, '提到一次圖表');
  put(dir, nodeProfilePath(dir, nodes[0]), { 種類: 'node', 節點ID: 'n1', 節點: 'Hagemi', 更新時間: iso(NOW) }, '## 特長\n\n擅長圖表');
  const hits = await searchMemory(deps, WORKER, { query: '圖表' });
  assert.equal(hits.length, 3);
  assert.ok(hits[0].own && hits[1].own && !hits[2].own, hits.map(h => h.entry.path).join());
  assert.equal(hits[2].entry.path, 'cases/alpha/1-別人.md');
  const text = await memorySearch(deps, WORKER, { query: '圖表' });
  assert.ok(text.includes('(你自己的)') && text.includes('路徑:'));
  const byNode = await searchMemory(deps, WORKER, { query: '圖表', node: 'n9' });
  assert.deepEqual(byNode.map(h => h.entry.path), ['cases/alpha/1-別人.md']);
});

test('搜尋:輸出長度有上限、沒結果有說明', async () => {
  const { dir, deps } = setup();
  for (let i = 0; i < 30; i++) put(dir, `preferences/p${i}.md`, { 種類: 'preference', 標題: `偏好${i}`, 更新時間: iso(NOW) }, '關鍵字 ' + '很長的內容'.repeat(100));
  const text = await memorySearch(deps, WORKER, { query: '關鍵字' });
  assert.ok(text.length < 7000);
  assert.ok(text.includes('找到 30 筆'));
  assert.ok((await memorySearch(deps, WORKER, { query: '完全沒有的詞' })).includes('沒有符合'));
});

test('過時:超過 60 天,或專案知識的 commit 落後超過 200 個', async () => {
  assert.equal(staleReason(NOW - 59 * DAY, NOW, null), '');
  assert.ok(staleReason(NOW - 61 * DAY, NOW, null).includes('61'));
  assert.equal(staleReason(NOW, NOW, 200), '');
  assert.ok(staleReason(NOW, NOW, 201).includes('201'));
  const { dir, deps, ahead } = setup();
  put(dir, 'knowledge/alpha/old.md', { 種類: 'knowledge', 範圍: '專案', 專案ID: PROJ.id, 標題: '舊知識', 更新時間: iso(NOW - 90 * DAY) }, '舊知識內容');
  put(dir, 'knowledge/alpha/new.md', { 種類: 'knowledge', 範圍: '專案', 專案ID: PROJ.id, 標題: '新知識', 更新時間: iso(NOW), commit: 'abc1234' }, '新知識內容');
  put(dir, 'preferences/pp.md', { 種類: 'preference', 標題: '偏好知識', 更新時間: iso(NOW), commit: 'abc1234' }, '偏好知識內容');
  ahead.n = 500;
  let hits = await searchMemory(deps, WORKER, { query: '知識' });
  const by = Object.fromEntries(hits.map(h => [h.entry.path, h.stale]));
  assert.ok(by['knowledge/alpha/old.md'].includes('天'));
  assert.ok(by['knowledge/alpha/new.md'].includes('commit'));
  assert.equal(by['preferences/pp.md'], '', '全域的記憶不看 commit');
  assert.ok((await memorySearch(deps, WORKER, { query: '知識' })).includes('可能過時'));
  ahead.n = null; // git 失敗時忽略
  hits = await searchMemory(deps, WORKER, { query: '新知識' });
  assert.equal(hits.find(h => h.entry.path === 'knowledge/alpha/new.md').stale, '');
});

test('寫入權限:非總管被拒絕,case 不能用這個工具寫', async () => {
  const { dir, deps } = setup();
  await assert.rejects(memoryWrite(deps, WORKER, { kind: 'knowledge', title: 't', content: 'c' }), /只有總管/);
  await assert.rejects(memoryWrite(deps, CHIEF, { kind: 'case', title: 't', content: 'c' }), /case_submit/);
  await assert.rejects(memoryWrite(deps, CHIEF, { kind: 'knowledge', title: '', content: 'c' }), /需要 kind/);
  assert.ok(!existsSync(join(dir, 'knowledge', 'alpha')));
});

test('寫入:專案知識與偏好帶屬性、commit、更新時間,並遮罩祕密', async () => {
  const { dir, deps } = setup();
  const r = await memoryWrite(deps, CHIEF, { kind: 'knowledge', title: '部署流程', content: '先 migrate。password: hunter2secret' });
  assert.ok(r.includes('1 處'));
  const text = readFileSync(join(dir, 'knowledge', 'alpha', '部署流程.md'), 'utf8');
  const e = entryFromFile('knowledge/alpha/部署流程.md', text, 0, 0);
  assert.equal(e.kind, 'knowledge'); assert.equal(e.scope, '專案'); assert.equal(e.projectId, PROJ.id);
  assert.ok(text.includes('commit: abc1234') && text.includes('更新時間: 2026-11-21T00:00:00.000Z'));
  assert.ok(!text.includes('hunter2secret'));
  await memoryWrite(deps, CHIEF, { kind: 'preference', title: '回報要精簡', content: '一兩句就好' });
  const p = entryFromFile('preferences/回報要精簡.md', readFileSync(join(dir, 'preferences', '回報要精簡.md'), 'utf8'), 0, 0);
  assert.equal(p.kind, 'preference'); assert.equal(p.scope, '全域');
  // 同標題再寫:取代
  await memoryWrite(deps, CHIEF, { kind: 'preference', title: '回報要精簡', content: '改成三句' });
  assert.ok(readFileSync(join(dir, 'preferences', '回報要精簡.md'), 'utf8').includes('改成三句'));
});

test('節點側寫:只換特長章節,其他章節與屬性保留;找不到節點會說明', async () => {
  const { dir, deps } = setup();
  const r1 = await memoryWrite(deps, CHIEF, { kind: 'node', title: 'Hagemi', content: '前端與圖表\n也會寫測試' });
  assert.ok(r1.includes('Hagemi'));
  const rel = nodeProfilePath(dir, nodes[0]);
  const file = join(dir, ...rel.split('/'));
  let text = readFileSync(file, 'utf8');
  assert.ok(/種類: node/.test(text) && /節點ID: n1/.test(text) && /後台: Claude Code/.test(text) && /commit: abc1234/.test(text));
  assert.ok(text.includes('## 解決問題的流程'));
  // 模擬節點封存時填的流程章節
  writeMemory(dir, rel, { 種類: 'node', 節點ID: 'n1', 節點: 'Hagemi', 自訂: '保留', 更新時間: iso(NOW) }, setSection(text.split('\n---\n')[1] ?? '', '解決問題的流程', '1. 先看 log\n2. 再改'));
  assert.equal(getSection(readFileSync(file, 'utf8'), '解決問題的流程'), '1. 先看 log\n2. 再改');
  await memoryWrite(deps, CHIEF, { kind: 'node', title: 'hagemi', content: '只剩後端' });
  text = readFileSync(file, 'utf8');
  assert.equal(getSection(text.split('\n---\n').slice(1).join('\n---\n'), '特長'), '只剩後端');
  assert.ok(text.includes('1. 先看 log') && text.includes('自訂: 保留'));
  assert.equal(readNodeStrengths(dir, nodes[0]), '只剩後端');
  await assert.rejects(memoryWrite(deps, CHIEF, { kind: 'node', title: '不存在', content: 'x' }), /找不到節點/);
});

test('節點側寫:被使用者改過的檔案改為附加,不覆寫', async () => {
  const { dir, deps } = setup();
  const rel = nodeProfilePath(dir, nodes[0]);
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, ...rel.split('/')), '---\n種類: node\n節點: Hagemi\n---\n## 特長\n\n使用者手寫的特長\n');
  const r = await memoryWrite(deps, CHIEF, { kind: 'node', title: 'Hagemi', content: '總管想補的' });
  assert.ok(r.includes('附加'));
  const text = readFileSync(join(dir, ...rel.split('/')), 'utf8');
  assert.ok(text.includes('使用者手寫的特長') && text.includes('總管想補的') && text.includes('主控台補充'));
});

test('節點側寫依節點 ID 存放:同名的不同節點各一份、改名沿用原檔、舊版依名稱的檔案沒有 ID 才沿用', async () => {
  const twins = [{ id: 'aaaa1111-x', name: 'claudia', backendLabel: 'Claude Code', model: '' }, { id: 'bbbb2222-y', name: 'claudia', backendLabel: 'Claude Code', model: '' }];
  const { dir, deps } = setup({ nodes: () => twins });
  await memoryWrite(deps, CHIEF, { kind: 'node', title: 'aaaa1111-x', content: '甲的特長' });
  await memoryWrite(deps, CHIEF, { kind: 'node', title: 'bbbb2222-y', content: '乙的特長' });
  assert.equal(nodeProfilePath(dir, twins[0]), 'nodes/claudia-aaaa1111.md');
  assert.equal(nodeProfilePath(dir, twins[1]), 'nodes/claudia-bbbb2222.md');
  assert.equal(readNodeStrengths(dir, twins[0]), '甲的特長', '後寫的同名節點不會蓋掉先寫的');
  assert.equal(readNodeStrengths(dir, twins[1]), '乙的特長');
  // 改名:依 ID 找到原檔,不另開新檔
  const renamed = { ...twins[0], name: 'claudia 二代' };
  assert.equal(nodeProfilePath(dir, renamed), 'nodes/claudia-aaaa1111.md');
  // 舊版:nodes/<名稱>.md 沒有節點ID → 沿用;有別人的節點ID → 不碰,另開自己的
  const legacyDir = setup().dir;
  writeFileSync(join(legacyDir, 'nodes', 'Hagemi.md'), '---\n種類: node\n節點: Hagemi\n---\n## 特長\n\n舊的\n');
  assert.equal(nodeProfilePath(legacyDir, nodes[0]), 'nodes/Hagemi.md');
  writeFileSync(join(legacyDir, 'nodes', 'Hagemi.md'), '---\n種類: node\n節點ID: someone-else\n---\n## 特長\n\n別人的\n');
  assert.equal(nodeProfilePath(legacyDir, nodes[0]), 'nodes/Hagemi-n1.md');
  assert.equal(nodeProfilePath(legacyDir, { id: 'someone-else', name: 'Hagemi' }), 'nodes/Hagemi.md');
  // 封存資料夾裡的檔案不算側寫
  mkdirSync(join(legacyDir, 'nodes', '封存'), { recursive: true });
  writeFileSync(join(legacyDir, 'nodes', '封存', 'X-2026-01-01.md'), '---\n節點ID: zz\n狀態: 封存\n---\n');
  assert.equal(nodeProfilePath(legacyDir, { id: 'zz', name: 'X' }), 'nodes/X-zz.md');
});

test('專案知識上限:超過仍寫入,並通知總管一次', async () => {
  process.env.NEXUS_KNOWLEDGE_CAP = '';
  const { dir, deps, notes } = setup();
  const cap = (await import('../src/main/memory-tools.ts')).KNOWLEDGE_CAP;
  assert.equal(cap, 50);
  let last = '';
  for (let i = 0; i < cap; i++) last = await memoryWrite(deps, CHIEF, { kind: 'knowledge', title: `知識${i}`, content: `內容${i}` });
  assert.equal(notes.length, 0); assert.ok(!last.includes('上限'));
  last = await memoryWrite(deps, CHIEF, { kind: 'knowledge', title: '第五十一則', content: '多出來的' });
  assert.ok(existsSync(join(dir, 'knowledge', 'alpha', '第五十一則.md')), '仍然寫入');
  assert.ok(last.includes('上限'));
  assert.equal(notes.length, 1);
  assert.ok(notes[0].startsWith('(主控台通知:') && notes[0].includes('51') && notes[0].includes('重新整理'));
  await memoryWrite(deps, CHIEF, { kind: 'knowledge', title: '第五十二則', content: '再多一則' });
  assert.equal(notes.length, 1, '同一批不重複通知');
  await memoryWrite(deps, CHIEF, { kind: 'knowledge', title: '知識0', content: '改寫既有的' });
  assert.equal(notes.length, 1, '取代既有檔案不算新增');
});

test('總管守則:每個節點多一行特長,總長仍在預算內,超過時從後面捨去', () => {
  const ns = [{ id: 'a', name: 'Alpha', backendLabel: 'Claude Code', model: 'opus' }, { id: 'b', name: 'Beta', backendLabel: 'Codex', model: '' }];
  const st = new Map();
  const s = chiefStatsSection(ns, st, NOW, STATS_BUDGET, new Map([['a', '- 前端與圖表\n- 其他'], ['b', '後端效能調校'.repeat(30)]]));
  assert.ok(s.includes('特長:前端與圖表') && !s.includes('其他'));
  assert.ok(s.includes('memory_search'));
  const betaLines = s.split('\n').filter(l => l.includes('Beta') || l.startsWith('  特長:後端'));
  assert.ok(betaLines.length <= 2);
  assert.ok(s.split('\n').find(l => l.startsWith('  特長:後端')).length <= 90, '截短');
  assert.ok(s.length <= STATS_BUDGET);
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, name: `節點${i}`, backendLabel: 'Codex', model: '' }));
  const sm = chiefStatsSection(many, st, NOW, STATS_BUDGET, new Map(many.map(n => [n.id, '很會做事'.repeat(10)])));
  assert.ok(sm.length <= STATS_BUDGET && sm.includes('另有'), String(sm.length));
  assert.equal(chiefStatsSection(ns, st, NOW).includes('特長:'), false, '沒有側寫就不顯示');
});

const meetingFile = (status, project, topic, host = 'n1') => ['---', '種類: 會議紀錄', '範圍: 專案', `專案ID: ${project.id}`, `專案: ${project.name}`, `節點ID: ${host}`, '參與節點ID: [n1, n2]', `主題: ${topic}`, '更新時間: 2026-11-20', status === null ? '' : `狀態: ${status}`, '---', '# 逐字紀錄', `討論${topic}的重點是快取策略。`].filter(Boolean).join('\n');
function meetingSetup() {
  const env = setup();
  const other = { id: 'c:/work/beta', name: 'beta' };
  const w = (rel, text) => { mkdirSync(join(env.dir, rel.split('/').slice(0, -1).join('/')), { recursive: true }); writeFileSync(join(env.dir, rel), text); };
  w('meetings/alpha/2026-11-20-未確認會.md', meetingFile('未確認', PROJ, '未確認會'));
  w('meetings/alpha/2026-11-20-已確認會.md', meetingFile('已確認', PROJ, '已確認會'));
  w('meetings/alpha/2026-11-20-退回會.md', meetingFile('退回', PROJ, '退回會'));
  w('meetings/alpha/2026-11-20-空白狀態會.md', meetingFile(null, PROJ, '空白狀態會'));
  w('meetings/beta/2026-11-20-別案會.md', meetingFile('已確認', other, '別案會'));
  return env;
}

test('會議紀錄:索引成 meeting,標題取主題、nodeId 取主持人', () => {
  const { dir } = meetingSetup();
  const e = entryFromFile('meetings/alpha/2026-11-20-已確認會.md', readFileSync(join(dir, 'meetings/alpha/2026-11-20-已確認會.md'), 'utf8'), 0, 0);
  assert.equal(e.kind, 'meeting');
  assert.equal(e.title, '已確認會');
  assert.equal(e.nodeId, 'n1');
  assert.equal(e.scope, '專案');
  assert.equal(e.projectId, 'c:/work/alpha');
  assert.equal(e.status, '已確認');
});

test('會議紀錄:memory_search 只回已確認且同專案的,kind 與別名篩選有效,project 參數可查別專案', async () => {
  const { deps } = meetingSetup();
  const titles = hits => hits.map(h => h.entry.title).sort();
  assert.deepEqual(titles(await searchMemory(deps, WORKER, { query: '快取' })), ['已確認會']);
  assert.deepEqual(titles(await searchMemory(deps, WORKER, { query: '快取', kind: 'meeting' })), ['已確認會']);
  assert.deepEqual(titles(await searchMemory(deps, WORKER, { query: '快取', kind: '會議' })), ['已確認會']);
  assert.deepEqual(titles(await searchMemory(deps, WORKER, { query: '快取', kind: '會議紀錄' })), ['已確認會']);
  assert.deepEqual(titles(await searchMemory(deps, WORKER, { query: '快取', kind: 'case' })), []);
  assert.deepEqual(titles(await searchMemory(deps, WORKER, { query: '快取', project: 'beta' })), ['別案會']);
  const text = await memorySearch(deps, WORKER, { query: '快取', kind: 'meeting' });
  assert.ok(text.includes('[會議紀錄]'));
  await assert.rejects(() => searchMemory(deps, WORKER, { kind: 'xyz' }), /meeting/);
});

test('會議紀錄:memory_read 拒絕未確認、退回、空白狀態與別專案的,已確認的讀得到', async () => {
  const { deps, dir } = meetingSetup();
  for (const n of ['未確認會', '退回會', '空白狀態會']) await assert.rejects(() => memoryRead(deps, WORKER, { path: `meetings/alpha/2026-11-20-${n}.md` }), /找不到這則記憶/);
  await assert.rejects(() => memoryRead(deps, WORKER, { path: 'meetings/beta/2026-11-20-別案會.md' }), /其他專案/);
  const out = await memoryRead(deps, WORKER, { path: 'meetings/alpha/2026-11-20-已確認會.md' });
  assert.ok(out.includes('快取策略'));
  assert.ok(existsSync(join(dir, '.nexus-heat.json')), '讀取會計入熱度');
  assert.ok(readFileSync(join(dir, '.nexus-heat.json'), 'utf8').includes('meetings/alpha/2026-11-20-已確認會.md'));
});

test('會議紀錄:memory_write 不能寫 meeting(含別名),報錯說明由主控台自動寫入;其他種類不受影響', async () => {
  const { deps, dir } = meetingSetup();
  for (const kind of ['meeting', '會議', '會議紀錄', 'MEETING']) {
    await assert.rejects(memoryWrite(deps, CHIEF, { kind, title: '偷寫', content: '內容' }), /會議紀錄由主控台在散會時自動寫入,不能用 memory_write/);
  }
  assert.ok(!existsSync(join(dir, 'knowledge')) || !readdirSyncSafe(join(dir, 'knowledge')).length, '沒有落進 knowledge');
  const r = await memoryWrite(deps, CHIEF, { kind: 'knowledge', title: '正常知識', content: '照常寫入' });
  assert.ok(r.includes('knowledge/'));
});

test('會議紀錄:writeMeetingRecord 實際寫檔後被索引成 meeting、狀態未確認,memory_search 查不到', async () => {
  const { writeMeetingRecord } = await import('../src/main/meeting-record.ts');
  const { deps, dir } = setup();
  const res = writeMeetingRecord(dir, {
    id: 'm1', topic: '獨特的鯨魚話題', hostId: 'n1', hostName: 'Hagemi', participants: [{ id: 'n2', name: 'Codex 一號' }],
    projectId: PROJ.id, projectName: PROJ.name, startedAt: NOW, endedAt: NOW + 1000, endReason: '完成', conclusion: '結論鯨魚',
    transcript: [{ round: 1, name: 'Codex 一號', nodeId: 'n2', text: '鯨魚發言' }],
  });
  const e = entryFromFile(res.path, readFileSync(join(dir, ...res.path.split('/')), 'utf8'), 0, 0);
  assert.equal(e.kind, 'meeting');
  assert.equal(e.status, '未確認');
  assert.equal(e.title, '獨特的鯨魚話題');
  assert.equal(e.projectId, PROJ.id);
  assert.deepEqual(await searchMemory(deps, WORKER, { query: '鯨魚' }), []);
  assert.deepEqual(await searchMemory(deps, WORKER, { query: '鯨魚', kind: 'meeting' }), []);
});

for (const [name, fn] of tests) { await fn(); passed++; console.log('[ok]', name); }
console.log(`全部通過(${passed} 項)`);
