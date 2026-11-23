// 驗收:記憶庫的共用寫入(src/main/memory-write.ts):遮罩、屬性格式、使用者改過的檔案不覆寫。
// 用法:在 app 資料夾執行 node tests/memory-write.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bodyOfText, changedSections, editedByOthers, maskSecrets, safeName, sectionMap, serializeFrontMatter, writeMemory } from '../src/main/memory-write.ts';
import { entryFromFile, parseFrontMatter } from '../src/main/memory-vault.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

test('遮罩:各家金鑰格式、Bearer、JWT、私鑰區塊、鍵值', () => {
  const src = [
    'anthropic sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456',
    'github ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws AKIAABCDEFGHIJKLMNOP',
    'Authorization: Bearer abcdefghijklmnop1234567890',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    'password: hunter2secret',
    '密碼:abc123456',
    'api_key="zzzzzzzzzzzz"',
  ].join('\n');
  const { text, masked } = maskSecrets(src);
  assert.equal(masked, 9);
  for (const leak of ['sk-ant-api03', 'ghp_abc', 'AKIAABCD', 'abcdefghijklmnop1234567890', 'eyJhbGci', 'MIIEow', 'hunter2secret', 'abc123456', 'zzzzzzzzzzzz']) assert.ok(!text.includes(leak), leak);
  assert.ok(text.includes('password: [已遮罩]') && text.includes('密碼:[已遮罩]') && text.includes('api_key="[已遮罩]"'));
});

test('遮罩:一般內容不受影響(短的值、程式碼、網址)', () => {
  const src = '用 token 驗證身分;token: abc(太短不算);見 https://example.com/docs;const pwd = input;';
  assert.deepEqual(maskSecrets(src), { text: src, masked: 0 });
});

test('檔名:去掉不允許的字元、結尾的點與空白、限制長度', () => {
  assert.equal(safeName('a/b\\c:d*e?"f<g>h|i. '), 'abcdefghi');
  assert.equal(safeName('   '), '未命名');
  assert.equal(safeName('字'.repeat(80)).length, 60);
});

test('屬性:寫出去的格式讀得回來(引號、清單、冒號、略過空值)', () => {
  const fm = serializeFrontMatter({ 種類: 'case', 案由: 'Electron: 視窗調不動', 關鍵字: ['electron', '視窗, 測試'], 耗時分鐘: 42, 空的: null, 沒有: undefined });
  const { meta, hasBlock } = parseFrontMatter(fm + '\n# 內文\n');
  assert.ok(hasBlock);
  assert.equal(meta.get('案由'), 'Electron: 視窗調不動');
  assert.deepEqual(meta.get('關鍵字'), ['electron', '視窗, 測試']);
  assert.equal(meta.get('耗時分鐘'), '42');
  assert.ok(!meta.has('空的') && !meta.has('沒有'));
});

const vault = mkdtempSync(join(tmpdir(), 'nexus-vault-'));

test('寫入:建立檔案,索引讀得到種類、專案、狀態,內文與屬性都遮罩', () => {
  const r = writeMemory(vault, 'cases/proj-a/2026-0001-測試.md', { 種類: 'case', 範圍: '專案', 專案: 'proj-a', 狀態: '未確認', 備註: 'token=abcdefghijk' }, '# 解法第 2026-0001 號\n\n金鑰 sk-abcdefghijklmnopqrstu 不要外洩');
  assert.deepEqual(r, { path: 'cases/proj-a/2026-0001-測試.md', action: 'created', masked: 2 });
  const text = readFileSync(join(vault, 'cases', 'proj-a', '2026-0001-測試.md'), 'utf8');
  assert.ok(!text.includes('sk-abc') && !text.includes('abcdefghijk'));
  const e = entryFromFile(r.path, text, 0, text.length);
  assert.equal(e.kind, 'case'); assert.equal(e.scope, '專案'); assert.equal(e.projectId, 'proj-a'); assert.equal(e.status, '未確認'); assert.equal(e.title, '解法第 2026-0001 號');
});

test('寫入:只有 agent 寫過的檔案可以整份取代', () => {
  const r = writeMemory(vault, 'nodes/Hagemi.md', { 種類: 'node', 節點: 'Hagemi' }, '特長:查資料');
  assert.equal(r.action, 'created');
  assert.equal(editedByOthers(vault, 'nodes/Hagemi.md'), false);
  const r2 = writeMemory(vault, 'nodes/Hagemi.md', { 種類: 'node', 節點: 'Hagemi' }, '特長:查資料、整理表格');
  assert.equal(r2.action, 'replaced');
  assert.ok(readFileSync(join(vault, 'nodes', 'Hagemi.md'), 'utf8').includes('整理表格'));
});

