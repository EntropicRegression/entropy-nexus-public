// 驗收:變更檢視行內評論的行號推算與提示詞組裝(純函式)。
// 用法:在 app 資料夾執行 node tests/review-prompt.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { commentSnippet, fitPatches, formatCommentsPrompt, formatReviewPrompt, lineLabel, patchRows, rowAnchor } from '../src/shared/review.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

// 兩個 hunk,含刪除行、新增行與「沒有結尾換行」的說明行
const multi = [
  '@@ -1,4 +1,5 @@',
  ' function greet(name) {',
  '-  return "hi " + name;',
  '+  // 打招呼',
  '+  return `hi ${name}`;',
  ' }',
  ' ',
  '@@ -20,3 +21,2 @@ export function tail() {',
  ' a',
  '-b',
  ' c',
  '\\ No newline at end of file',
  '',
].join('\n');

test('多個 hunk 的行號推算', () => {
  const rows = patchRows(multi);
  const pick = i => [rows[i].kind, rows[i].old, rows[i].new];
  assert.deepEqual(pick(0), ['hunk', null, null]);
  assert.deepEqual(pick(1), ['ctx', 1, 1]);
  assert.deepEqual(pick(2), ['rm', 2, null]);
  assert.deepEqual(pick(3), ['ins', null, 2]);
  assert.deepEqual(pick(4), ['ins', null, 3]);
  assert.deepEqual(pick(5), ['ctx', 3, 4]);
  assert.deepEqual(pick(6), ['ctx', 4, 5]);
  assert.deepEqual(pick(7), ['hunk', null, null]);
  assert.deepEqual(pick(8), ['ctx', 20, 21]);
  assert.deepEqual(pick(9), ['rm', 21, null]);
  assert.deepEqual(pick(10), ['ctx', 22, 22]);
  assert.deepEqual(pick(11), ['meta', null, null]);
  assert.deepEqual(pick(12), ['meta', null, null]);
});

test('刪除行用舊檔行號並標明被刪除', () => {
  const rows = patchRows(multi);
  assert.deepEqual(rowAnchor(rows[9]), { side: 'old', line: 21 });
  assert.equal(lineLabel(rowAnchor(rows[9])), '舊檔第 21 行(被刪除的行)');
  assert.deepEqual(rowAnchor(rows[4]), { side: 'new', line: 3 });
  assert.equal(lineLabel(rowAnchor(rows[4])), '第 3 行');
  assert.equal(rowAnchor(rows[0]), null);
  assert.equal(rowAnchor(rows[11]), null);
});

test('新檔(@@ -0,0 +1,3 @@)與刪除的檔案', () => {
  const added = patchRows('@@ -0,0 +1,3 @@\n+a\n+b\n+c\n');
  assert.deepEqual(added.slice(1, 4).map(r => r.new), [1, 2, 3]);
  const deleted = patchRows('@@ -1,2 +0,0 @@\n-x\n-y\n');
  assert.deepEqual(deleted.slice(1, 3).map(r => [r.kind, r.old]), [['rm', 1], ['rm', 2]]);
  // 只有一行的 hunk 標頭省略了行數
  assert.deepEqual(patchRows('@@ -5 +5 @@\n-old\n+new').slice(1).map(r => [r.old, r.new]), [[5, null], [null, 5]]);
});

test('沒有行號資訊的差異(工具回報)不標行號', () => {
  const rows = patchRows('@@ 這次編輯 @@\n-舊\n+新');
  assert.deepEqual(rows.map(r => [r.kind, r.old, r.new]), [['hunk', null, null], ['rm', null, null], ['ins', null, null]]);
  assert.deepEqual(rowAnchor(rows[2]), { side: null, line: null });
  assert.equal(lineLabel(rowAnchor(rows[2])), '(這段差異沒有行號)');
});

