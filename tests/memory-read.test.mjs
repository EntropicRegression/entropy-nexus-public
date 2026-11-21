// 驗收:memory_read、搜尋的新規則(排除回顧段、未確認與退回、取代、子類與書籤排序)與 .nexus-heat.json、原子寫入。
// 用法:node tests/memory-read.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(String.raw`export async function resolve(s,c,n){if(/^\.\.?\//.test(s)&&!/\.\w+$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}`), import.meta.url);
const { entryFromFile } = await import('../src/main/memory-vault.ts');
const { cleanVaultPath, memoryRead, memorySearch, searchMemory, stripReview, READ_OUTPUT_MAX } = await import('../src/main/memory-tools.ts');
const { RETRY_DELAYS, flushHeat, heatOf, resetHeat, writeJsonAtomic } = await import('../src/main/vault-sidecar.ts');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const NOW = Date.parse('2026-11-21T00:00:00Z');
const PROJ = { id: 'c:/work/alpha', name: 'alpha', root: 'c:/work/alpha' };
const WORKER = { id: 'n1', name: 'Hagemi', cwd: 'c:/work/alpha', isChief: false };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-memread-'));
  const deps = {
    vaultDir: dir,
    list: () => {
      const out = [];
      const walk = rel => {
        for (const f of readdirSync(join(dir, rel), { withFileTypes: true })) {
          const r = `${rel}/${f.name}`;
          if (f.isDirectory()) { if (!f.name.startsWith('_')) walk(r); } else if (f.name.endsWith('.md')) out.push(entryFromFile(r, readFileSync(join(dir, r), 'utf8'), 0, 0));
        }
      };
      for (const d of ['nodes', 'cases', 'knowledge', 'preferences']) if (existsSync(join(dir, d))) walk(d);
      return out;
    },
    rescan: () => {}, nodes: () => [], project: async () => PROJ, head: async () => null, commitsAhead: async () => null, noteChief: () => {}, now: () => NOW,
  };
  const put = (rel, front, body) => {
    const f = join(dir, ...rel.split('/'));
    mkdirSync(join(f, '..'), { recursive: true });
    writeFileSync(f, `---\n${Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`);
  };
  return { dir, deps, put };
}
const know = (extra = {}) => ({ 種類: 'knowledge', 範圍: '專案', 專案ID: PROJ.id, 專案: 'alpha', 更新時間: '2026-11-20', ...extra });
const msg = async p => { try { await p; return ''; } catch (e) { return String(e.message); } };

test('stripReview:沒有回顧、回顧在中間、回顧在最後、程式碼區塊裡的 ## 不算', () => {
  assert.deepEqual(stripReview('# 標題\n\n內容\n'), { text: '# 標題\n\n內容\n', had: false });
  const mid = stripReview('# 標題\n\n內容\n\n## 回顧\n事後說明\n多行\n\n## 後記\n之後的章節\n');
  assert.ok(mid.had && !mid.text.includes('事後說明') && mid.text.includes('## 後記') && mid.text.includes('之後的章節') && mid.text.includes('內容'));
  const end = stripReview('# 標題\n內容\n## 回顧\n結尾的回顧\n');
  assert.ok(end.had && !end.text.includes('回顧') && end.text.trim().endsWith('內容'));
  const fence = stripReview('## 回顧\nA\n```\n## 假標題\n```\nB\n## 其他\nC\n');
  assert.ok(!fence.text.includes('B') && fence.text.includes('C'));
  assert.ok(stripReview('### 回顧\n三級標題不是回顧段\n').had === false);
});

test('cleanVaultPath:拒絕庫外、絕對路徑、非 .md、_ 與 . 開頭的資料夾', () => {
  const dir = tmpdir();
  for (const bad of ['', '../x.md', 'a/../../x.md', '/etc/passwd.md', 'C:/x.md', 'a/b.txt', 'nodes/封存/_圖像/n1/a.md', '.git/x.md', 'a//b.md', 'knowledge/..\\..\\x.md']) assert.throws(() => cleanVaultPath(dir, bad), undefined, bad);
  assert.equal(cleanVaultPath(dir, 'knowledge\\alpha\\標題.md'), 'knowledge/alpha/標題.md');
});

test('memory_read:預設不含回顧,include_review 才含;一律記熱度', async () => {
  const { dir, deps, put } = setup();
  put('knowledge/alpha/甲.md', know({ 標題: '甲' }), '# 甲\n正文\n\n## 回顧\n這是回顧\n');
  resetHeat(dir);
  const a = await memoryRead(deps, WORKER, { path: 'knowledge/alpha/甲.md' });
  assert.ok(a.includes('正文') && !a.includes('這是回顧') && a.includes('include_review'));
  const b = await memoryRead(deps, WORKER, { path: 'knowledge/alpha/甲.md', include_review: true });
  assert.ok(b.includes('這是回顧') && b.includes('種類: knowledge'));
  assert.equal(heatOf(dir)['knowledge/alpha/甲.md'].召回次數, 2);
  const noReview = await memoryRead(deps, WORKER, { path: 'knowledge/alpha/甲.md' });
  assert.ok(noReview);
  flushHeat(dir);
});

