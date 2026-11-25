// 驗收:回覆排版的 Markdown 解析(純函式):表格、清單、核取方塊、引用、強調貼著全形標點等。
// 用法:在 app 資料夾執行 node tests/markdown.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { parseBlocks, parseInline, splitRow } from '../src/renderer/src/markdown-parse.ts';
import { externalUrl } from '../src/shared/external-url.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const flat = nodes => nodes.map(n => typeof n === 'string' ? n : n.t === 'code' ? `<code:${n.text}>` : n.t === 'br' ? '<br>' : n.t === 'img' ? `<img:${n.src}>` : n.t === 'a' ? `<a:${n.href}|${flat(n.c)}>` : `<${n.t}:${flat(n.c)}>`).join('');

test('表格:對齊、缺格補空、多格保留、行內格式', () => {
  const [t] = parseBlocks('| 名稱 | 說明 | 數量 |\n|:--|:-:|--:|\n| `a\\|b` | **重點**:說明 | 3 |\n| 只有一格 |\n| x | y | z | 多出來 |\n\n後面');
  assert.equal(t.t, 'table');
  assert.deepEqual(t.align.slice(0, 3), ['left', 'center', 'right']);
  assert.equal(t.align.length, 4);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[0][0], '`a|b`');
  assert.deepEqual(t.rows[1], ['只有一格', '', '', '']);
  assert.equal(t.rows[2][3], '多出來');
  assert.equal(flat(parseInline(t.rows[0][1])), '<strong:重點>:說明');
});
test('表格:沒有外側豎線、輸出中途只有表頭,以及不是表格的情況', () => {
  assert.equal(parseBlocks('a | b\n--- | ---\n1 | 2')[0].t, 'table');
  const half = parseBlocks('| a | b |\n|---|---|');
  assert.equal(half[0].t, 'table'); assert.equal(half[0].rows.length, 0);
  assert.equal(parseBlocks('a | b\n沒有分隔列')[0].t, 'p');
  assert.equal(parseBlocks('文字\n---')[1].t, 'hr');
  assert.deepEqual(splitRow('| a | | c |'), ['a', '', 'c']);
  assert.deepEqual(splitRow('`x|y` | z'), ['`x|y`', 'z']);
});
test('標題 h1-h6、分隔線、尾端 #', () => {
  const b = parseBlocks('# 一\n###### 六\n## 二 ##\n***\n#沒空格');
  assert.deepEqual(b.slice(0, 3).map(x => x.level), [1, 6, 2]);
  assert.equal(b[2].text, '二');
  assert.equal(b[3].t, 'hr');
  assert.equal(b[4].t, 'p');
});
test('巢狀清單、接續行、清單裡的程式碼區塊', () => {
  const [l] = parseBlocks('1. 第一\n   - 子項 a\n   - 子項 b\n     - 孫項\n2. 第二\n   續行文字\n\n   ```js\n   const x = 1;\n\n   ```\n3. 第三');
  assert.equal(l.t, 'list'); assert.equal(l.ordered, true); assert.equal(l.items.length, 3);
  const sub = l.items[0].blocks[1];
  assert.equal(sub.t, 'list'); assert.equal(sub.items.length, 2);
  assert.equal(sub.items[1].blocks[1].t, 'list');
  const second = l.items[1].blocks;
  assert.equal(second[0].text, '第二\n續行文字');
  assert.equal(second[1].t, 'code'); assert.equal(second[1].lang, 'js'); assert.equal(second[1].text, 'const x = 1;\n');
});
test('清單:起始編號、不同種類分開、懶惰延續', () => {
  const b = parseBlocks('3. 三\n4. 四\n- 點\n- 點二\n  接著');
  assert.equal(b[0].start, 3); assert.equal(b.length, 2);
  assert.equal(b[1].items[1].blocks[0].text, '點二\n接著');
});
test('核取方塊', () => {
  const [l] = parseBlocks('- [ ] 待辦\n- [x] 完成\n- [X] 也完成\n- [x](連結.md) 不是核取方塊');
  assert.deepEqual(l.items.map(i => i.task), ['todo', 'done', 'done', undefined]);
  assert.equal(l.items[0].blocks[0].text, '待辦');
});
test('引用(含巢狀)', () => {
  const [q] = parseBlocks('> 外層\n> > 內層\n> - 項目');
  assert.equal(q.t, 'quote');
  assert.equal(q.blocks[0].t, 'p'); assert.equal(q.blocks[1].t, 'quote'); assert.equal(q.blocks[1].blocks[0].text, '內層');
});
test('程式碼區塊:語言、~~~、四個反引號包三個、沒有結尾', () => {
  const b = parseBlocks('```ts title="x"\nlet a = 1;\n```\n~~~\nraw\n~~~\n````md\n```\n內層\n```\n````\n```py\n還在生成');
  assert.equal(b[0].lang, 'ts'); assert.equal(b[1].text, 'raw');
  assert.equal(b[2].text, '```\n內層\n```'); assert.equal(b[3].text, '還在生成');
});
test('強調緊貼 CJK 與全形標點', () => {
  assert.equal(flat(parseInline('**重點**:說明')), '<strong:重點>:說明');
  assert.equal(flat(parseInline('這是**粗體**字,還有*斜體*字。')), '這是<strong:粗體>字,還有<em:斜體>字。');
  assert.equal(flat(parseInline('**「引號」**與(**括號**)')), '<strong:「引號」>與(<strong:括號>)');
  assert.equal(flat(parseInline('***粗斜***與~~刪除~~')), '<strongem:粗斜>與<del:刪除>');
  assert.equal(flat(parseInline('**粗 *斜* 粗**')), '<strong:粗 <em:斜> 粗>');
  assert.equal(flat(parseInline('**a *b***')), '<strong:a <em:b>>');
});
test('強調不誤判:乘號、底線識別字、跳脫、未結尾', () => {
  assert.equal(flat(parseInline('2 * 3 * 4')), '2 * 3 * 4');
  assert.equal(flat(parseInline('snake_case_name 與 __init__')), 'snake_case_name 與 <strong:init>');
  assert.equal(flat(parseInline('\\*不是斜體\\*')), '*不是斜體*');
  assert.equal(flat(parseInline('**還在輸出')), '**還在輸出');
  assert.equal(flat(parseInline('`**不是粗體**`')), '<code:**不是粗體**>');
  assert.equal(flat(parseInline('C:\\Users\\me\\a.txt')), 'C:\\Users\\me\\a.txt');
});
test('連結、圖片、網址、換行', () => {
  assert.equal(flat(parseInline('[**粗** 文字](https://a.com/x_(y)) 後')), '<a:https://a.com/x_(y)|<strong:粗> 文字> 後');
  assert.equal(flat(parseInline('[檔](<C:\\a b\\c.ts>) ![圖](<C:\\a b\\p.png>)')), '<a:C:\\a b\\c.ts|檔> <img:C:\\a b\\p.png>');
  assert.equal(flat(parseInline('見 https://x.com/a。與 <https://y.org/b>,(https://z.io/q).')), '見 <a:https://x.com/a|https://x.com/a>。與 <a:https://y.org/b|https://y.org/b>,(<a:https://z.io/q|https://z.io/q>).');
  assert.equal(flat(parseInline('甲<br>乙 \n丙')), '甲<br>乙\n丙');
  assert.equal(flat(parseInline('<script>alert(1)</script>')), '<script>alert(1)</script>');
});
test('段落:純文字原樣保留', () => {
  const b = parseBlocks('第一行\n第二行\n\n    縮排的文字');
  assert.equal(b[0].text, '第一行\n第二行'); assert.equal(b.length, 2);
});

test('網址連結:只有 http(s)、不帶帳號密碼的才交給瀏覽器', () => {
  assert.equal(externalUrl('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.equal(externalUrl('  http://example.com '), 'http://example.com/');
  for (const bad of ['javascript:alert(1)', 'file:///C:/x.txt', 'mailto:a@b.c', 'data:text/html,x', 'https://good.com@evil.com/', 'https://u:p@x.com', 'C:\\x\\y', 'notaurl', '', 'http://']) assert.equal(externalUrl(bad), null, bad);
  // 裸網址解析出來的連結也會通過檢查
  const [a] = parseInline('https://example.com/docs').filter(n => typeof n !== 'string');
  assert.equal(externalUrl(a.href), 'https://example.com/docs');
});

console.log(`\n${passed} 項通過`);
