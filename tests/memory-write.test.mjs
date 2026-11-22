// 驗收:記憶庫的共用寫入(src/main/memory-write.ts):遮罩、屬性格式、使用者改過的檔案不覆寫。
// 用法:在 app 資料夾執行 node tests/memory-write.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editedByOthers, maskSecrets, safeName, serializeFrontMatter, writeMemory } from '../src/main/memory-write.ts';
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

console.log(`通過 ${passed} 項`);
