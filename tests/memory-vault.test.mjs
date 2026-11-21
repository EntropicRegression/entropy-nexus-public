// 驗收:記憶庫(src/main/memory-vault.ts)的屬性解析、資料夾索引與外部修改後的重新讀取。
// 用法:node --no-warnings tests/memory-vault.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryVault, entryFromFile, parseFrontMatter } from '../src/main/memory-vault.ts';
import { Store } from '../src/main/store.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('[ok]', name); };
const tmp = mkdtempSync(join(tmpdir(), 'nexus-vault-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async fn => { for (let i = 0; i < 50; i++) { if (fn()) return true; await wait(100); } return false; };

const store = new Store(join(tmp, 'nexus.db'));
try {
  await test('屬性解析:單行、引號、清單、冒號在值裡、全形冒號、註解與壞行', () => {
    const t = '---\n# 註解\n種類: 專案知識\n標題: "改 UI: 要先跑檢查"\n關鍵字: [electron, "視窗, 大小", 測試]\n改過的檔案:\n  - src/a.ts\n  - src/b.ts\n承辦節點: Hagemi(Antigravity · gemini)\n狀態:已確認\n這行沒有冒號\n  縮排的巢狀行: 略過\n---\n# 內文標題\n\n正文: 不是屬性\n';
    const r = parseFrontMatter(t);
    assert.equal(r.hasBlock, true);
    assert.equal(r.meta.get('種類'), '專案知識');
    assert.equal(r.meta.get('標題'), '改 UI: 要先跑檢查');
    assert.deepEqual(r.meta.get('關鍵字'), ['electron', '視窗, 大小', '測試']);
    assert.deepEqual(r.meta.get('改過的檔案'), ['src/a.ts', 'src/b.ts']);
    assert.equal(r.meta.get('承辦節點'), 'Hagemi(Antigravity · gemini)');
    assert.equal(r.meta.get('狀態'), '已確認');
    assert.equal(r.meta.has('縮排的巢狀行'), false);
    assert.equal(r.meta.has('正文'), false);
    assert.ok(r.body.startsWith('# 內文標題'));
  });

  await test('屬性解析:沒有區塊、沒有結尾、CRLF、BOM、空清單、危險的鍵名', () => {
    assert.equal(parseFrontMatter('# 只有內文\n').hasBlock, false);
    assert.equal(parseFrontMatter('---\n標題: 沒有結尾\n').hasBlock, false);
    const crlf = parseFrontMatter('\uFEFF---\r\n標題: 甲\r\n清單: []\r\n__proto__: x\r\nconstructor: y\r\n---\r\n內文');
    assert.equal(crlf.hasBlock, true);
    assert.equal(crlf.meta.get('標題'), '甲');
    assert.deepEqual(crlf.meta.get('清單'), []);
    // 用 Map 存,所以特殊鍵名只是普通的鍵,不會影響任何物件原型
    assert.equal(crlf.meta.get('__proto__'), 'x');
    assert.equal({}.x, undefined);
    assert.equal(crlf.body, '內文');
    assert.deepEqual([...parseFrontMatter('---\n---\n').meta], []);
  });

  await test('索引欄位:依資料夾判斷種類與範圍,屬性優先,標題有三層備援', () => {
    const e1 = entryFromFile('preferences/回報風格.md', '---\n標題: 回報要精簡\n---\n', 1000, 10);
    assert.deepEqual([e1.kind, e1.scope, e1.projectId, e1.title], ['preference', '全域', '', '回報要精簡']);
    const e2 = entryFromFile('knowledge/my-repo/測試.md', '# 先 build 再測\n內文', 2000, 20);
    assert.deepEqual([e2.kind, e2.scope, e2.projectId, e2.title], ['knowledge', '專案', 'my-repo', '先 build 再測']);
    const e3 = entryFromFile('cases/p/2026-0003-x.md', '---\n案由: 視窗調不動\n專案ID: c:/a/b\n承辦節點: n1\n狀態: 未確認\n更新時間: 2026-11-21\n範圍: 專案\n---\n', 3000, 30);
    assert.deepEqual([e3.kind, e3.scope, e3.projectId, e3.nodeId, e3.status, e3.title], ['case', '專案', 'c:/a/b', 'n1', '未確認', '視窗調不動']);
    assert.equal(e3.updatedAt, Date.parse('2026-11-21'));
    assert.equal(e3.mtime, 3000);
    const e4 = entryFromFile('nodes/Hagemi-2026-11-21.md', '沒有屬性也沒有標題', 4000, 5);
    assert.deepEqual([e4.kind, e4.scope, e4.title, e4.updatedAt], ['node', '全域', 'Hagemi-2026-11-21', 4000]);
    // 屬性寫了不同的種類:以屬性為準;宣告全域就不帶專案
    const e5 = entryFromFile('knowledge/x/a.md', '---\n種類: 偏好\n範圍: 全域\n專案ID: p\n---\n', 1, 1);
    assert.deepEqual([e5.kind, e5.scope, e5.projectId], ['preference', '全域', '']);
  });

  const dir = join(tmp, 'memory-vault');
  const vault = new MemoryVault(dir, store);

  await test('啟動:建立四個子資料夾與說明檔,空的記憶庫索引是空的', () => {
    vault.init();
    for (const d of ['nodes', 'cases', 'knowledge', 'preferences']) assert.ok(existsSync(join(dir, d)), d);
    assert.match(readFileSync(join(dir, '說明.md'), 'utf8'), /記憶庫資料夾/);
    assert.deepEqual(vault.list(), []);
    // 說明檔被使用者改過,不會被覆寫
    writeFileSync(join(dir, '說明.md'), '我改過');
    vault.init();
    assert.equal(readFileSync(join(dir, '說明.md'), 'utf8'), '我改過');
  });

  await test('掃描:放進來的檔案被索引,根目錄與非 .md 檔不算', () => {
    mkdirSync(join(dir, 'knowledge', 'proj-a'), { recursive: true });
    writeFileSync(join(dir, 'knowledge', 'proj-a', 'k1.md'), '---\n標題: 知識一\n狀態: 已確認\n---\n內文');
    writeFileSync(join(dir, 'preferences', 'p1.md'), '# 偏好一');
    writeFileSync(join(dir, 'preferences', 'notes.txt'), '不是 md');
    writeFileSync(join(dir, '亂放.md'), '---\n標題: 放在根目錄\n---\n');
    assert.deepEqual(vault.rescan(), { added: 2, updated: 0, removed: 0 });
    const list = vault.list();
    assert.deepEqual(list.map(e => e.path), ['knowledge/proj-a/k1.md', 'preferences/p1.md']);
    assert.equal(list[0].title, '知識一');
    assert.equal(list[0].projectId, 'proj-a');
    assert.equal(list[0].status, '已確認');
    assert.equal(list[1].title, '偏好一');
    // 沒變動時不重讀、不計入
    assert.deepEqual(vault.rescan(), { added: 0, updated: 0, removed: 0 });
  });

  await test('修改與刪除:改過的重新讀取(索引的標題與狀態更新),刪掉的從索引移除', () => {
    const f = join(dir, 'knowledge', 'proj-a', 'k1.md');
    writeFileSync(f, '---\n標題: 知識一(改)\n狀態: 退回\n---\n內文加長了');
    const later = new Date(Date.now() + 5000);
    utimesSync(f, later, later);
    assert.deepEqual(vault.rescan(), { added: 0, updated: 1, removed: 0 });
    const e = vault.list().find(x => x.path === 'knowledge/proj-a/k1.md');
    assert.equal(e.title, '知識一(改)');
    assert.equal(e.status, '退回');
    unlinkSync(join(dir, 'preferences', 'p1.md'));
    assert.deepEqual(vault.rescan(), { added: 0, updated: 0, removed: 1 });
    assert.deepEqual(vault.list().map(x => x.path), ['knowledge/proj-a/k1.md']);
  });

  await test('索引存在資料庫裡:重開後不用重讀沒變的檔案,離線期間被刪的檔案會被清掉', () => {
    const again = new MemoryVault(dir, store);
    assert.equal(again.list().length, 1);
    unlinkSync(join(dir, 'knowledge', 'proj-a', 'k1.md'));
    again.init();
    assert.deepEqual(again.list(), []);
  });

  await test('監看:外部新增與修改的檔案在去抖動之後自動被索引', async () => {
    const seen = [];
    vault.watch(() => seen.push(vault.list().length), 100);
    writeFileSync(join(dir, 'cases', 'w1.md'), '---\n案由: 監看一\n---\n');
    assert.ok(await until(() => vault.list().some(e => e.title === '監看一')), '新增的檔案沒有被索引');
    writeFileSync(join(dir, 'cases', 'w1.md'), '---\n案由: 監看二\n---\n加長一點');
    assert.ok(await until(() => vault.list().some(e => e.title === '監看二')), '修改的檔案沒有被重新讀取');
    assert.equal(vault.list().filter(e => e.path === 'cases/w1.md').length, 1);
    assert.ok(seen.length >= 1);
    vault.unwatch();
  });
} finally {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`通過(${passed} 項)`);