test('memory_read:可見規則(未確認、退回、未確認判例、別的專案、不存在、庫外)', async () => {
  const { dir, deps, put } = setup();
  resetHeat(dir);
  put('knowledge/alpha/草稿.md', know({ 狀態: '未確認' }), '草稿');
  put('knowledge/alpha/退.md', know({ 狀態: '退回' }), '退回的');
  put('preferences/草稿偏好.md', { 種類: 'preference', 範圍: '全域', 狀態: '未確認' }, '偏好草稿');
  put('cases/alpha/1.md', { 種類: 'case', 範圍: '專案', 專案ID: PROJ.id, 狀態: '未確認' }, '待確認判例');
  put('cases/alpha/2.md', { 種類: 'case', 範圍: '專案', 專案ID: PROJ.id, 狀態: '已確認' }, '確認判例');
  put('knowledge/beta/乙.md', { 種類: 'knowledge', 範圍: '專案', 專案ID: 'c:/work/beta', 專案: 'beta' }, '別的專案');
  put('preferences/全域.md', { 種類: 'preference', 範圍: '全域' }, '全域偏好');
  for (const p of ['knowledge/alpha/草稿.md', 'knowledge/alpha/退.md', 'preferences/草稿偏好.md', 'cases/alpha/1.md', 'knowledge/beta/乙.md', 'knowledge/alpha/不存在.md']) assert.ok(await msg(memoryRead(deps, WORKER, { path: p })), p);
  assert.ok((await memoryRead(deps, WORKER, { path: 'cases/alpha/2.md' })).includes('確認判例'));
  assert.ok((await memoryRead(deps, WORKER, { path: 'preferences/全域.md' })).includes('全域偏好'));
  assert.ok(await msg(memoryRead(deps, WORKER, { path: '../outside.md' })));
  assert.deepEqual(Object.keys(heatOf(dir)).sort(), ['cases/alpha/2.md', 'preferences/全域.md'], '讀不到的不記熱度');
  flushHeat(dir);
});

test('memory_read:超過上限會截斷', async () => {
  const { dir, deps, put } = setup();
  resetHeat(dir);
  put('knowledge/alpha/長.md', know(), '字'.repeat(READ_OUTPUT_MAX + 500));
  const out = await memoryRead(deps, WORKER, { path: 'knowledge/alpha/長.md' });
  assert.ok(out.includes('已截斷') && out.length < READ_OUTPUT_MAX + 200);
  flushHeat(dir);
});

test('搜尋:排除回顧段(計分與摘錄)、未確認與退回', async () => {
  const { dir, deps, put } = setup();
  put('knowledge/alpha/甲.md', know(), '# 甲\n一般內容\n\n## 回顧\n獨特詞彙zzq\n');
  put('knowledge/alpha/乙.md', know(), '# 乙\n獨特詞彙zzq 在正文\n');
  put('knowledge/alpha/丙.md', know({ 狀態: '未確認' }), '獨特詞彙zzq 草稿');
  put('preferences/丁.md', { 種類: 'preference', 範圍: '全域', 狀態: '退回' }, '獨特詞彙zzq 退回');
  const hits = await searchMemory(deps, WORKER, { query: 'zzq' });
  assert.deepEqual(hits.map(h => h.entry.path), ['knowledge/alpha/乙.md']);
  assert.ok(!(await memorySearch(deps, WORKER, { query: '一般內容' })).includes('獨特詞彙'));
  assert.equal((await searchMemory(deps, WORKER, {})).length, 2, '沒有關鍵字也隱藏草稿與退回');
});

test('搜尋:取代的舊檔預設隱藏(多種寫法),取代者是草稿時不隱藏', async () => {
  const { deps, put } = setup();
  put('knowledge/alpha/舊.md', know(), '舊作法 kw');
  put('knowledge/alpha/舊二.md', know(), '另一個舊作法 kw');
  put('knowledge/alpha/舊三.md', know(), '第三個舊作法 kw');
  put('knowledge/alpha/新.md', know({ 取代: '[[knowledge/alpha/舊.md]]' }), '新作法 kw');
  put('knowledge/alpha/新二.md', know({ 取代: '[[舊二|別名]]' }), '新作法二 kw');
  put('knowledge/alpha/新三.md', know({ 取代: '[[knowledge/alpha/舊三]], [[不存在]]', 狀態: '未確認' }), '草稿新作法 kw');
  const paths = (await searchMemory(deps, WORKER, { query: 'kw' })).map(h => h.entry.path).sort();
  assert.deepEqual(paths, ['knowledge/alpha/新.md', 'knowledge/alpha/新二.md', 'knowledge/alpha/舊三.md']);
});