test('程式碼片段只取同一個 hunk 的前後幾行', () => {
  const s = commentSnippet(multi, { path: 'a.js', row: 9, side: 'old', line: 21, text: 'x' });
  assert.deepEqual(s.split('\n'), ['    20   21 |  a', '>   21      | -b', '    22   22 |  c']);
  // row 對不上(差異變動)時改用行號找
  const s2 = commentSnippet(multi, { path: 'a.js', row: 99, side: 'new', line: 3, text: 'x' });
  assert.ok(s2.includes('>         3 | +  return `hi ${name}`;'), s2);
  assert.equal(s2.split('\n').length, 5);
  assert.equal(commentSnippet(multi, { path: 'a.js', row: null, side: 'new', line: 999, text: 'x' }), '');
});

const files = [
  { path: 'src/a.js', status: 'M', added: 2, removed: 2, binary: false, patch: multi },
  { path: 'logo.png', status: 'A', added: 0, removed: 0, binary: true, patch: '' },
  { path: 'NEW.md', status: 'A', added: 3, removed: 0, binary: false, patch: '@@ -0,0 +1,3 @@\n+a\n+b\n+c\n' },
];

test('評論提示詞:路徑、行號、片段、整體意見', () => {
  const p = formatCommentsPrompt({
    title: '把 greet 改成模板字串',
    files,
    comments: [
      { path: null, row: null, side: null, line: null, text: '整體來說命名可以再清楚' },
      { path: 'src/a.js', row: 4, side: 'new', line: 3, text: '模板字串很好,但要處理 name 是 undefined' },
      { path: 'src/a.js', row: 9, side: 'old', line: 21, text: '為什麼刪掉 b?' },
      { path: 'src/a.js', row: 2, side: 'old', line: 2, text: '   ' },
    ],
  });
  console.log('----- 評論提示詞 -----\n' + p + '\n----------------------');
  assert.ok(p.includes('留下了 3 則審查意見'));
  assert.ok(p.includes('## 整體意見\n\n- 整體來說命名可以再清楚'));
  assert.ok(p.includes('## 1. src/a.js 第 3 行'));
  assert.ok(p.includes('## 2. src/a.js 舊檔第 21 行(被刪除的行)'));
  assert.ok(p.includes('>   21      | -b'));
  assert.ok(p.includes('```\n     2      | -'), '片段只有單一反引號時用三個反引號的圍欄');
  assert.ok(!p.includes('意見:   '));
});

const set = { source: 'git', note: '', truncated: false, files };
const base = { title: '把 greet 改成模板字串', author: { name: 'Claude-A', backend: 'Claude Code', model: 'opus' }, set };

test('審查提示詞:任務、完成者、摘要、diff、不要修改檔案、二進位只列檔名', () => {
  const p = formatReviewPrompt({ ...base, changeCwd: 'C:\\repo', reviewerCwd: 'c:/repo/', note: '特別注意相容性' });
  console.log('----- 審查提示詞 -----\n' + p + '\n----------------------');
  assert.ok(p.includes('原任務指令:把 greet 改成模板字串'));
  assert.ok(p.includes('完成者:Claude-A(Claude Code · opus)'));
  assert.ok(p.includes('就是你目前的工作目錄'));
  assert.ok(p.includes('**請不要修改任何檔案'));
  assert.ok(p.includes('共 3 個檔案,新增 5 行、刪除 2 行'));
  assert.ok(p.includes('- 新增 logo.png(二進位檔,只列檔名)'));
  assert.ok(!p.includes('### logo.png'));
  assert.ok(p.includes('### src/a.js\n```diff\n@@ -1,4 +1,5 @@'));
  assert.ok(p.includes('使用者的補充說明:特別注意相容性'));
  assert.ok(!p.includes('上限'));
});