test('寫入:使用者改過的檔案不覆寫,改成附加一段', () => {
  const abs = join(vault, 'nodes', 'Hagemi.md');
  writeFileSync(abs, readFileSync(abs, 'utf8') + '\n使用者補的一句。\n');
  const t = new Date(Date.now() + 5000); utimesSync(abs, t, t);
  assert.equal(editedByOthers(vault, 'nodes/Hagemi.md'), true);
  const r = writeMemory(vault, 'nodes/Hagemi.md', { 種類: 'node' }, '特長:新的內容', 'replace', new Date('2026-11-21T08:00:00Z'));
  assert.equal(r.action, 'appended');
  const text = readFileSync(abs, 'utf8');
  assert.ok(text.includes('使用者補的一句。') && text.includes('## 主控台補充(2026-11-21 08:00)') && text.includes('特長:新的內容'));
  // 附加過的檔案一直算「使用者改過」:之後 agent 的寫入照樣附加,不會整份取代掉使用者的內容(2026-11-22 修正;原本附加後會重新登記,下一次就整份取代)
  assert.equal(editedByOthers(vault, 'nodes/Hagemi.md'), true);
  const again = writeMemory(vault, 'nodes/Hagemi.md', { 種類: 'node' }, '特長:第三版', 'replace', new Date('2026-11-21T09:00:00Z'));
  assert.equal(again.action, 'appended');
  assert.ok(readFileSync(abs, 'utf8').includes('使用者補的一句。'), '使用者的內容還在');
});

test('寫入:agent 沒寫過的既有檔案(使用者自己建立的)也只附加', () => {
  mkdirSync(join(vault, 'knowledge'), { recursive: true });
  const abs = join(vault, 'knowledge', 'mine.md');
  writeFileSync(abs, '# 使用者的筆記\n');
  assert.equal(writeMemory(vault, 'knowledge/mine.md', {}, '補充').action, 'appended');
});

test('寫入:路徑不能跳出記憶庫、一定要是 .md', () => {
  assert.throws(() => writeMemory(vault, '../outside.md', {}, 'x'));
  assert.throws(() => writeMemory(vault, 'nodes/a.txt', {}, 'x'));
  assert.throws(() => writeMemory(vault, 'nodes//a.md', {}, 'x'));
});

test('只附加有變動的章節:依二級標題比對檔案裡最新的版本(含之前的補充),沒變的章節、空章節不附加', () => {
  const user = '## 基本資料\n\n- 名稱:甲\n\n## 特長\n\n使用者寫的特長\n\n## 解決問題的流程\n\n1. 先看 log';
  assert.equal(changedSections(user, user), '', '完全相同:不附加');
  assert.equal(changedSections(user, user.replace('使用者寫的特長', '總管的新特長')), '## 特長\n\n總管的新特長');
  // 之前的補充已經有同樣的特長:以最新版本比較,不重複附加
  const withAppendix = user + '\n\n## 主控台補充(2026-11-22 07:00)\n\n## 特長\n\n總管的新特長';
  assert.equal(changedSections(withAppendix, user.replace('使用者寫的特長', '總管的新特長')), '');
  assert.equal(sectionMap(withAppendix).get('特長'), '總管的新特長', '同標題以最後一次為準');
  assert.ok(!sectionMap(withAppendix).has('主控台補充(2026-11-22 07:00)'), '補充標題不是章節');
  // 新增的空章節(例如只補上 ## 解決問題的流程 的標題)不附加;新的非空章節才附加
  assert.equal(changedSections('## 特長\n\n甲', '## 特長\n\n甲\n\n## 解決問題的流程\n'), '');
  assert.equal(changedSections('## 特長\n\n甲', '## 特長\n\n甲\n\n## 新章節\n\n內容'), '## 新章節\n\n內容');
  // 沒有標題的內容(例如偏好、專案知識的正文)整段比較;### 不是章節分隔
  assert.equal(changedSections('一段話', '一段話'), '');
  assert.equal(changedSections('一段話', '另一段話'), '另一段話');
  assert.equal(sectionMap('## 特長\n\n甲\n\n### 細節\n\n乙').get('特長'), '甲\n\n### 細節\n\n乙');
  assert.equal(bodyOfText('---\n種類: node\n---\n\n## 特長\n\n甲\n'), '\n## 特長\n\n甲\n');
  assert.equal(changedSections('## 特長\r\n\r\n甲\r\n', '## 特長\n\n甲'), '', 'CRLF 與 LF 視為相同');
});