test('搜尋:subtype 篩選(英文別名)與未完書籤排最前面', async () => {
  const { deps, put } = setup();
  put('knowledge/alpha/決策一.md', know({ 子類: '決策' }), '決策 pick 內容 pick pick');
  put('knowledge/alpha/書籤完.md', know({ 子類: '書籤', 狀態: '已完成' }), '書籤 pick');
  put('knowledge/alpha/書籤未.md', know({ 子類: '書籤', 狀態: '未完', 更新時間: '2026-01-01' }), '書籤 pick');
  put('knowledge/alpha/一般.md', know(), '一般 pick pick pick pick');
  const all = (await searchMemory(deps, WORKER, { query: 'pick' })).map(h => h.entry.path);
  assert.equal(all[0], 'knowledge/alpha/書籤未.md', '未完書籤排第一');
  assert.equal(all.length, 4);
  assert.deepEqual((await searchMemory(deps, WORKER, { query: 'pick', subtype: 'decision' })).map(h => h.entry.path), ['knowledge/alpha/決策一.md']);
  assert.deepEqual((await searchMemory(deps, WORKER, { query: 'pick', subtype: '書籤' })).map(h => h.entry.path), ['knowledge/alpha/書籤未.md', 'knowledge/alpha/書籤完.md']);
  assert.ok(await msg(searchMemory(deps, WORKER, { subtype: 'bookmark', kind: 'case' })));
  assert.ok(await msg(searchMemory(deps, WORKER, { subtype: 'weird' })));
  assert.ok((await memorySearch(deps, WORKER, { query: 'pick', subtype: 'bookmark' })).includes('專案知識·書籤'));
});

test('熱度:搜尋不算召回;檔案內容、節流與結束前寫出', async () => {
  const { dir, deps, put } = setup();
  resetHeat(dir);
  put('knowledge/alpha/甲.md', know(), '熱度測試');
  await memorySearch(deps, WORKER, { query: '熱度' });
  assert.deepEqual(heatOf(dir), {}, '搜尋不記');
  assert.equal(existsSync(join(dir, '.nexus-heat.json')), false);
  await memoryRead(deps, WORKER, { path: 'knowledge/alpha/甲.md' });
  const f = join(dir, '.nexus-heat.json');
  assert.equal(JSON.parse(readFileSync(f, 'utf8'))['knowledge/alpha/甲.md'].召回次數, 1, '第一次立刻寫出');
  await memoryRead(deps, WORKER, { path: 'knowledge/alpha/甲.md' });
  assert.equal(JSON.parse(readFileSync(f, 'utf8'))['knowledge/alpha/甲.md'].召回次數, 1, '5 秒內不再寫');
  flushHeat(dir);
  const j = JSON.parse(readFileSync(f, 'utf8'))['knowledge/alpha/甲.md'];
  assert.equal(j.召回次數, 2);
  assert.ok(!Number.isNaN(Date.parse(j.最後召回)));
  assert.deepEqual(readdirSync(dir).filter(n => n.endsWith('.tmp')), [], '沒有留下暫存檔');
  // 重新載入會接著上次的次數
  resetHeat(dir);
  assert.equal(heatOf(dir)['knowledge/alpha/甲.md'].召回次數, 2);
  flushHeat(dir);
});

test('writeJsonAtomic:成功、改名失敗重試後成功、一直失敗就放棄並清掉暫存檔', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-atomic-'));
  const f = join(dir, 'x.json');
  assert.equal(writeJsonAtomic(f, { a: 1 }), true);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 1 });
  assert.deepEqual(readdirSync(dir), ['x.json']);

  const mkIo = failures => {
    const calls = { rename: 0, sleeps: [], removed: [] };
    return { calls, io: {
      write: (p, t) => writeFileSync(p, t),
      rename: (a, b) => { if (calls.rename++ < failures) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return renameSync(a, b); },
      remove: p => calls.removed.push(p),
      sleep: ms => calls.sleeps.push(ms),
    } };
  };
  const a = mkIo(2);
  assert.equal(writeJsonAtomic(f, { a: 2 }, a.io), true);
  assert.equal(a.calls.rename, 3);
  assert.deepEqual(a.calls.sleeps, RETRY_DELAYS.slice(0, 2));
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 2 });

  const b = mkIo(99);
  assert.equal(writeJsonAtomic(f, { a: 3 }, b.io), false);
  assert.equal(b.calls.rename, RETRY_DELAYS.length + 1);
  assert.equal(b.calls.removed.length, 1, '暫存檔被移除');
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), { a: 2 }, '原檔維持上一份');

  const c = { calls: 0 };
  const io = { write: () => {}, rename: () => { c.calls++; throw Object.assign(new Error('x'), { code: 'ENOENT' }); }, remove: () => {}, sleep: () => { throw new Error('不該重試'); } };
  assert.equal(writeJsonAtomic(f, {}, io), false);
  assert.equal(c.calls, 1, '其他錯誤不重試');
  assert.equal(writeJsonAtomic(f, {}, { ...io, write: () => { throw new Error('disk'); } }), false);
});
import { renameSync } from 'node:fs';

for (const [name, fn] of tests) { await fn(); passed++; console.log('[ok]', name); }
console.log(`全部通過(${passed} 項)`);