test('內容含有 ``` 時圍欄加長', () => {
  const md = [{ path: 'README.md', status: 'M', added: 1, removed: 0, binary: false, patch: '@@ -1,2 +1,3 @@\n # 標題\n+```js\n x\n' }];
  const p = formatReviewPrompt({ ...base, set: { ...set, files: md }, changeCwd: 'C:\\repo', reviewerCwd: 'C:\\repo' });
  assert.ok(p.includes('### README.md\n````diff\n'));
  const c = formatCommentsPrompt({ title: 't', files: md, comments: [{ path: 'README.md', row: 2, side: 'new', line: 2, text: '語言標記' }] });
  assert.ok(c.includes('````\n') && c.includes('>         2 | +```js'), c);
});

test('審查提示詞:工作目錄不同時說明變更所在路徑', () => {
  const p = formatReviewPrompt({ ...base, changeCwd: 'D:\\wt\\node-1', reviewerCwd: 'C:\\repo' });
  assert.ok(p.includes('變更所在路徑:D:\\wt\\node-1\n注意:這不是你目前的工作目錄(C:\\repo)'));
});

test('超大 diff:小檔完整保留,大檔截斷或省略並明講', () => {
  const big = n => '@@ -1,1 +1,' + n + ' @@\n' + Array.from({ length: n }, (_, i) => `+line ${i} ${'x'.repeat(40)}`).join('\n') + '\n';
  const huge = [
    { path: 'small.js', status: 'M', added: 1, removed: 0, binary: false, patch: '@@ -1 +1,2 @@\n a\n+b\n' },
    { path: 'big1.txt', status: 'A', added: 3000, removed: 0, binary: false, patch: big(3000) },
    { path: 'big2.txt', status: 'A', added: 2000, removed: 0, binary: false, patch: big(2000) },
  ];
  const fitted = fitPatches(huge, 60000);
  const total = fitted.reduce((n, f) => n + f.text.length, 0);
  assert.ok(total <= 60000, `總長 ${total}`);
  assert.equal(fitted[0].cut, 'full');
  assert.equal(fitted[1].cut, 'truncated');
  assert.equal(fitted[2].cut, 'truncated');
  assert.ok(fitted[1].text.endsWith(`${'x'.repeat(40)}`), '在行的邊界截斷');
  const p = formatReviewPrompt({ ...base, set: { ...set, files: huge }, changeCwd: 'C:\\repo', reviewerCwd: 'C:\\repo' });
  assert.ok(p.length < 64000, `提示詞長度 ${p.length}`);
  assert.ok(p.includes('diff 總長超過 60000 字元的上限'));
  assert.ok(/- big1\.txt:截斷,只放了前 \d+ 字元\(共 \d+ 字元\)/.test(p));
  assert.ok(p.includes('### small.js'));
  console.log('[info] 超大 diff 提示詞長度', p.length, '| 各檔', JSON.stringify(fitted.map(f => [f.path, f.cut, f.text.length, f.length])));
  // 很多個大檔:平均分到的額度太少時省略一部分檔案,其餘的仍至少保留一段
  const many = Array.from({ length: 120 }, (_, i) => ({ path: `f${i}.txt`, status: 'A', added: 100, removed: 0, binary: false, patch: big(100) }));
  const fm = fitPatches(many, 60000);
  const kept = fm.filter(f => f.cut !== 'omitted');
  assert.ok(kept.length > 0 && kept.length < 120, `保留 ${kept.length} 個`);
  assert.ok(kept.every(f => f.text.length >= 700));
  assert.ok(fm.reduce((n, f) => n + f.text.length, 0) <= 60000);
  const pm = formatReviewPrompt({ ...base, set: { ...set, files: many }, changeCwd: 'C:\\repo', reviewerCwd: 'C:\\repo' });
  assert.ok(/- f\d+\.txt:整個省略/.test(pm));
  console.log('[info] 120 個大檔:保留', kept.length, '個(截斷),省略', 120 - kept.length, '個,提示詞長度', pm.length);
});

console.log(`[test] 純函式測試全部通過(${passed} 項)`);