test('使用者改過的側寫:總管更新特長只附加特長;同樣的特長再寫一次不附加;補充裡只有一個補充標題', () => {
  const vault = mkdtempSync(join(tmpdir(), 'nexus-append-'));
  const rel = 'nodes/甲.md';
  mkdirSync(join(vault, 'nodes'), { recursive: true });
  writeFileSync(join(vault, rel), '---\n種類: node\n節點ID: n1\n---\n\n## 基本資料\n\n- 名稱:甲\n\n## 特長\n\n使用者手寫的特長\n\n## 解決問題的流程\n\n1. 先看 log\n');
  const update = special => `## 基本資料\n\n- 名稱:甲\n\n## 特長\n\n${special}\n\n## 解決問題的流程\n\n1. 先看 log`;
  const r1 = writeMemory(vault, rel, { 種類: 'node' }, update('總管的新特長'), 'replace', new Date('2026-11-22T07:00:00Z'));
  assert.equal(r1.action, 'appended');
  let text = readFileSync(join(vault, rel), 'utf8');
  const appendix = text.slice(text.indexOf('## 主控台補充'));
  assert.equal(appendix, '## 主控台補充(2026-11-22 07:00)\n\n## 特長\n\n總管的新特長\n', appendix);
  assert.ok(text.startsWith('---\n種類: node\n節點ID: n1\n---\n\n## 基本資料') && text.includes('使用者手寫的特長'), '使用者的內容一字不動');
  // 再寫一次同樣的特長:不附加、檔案不變
  const r2 = writeMemory(vault, rel, { 種類: 'node' }, update('總管的新特長'), 'replace', new Date('2026-11-22T08:00:00Z'));
  assert.equal(r2.action, 'unchanged');
  assert.equal(readFileSync(join(vault, rel), 'utf8'), text);
  // 特長又變了:新的補充段落也只有特長
  writeMemory(vault, rel, { 種類: 'node' }, update('第三版特長'), 'replace', new Date('2026-11-22T09:00:00Z'));
  text = readFileSync(join(vault, rel), 'utf8');
  assert.equal(text.match(/^## 主控台補充/gm).length, 2);
  assert.equal(text.match(/^## 解決問題的流程/gm).length, 1, '沒變的章節沒有重複附加');
  assert.ok(text.endsWith('## 主控台補充(2026-11-22 09:00)\n\n## 特長\n\n第三版特長\n'));
});

test('附加前再比對一次:讀取之後檔案被別人改過,重讀後再附加,不丟失外部的修改', () => {
  const vault = mkdtempSync(join(tmpdir(), 'nexus-append-race-'));
  const rel = 'nodes/乙.md';
  const abs = join(vault, rel);
  mkdirSync(join(vault, 'nodes'), { recursive: true });
  writeFileSync(abs, '---\n種類: node\n---\n\n## 特長\n\n使用者的特長\n');
  let calls = 0;
  const r = writeMemory(vault, rel, { 種類: 'node' }, '## 特長\n\n總管的特長', 'replace', new Date('2026-11-22T07:00:00Z'), {
    beforeCommit: (path, attempt) => {
      calls++;
      // 第一次寫回前,寶庫(或使用者)剛好在檔尾加了一段筆記
      if (attempt === 0) writeFileSync(path, readFileSync(path, 'utf8') + '\n## 筆記\n\n寶庫剛寫的筆記\n');
    },
  });
  assert.equal(r.action, 'appended');
  assert.equal(calls, 2, '偵測到變動後重讀重算一次');
  const text = readFileSync(abs, 'utf8');
  assert.ok(text.includes('寶庫剛寫的筆記'), '外部修改沒有被蓋掉');
  assert.equal(text.match(/^## 主控台補充/gm).length, 1);
  assert.ok(text.indexOf('寶庫剛寫的筆記') < text.indexOf('## 主控台補充'), '補充接在外部修改之後');
  // 檔案一直在變:重試用盡後用最後一次讀到的內容寫入(仍包含所有外部修改)
  let n = 0;
  writeMemory(vault, rel, { 種類: 'node' }, '## 特長\n\n總管的特長第二版', 'replace', new Date('2026-11-22T08:00:00Z'), {
    beforeCommit: path => { n++; writeFileSync(path, readFileSync(path, 'utf8') + `\n第 ${n} 次外部修改\n`); },
  });
  const last = readFileSync(abs, 'utf8');
  assert.ok(n >= 2 && last.includes('第 1 次外部修改') && last.includes('總管的特長第二版'), last);
});

console.log(`通過 ${passed} 項`);
