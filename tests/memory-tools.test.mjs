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
const { getSection, memorySearch, memoryWrite, nodeProfilePath, readNodeStrengths, scoreText, searchMemory, setSection, staleReason } = await import('../src/main/memory-tools.ts');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const NOW = Date.parse('2026-11-21T00:00:00Z');
const DAY = 24 * 3600 * 1000;
const PROJ = { id: 'c:/work/alpha', name: 'alpha', root: 'c:/work/alpha' };
const nodes = [{ id: 'n1', name: 'Hagemi', backendLabel: 'Claude Code', model: 'opus' }, { id: 'n2', name: 'Codex 一號', backendLabel: 'Codex', model: '' }];

function setup(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-memtools-'));
  for (const d of ['nodes', 'cases', 'knowledge', 'preferences']) mkdirSync(join(dir, d), { recursive: true });
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
      for (const d of ['nodes', 'cases', 'knowledge', 'preferences']) walk(d);
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
  put(dir, nodeProfilePath('Hagemi'), { 種類: 'node', 節點ID: 'n1', 節點: 'Hagemi', 更新時間: iso(NOW) }, '## 特長\n\n擅長圖表');
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
  const rel = nodeProfilePath('Hagemi');
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
  assert.equal(readNodeStrengths(dir, 'Hagemi'), '只剩後端');
  await assert.rejects(memoryWrite(deps, CHIEF, { kind: 'node', title: '不存在', content: 'x' }), /找不到節點/);
});

test('節點側寫:被使用者改過的檔案改為附加,不覆寫', async () => {
  const { dir, deps } = setup();
  const rel = nodeProfilePath('Hagemi');
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, ...rel.split('/')), '---\n種類: node\n節點: Hagemi\n---\n## 特長\n\n使用者手寫的特長\n');
  const r = await memoryWrite(deps, CHIEF, { kind: 'node', title: 'Hagemi', content: '總管想補的' });
  assert.ok(r.includes('附加'));
  const text = readFileSync(join(dir, ...rel.split('/')), 'utf8');
  assert.ok(text.includes('使用者手寫的特長') && text.includes('總管想補的') && text.includes('主控台補充'));
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

for (const [name, fn] of tests) { await fn(); passed++; console.log('[ok]', name); }
console.log(`全部通過(${passed} 項)`);
