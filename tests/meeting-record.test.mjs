// 驗收:會議紀錄寫進記憶庫(src/main/meeting-record.ts):路徑、檔頭、引用格式、本機路徑與金鑰遮罩、同名序號。
// 用法:在 app 資料夾執行 node tests/meeting-record.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMeetingRecord, maskLocalPaths, meetingRecordOf, shortTitle, TITLE_MAX, writeMeetingRecord } from '../src/main/meeting-record.ts';
import { entryFromFile, parseFrontMatter } from '../src/main/memory-vault.ts';

let yaml = null;
try { yaml = (await import('js-yaml')).default; } catch (e) { throw new Error(`測試需要 js-yaml(node_modules 裡的間接相依,不是直接相依):${e.message}`); }

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

const H = '[本機路徑已隱藏]';
const T0 = Date.UTC(2026, 10, 22, 3, 0, 0);
const T1 = Date.UTC(2026, 10, 22, 3, 12, 30);
const pad = n => String(n).padStart(2, '0');
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const base = () => ({
  id: 'm1', topic: '登入流程怎麼改', hostId: 'node-orion', hostName: '獵戶',
  participants: [{ id: 'node-vega', name: '織女' }, { id: 'node-lyra', name: '天琴' }],
  projectId: 'c:/projects/star-app', projectName: 'star-app',
  startedAt: T0, endedAt: T1, endReason: '完成',
  conclusion: '決定改用權杖登入。\n第二行補充。\n\n後面的段落不進摘要。',
  transcript: [
    { round: 1, name: '獵戶', nodeId: 'node-orion', text: '先說我的看法。' },
    { round: 1, name: '織女', nodeId: 'node-vega', text: '同意。' },
    { round: 2, name: '天琴', nodeId: 'node-lyra', text: '收尾。' },
  ],
});

test('檔頭欄位與順序', () => {
  const r = buildMeetingRecord(base());
  assert.deepEqual(Object.keys(r.meta), ['種類', '標題', '主題', '輪數', '開始', '結束', '更新時間', '節點ID', '主持人', '參與節點ID', '參與者', '範圍', '專案ID', '專案', '摘要', '結束原因', '狀態']);
  assert.equal(r.meta['種類'], '會議紀錄');
  assert.equal(r.meta['輪數'], 2);
  assert.equal(r.meta['開始'], '2026-11-22T03:00:00.000Z');
  assert.equal(r.meta['更新時間'], r.meta['結束']);
  assert.equal(r.meta['範圍'], '專案');
  assert.equal(r.meta['專案ID'], 'c:/projects/star-app');
  assert.equal(r.meta['摘要'], '決定改用權杖登入。 第二行補充。');
  assert.equal(r.meta['狀態'], '未確認');
  assert.ok(!('產出' in r.meta));
});

test('沒有專案:範圍全域、不寫專案欄位、資料夾未分類專案', () => {
  const r = buildMeetingRecord({ ...base(), projectId: undefined, projectName: undefined });
  assert.equal(r.meta['範圍'], '全域');
  assert.equal(r.meta['專案ID'], undefined);
  assert.equal(r.meta['專案'], undefined);
  assert.equal(r.dir, 'meetings/未分類專案');
});

test('路徑:專案名稱資料夾 + 本機日期 + 主題', () => {
  const r = buildMeetingRecord(base());
  assert.equal(r.dir, 'meetings/star-app');
  assert.equal(r.baseName, `${localDay(T1)}-登入流程怎麼改`);
  const p = buildMeetingRecord({ ...base(), topic: '看 C:\\Users\\bob\\Desktop\\a.md 的問題' });
  assert.equal(p.baseName, `${localDay(T1)}-看 本機路徑已隱藏 的問題`);
  assert.ok(!p.baseName.includes('bob'));
  const k = buildMeetingRecord({ ...base(), topic: '金鑰 sk-abcdefghijklmnopqrstuvwxyz123456 外洩' });
  assert.ok(!k.baseName.includes('sk-abcdef'));
});

test('結論:有結論放最前面逐行引用;沒有結論不寫、摘要為空字串', () => {
  const r = buildMeetingRecord(base());
  assert.ok(r.body.startsWith('## 結論\n\n> 決定改用權杖登入。\n> 第二行補充。\n>\n> 後面的段落不進摘要。\n\n## 第 1 輪'));
  const n = buildMeetingRecord({ ...base(), conclusion: undefined });
  assert.ok(!n.body.includes('## 結論'));
  assert.ok(n.body.startsWith('## 第 1 輪'));
  assert.equal(n.meta['摘要'], '');
  assert.equal(buildMeetingRecord({ ...base(), conclusion: '  \n ' }).meta['摘要'], '');
});

test('摘要過長截到 200 字', () => {
  const s = buildMeetingRecord({ ...base(), conclusion: '長'.repeat(500) }).meta['摘要'];
  assert.equal(s.length, 201);
  assert.ok(s.endsWith('…'));
});

test('正文結構:第 N 輪與發言標題', () => {
  const r = buildMeetingRecord(base());
  const heads = r.body.split('\n').filter(l => /^#{2,3} /.test(l));
  assert.deepEqual(heads, ['## 結論', '## 第 1 輪', '### 獵戶 · node-orion', '### 織女 · node-vega', '## 第 2 輪', '### 天琴 · node-lyra']);
  const c = buildMeetingRecord({ ...base(), transcript: [{ round: 1, name: '主控台', nodeId: null, text: '尚未回覆,略過' }, { round: 1, name: '獵戶', nodeId: 'node-orion', text: 'x' }] });
  assert.ok(c.body.includes('### 主控台 · -\n\n> 尚未回覆,略過'));
});

test('round 0 的主控台說明:歸在最近一輪底下;在第一輪之前則歸第一輪;不產生第 0 輪', () => {
  const r = buildMeetingRecord({ ...base(), conclusion: undefined, transcript: [
    { round: 0, name: '主控台', text: '會議開始' },
    { round: 1, name: '獵戶', nodeId: 'node-orion', text: 'a' },
    { round: 0, name: '主控台', text: '織女逾時,略過' },
    { round: 2, name: '天琴', nodeId: 'node-lyra', text: 'b' },
  ] });
  const heads = r.body.split('\n').filter(l => /^#{2,3} /.test(l));
  assert.deepEqual(heads, ['## 第 1 輪', '### 主控台 · -', '### 獵戶 · node-orion', '### 主控台 · -', '## 第 2 輪', '### 天琴 · node-lyra']);
  assert.equal(r.meta['輪數'], 2);
});

test('發言含 ## 標題、程式碼區塊、表格、空行:每行都包進引用', () => {
  const text = '## 我的標題\n\n```ts\nconst a = 1;\n\nlet b = 2;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |';
  const r = buildMeetingRecord({ ...base(), conclusion: undefined, transcript: [{ round: 1, name: '獵戶', nodeId: 'node-orion', text }] });
  const lines = r.body.split('\n');
  const start = lines.indexOf('### 獵戶 · node-orion');
  const block = lines.slice(start + 2, lines.length).filter((_, i, a) => i < a.length - 1);
  assert.ok(block.every(l => l === '>' || l.startsWith('> ')), block.join('|'));
  assert.ok(!lines.some(l => /^## 我的標題/.test(l)) && !lines.some(l => l.startsWith('```')));
  assert.deepEqual(lines.filter(l => /^## /.test(l)), ['## 第 1 輪']);
  assert.ok(r.body.includes('> ## 我的標題\n>\n> ```ts\n> const a = 1;\n>\n> let b = 2;\n> ```\n>\n> | a | b |'));
});

test('金鑰遮罩:發言、結論、主題都不留金鑰', () => {
  const key = 'sk-abcdefghijklmnopqrstuvwxyz123456';
  const input = { ...base(), topic: `用 ${key} 測試`, conclusion: `結論含 ${key}`, transcript: [{ round: 1, name: '獵戶', nodeId: 'node-orion', text: `金鑰 ${key}` }] };
  const dir = mkdtempSync(join(tmpdir(), 'meeting-'));
  const res = writeMeetingRecord(dir, input);
  assert.ok(res.masked >= 3);
  assert.ok(!res.path.includes('sk-abc'));
  const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
  assert.ok(!text.includes('sk-abcdef') && text.includes('[已遮罩]'));
});

test('本機路徑遮罩:各種絕對路徑整段隱藏', () => {
  const cases = [
    ['開 C:\\Users\\bob\\Desktop\\a.md 看看', `開 ${H} 看看`],
    ['開 d:/work/bob/a.ts 看看', `開 ${H} 看看`],
    ['Z:\\x\\y.txt', H],
    ['見 file:///C:/Users/bob/a.md 這個', `見 ${H} 這個`],
    ['共用 \\\\server\\share\\bob\\a.md 在那', `共用 ${H} 在那`],
    ['在 /Users/bob/code/a.ts 裡', `在 ${H} 裡`],
    ['在 /home/bob/.config/x 裡', `在 ${H} 裡`],
    ['(見 C:\\Users\\bob\\a.md)', `(見 ${H})`],
    ['改了 C:\\Users\\bob\\a.md.', `改了 ${H}.`],
    ['路徑 "C:\\Users\\bob\\a.md",再說', `路徑 "${H}",再說`],
    ['路徑 C:\\Users\\bob\\a.md,再說', `路徑 ${H},再說`],
    // 其他常見的 Unix 絕對路徑(2026-11-23 補)
    ['暫存在 /tmp/bob-build/out.log 裡', `暫存在 ${H} 裡`],
    ['裝在 /opt/bob/app/bin 下', `裝在 ${H} 下`],
    ['紀錄 /var/log/bob/x.log 看', `紀錄 ${H} 看`],
    ['root 的 /root/.ssh/config 別動', `root 的 ${H} 別動`],
    ['磁碟 /Volumes/BobDisk/a.md 上', `磁碟 ${H} 上`],
    ['mac 暫存 /private/var/folders/xy/bob/T/a 裡', `mac 暫存 ${H} 裡`],
    ['服務 /srv/bob/www 下', `服務 ${H} 下`],
  ];
  for (const [src, want] of cases) assert.equal(maskLocalPaths(src).text, want, src);
  assert.equal(maskLocalPaths('C:\\a\\b 和 D:\\c\\d').masked, 2);
});

test('本機路徑遮罩:資料夾名稱含空白,使用者名稱一定被遮掉', () => {
  const r = maskLocalPaths('檔案在 C:\\Users\\someone\\Desktop\\my project\\a.md 請看');
  assert.equal(r.text, `檔案在 ${H} 請看`);
  assert.equal(maskLocalPaths('C:\\Program Files (x86)\\App\\run.exe 啟動').text, `${H} 啟動`);
  // 取捨:最後一段不含空白,所以路徑結尾在空白就停;最後一段若有空白,空白之後的字不遮,但前面(含使用者名稱)已被遮
  const t = maskLocalPaths('C:\\Users\\someone\\my notes.txt 在這');
  assert.ok(!t.text.includes('someone'));
  // 取捨:路徑後面的句子若又接斜線,會多遮一些(寧可多遮)
  const o = maskLocalPaths('C:\\Users\\bob open src/a.ts');
  assert.ok(!o.text.includes('bob'));
});

test('相對路徑、網址、一般文字不動', () => {
  for (const s of ['/etc/hosts 與 /usr/bin/env 是系統路徑', '相對 src/tmp/a.ts 與 ./opt/x、build/var/y', 'https://x.example/tmp/a 與 http://x/opt/b', '只有 /tmp 或 /opt/ 沒有內容', '改 src/main/x.ts 與 docs\\a.md', '見 ./home/x 與 ../Users/y', 'https://example.com/home/a 與 http://x/Users/a', 'src/home/a.ts', '時間 12:30 比數 3:1', 'a:b']) {
    assert.deepEqual(maskLocalPaths(s), { text: s, masked: 0 }, s);
  }
});

test('發言內容的本機路徑在檔案裡被遮罩,專案ID 不遮', () => {
  const input = { ...base(), transcript: [{ round: 1, name: '獵戶', nodeId: 'node-orion', text: '改了 C:\\Users\\bob\\proj\\a.ts 與 src/b.ts' }] };
  const r = buildMeetingRecord(input);
  assert.ok(r.body.includes(`> 改了 ${H} 與 src/b.ts`));
  assert.ok(!r.body.includes('bob'));
  assert.equal(r.meta['專案ID'], 'c:/projects/star-app');
});

test('寫入:建立檔案、檔頭讀得回來;同名加序號、不覆蓋;沒有發言不寫', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meeting-'));
  const a = writeMeetingRecord(dir, base());
  assert.equal(a.action, 'created');
  assert.equal(a.path, `meetings/star-app/${localDay(T1)}-登入流程怎麼改.md`);
  const text = readFileSync(join(dir, ...a.path.split('/')), 'utf8');
  assert.ok(text.startsWith('---\n種類: "會議紀錄"\n'));
  assert.ok(text.includes('\n狀態: "未確認"\n---\n\n## 結論'));
  const b = writeMeetingRecord(dir, base());
  const c = writeMeetingRecord(dir, base());
  assert.equal(b.path, a.path.replace(/\.md$/, '-2.md'));
  assert.equal(c.path, a.path.replace(/\.md$/, '-3.md'));
  assert.ok(existsSync(join(dir, ...a.path.split('/'))));
  assert.equal(readFileSync(join(dir, ...a.path.split('/')), 'utf8'), text);

  const empty = mkdtempSync(join(tmpdir(), 'meeting-'));
  assert.equal(writeMeetingRecord(empty, { ...base(), transcript: [] }), null);
  assert.equal(writeMeetingRecord(empty, { ...base(), transcript: [{ round: 0, name: '主控台', text: '失敗' }] }), null);
  assert.ok(!existsSync(join(empty, 'meetings')));
});

test('interop 的會議轉成紀錄:結語變成結論且不重複、散會說明略過、結束原因對應', () => {
  const live = {
    id: 'm9', topic: '主題', callerId: 'h1', callerName: '主持', participants: [{ id: 'p1', name: '甲' }], project: { id: 'c:/x/y', name: 'y' },
    createdAt: T0, status: 'done', conclusion: '最後結論',
    transcript: [
      { round: 1, name: '甲', nodeId: 'p1', text: '我的看法' },
      { round: 1, name: '主持(主持人)', nodeId: 'h1', text: '中途追問' },
      { round: 1, name: '主持(主持人)', nodeId: 'h1', text: '最後結論' },
      { round: 0, name: '主控台', nodeId: null, text: '主持人結束了會議。' },
    ],
  };
  const r = meetingRecordOf(live, T1);
  assert.equal(r.conclusion, '最後結論');
  assert.deepEqual(r.transcript.map(t => t.text), ['我的看法', '中途追問'], '結語只出現在結論;散會說明略過;中途的主持人發言保留');
  assert.deepEqual(r.participants, [{ id: 'p1', name: '甲' }]);
  assert.equal(r.projectId, 'c:/x/y');
  assert.equal(r.endReason, '完成');
  assert.equal(meetingRecordOf({ ...live, status: 'failed' }, T1).endReason, '中止');
  assert.equal(meetingRecordOf({ ...live, timedOut: true }, T1).endReason, '逾時');
  const noEnd = meetingRecordOf({ ...live, conclusion: '' }, T1);
  assert.equal(noEnd.conclusion, undefined);
  assert.equal(noEnd.transcript.length, 3, '沒有結語時主持人的發言都保留');
  const body = buildMeetingRecord(r).body;
  assert.ok(body.startsWith('## 結論') && body.split('最後結論').length === 2, body);
});

const TRICKY = ['*星 #1', 'Agent #2', '議題 #3', 'x:', '2026', 'true', 'null', '~', '1e3', '0x1F', "O'Brien", '甲，乙', 'a, b', 'q"uote', 'back\\slash', '"全引號"', '尾端\\', '[x]', '{y}', '- 開頭', '& 錨點', '! 標記', 'a]b, {c}: "d"', '> 大於', '%百分', '@at', '`tick`', "'單引號'", '日本語 # 註解', '中,英;混', 'k: v', '色\x1b[31m紅', '響\x07鈴', '空\x00字', 'tab\t字', 'a\u2028b', '控\x85制', '😀表情😀'];

test('檔頭 YAML:刁鑽的主題與名稱寫檔後讀回完全相同(字串、清單長度與內容)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meeting-'));
  const oneLineOf = x => x.replace(/\s+/g, ' ').trim().replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]/g, ' ');
  TRICKY.forEach((t, i) => {
    const input = base();
    input.topic = t;
    input.hostName = t;
    input.projectName = t;
    input.participants = [{ id: 'node-p0', name: t }, ...TRICKY.slice(0, 6).map((n, k) => ({ id: `node-${k}`, name: n })), { id: 'node-x', name: TRICKY[(i + 3) % TRICKY.length] }];
    const res = writeMeetingRecord(dir, input);
    const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
    assert.ok(text.startsWith('---\n'), '第一行是 ---');
    const fm = parseFrontMatter(text);
    assert.equal(fm.hasBlock, true);
    assert.equal(fm.meta.get('主題'), oneLineOf(t), `主題 ${t}`);
    assert.equal(fm.meta.get('主持人'), oneLineOf(t), `主持人 ${t}`);
    assert.equal(fm.meta.get('專案'), oneLineOf(t), `專案 ${t}`);
    assert.deepEqual(fm.meta.get('參與者'), input.participants.map(p => oneLineOf(p.name)), `參與者 ${t}`);
    assert.deepEqual(fm.meta.get('參與節點ID'), input.participants.map(p => p.id));
    assert.equal(fm.meta.get('輪數'), '2');
    assert.equal(fm.meta.get('狀態'), '未確認');
    assert.equal(fm.meta.get('種類'), '會議紀錄');
    if (yaml) {
      const doc = yaml.load(text.split('\n---\n')[0].replace(/^---\n/, ''));
      assert.equal(doc['主題'], oneLineOf(t), `js-yaml 主題 ${t}`);
      assert.deepEqual(doc['參與者'], input.participants.map(p => oneLineOf(p.name)), `js-yaml 參與者 ${t}`);
    }
  });
});

test('檔頭 YAML:遮罩字樣與正文一致(不換成全形),預設的 serializeFrontMatter 行為不變', async () => {
  const { serializeFrontMatter } = await import('../src/main/memory-write.ts');
  const r = buildMeetingRecord({ ...base(), topic: '看 C:\\Users\\bob\\a.md 與 sk-abcdefghijklmnopqrstuvwxyz123456' });
  assert.equal(r.meta['主題'], `看 ${H} 與 sk-abcdefghijklmnopqrstuvwxyz123456`);
  const dir = mkdtempSync(join(tmpdir(), 'meeting-'));
  const res = writeMeetingRecord(dir, { ...base(), topic: r.meta['主題'] });
  const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
  assert.ok(text.includes(`主題: "看 ${H} 與 [已遮罩]"`), text.split('\n').slice(0, 4).join('|'));
  assert.equal(serializeFrontMatter({ a: 'x', b: ['y', 'z'], c: 3 }), '---\na: x\nb: [y, z]\nc: 3\n---\n');
  assert.equal(serializeFrontMatter({ a: 'x', b: ['y', 'z'], c: 3 }, true), '---\na: "x"\nb: ["y", "z"]\nc: 3\n---\n');
});

test('本機路徑遮罩:JSON 跳脫、Git Bash / MSYS / WSL、冒號後、特殊字元帳號,使用者名稱不留任何部分', () => {
  const cases = [
    ['{"cwd":"C:\\\\Users\\\\bob\\\\proj"}', `{"cwd":"${H}"}`],
    ['在 /c/Users/bob/proj 裡', `在 ${H} 裡`],
    ['在 /mnt/c/Users/bob/x 裡', `在 ${H} 裡`],
    ['在 /d/work/x 裡', `在 ${H} 裡`],
    ['PATH=/usr/bin:/home/bob/bin', `PATH=/usr/bin:${H}`],
    ['scp host:/home/bob/x', `scp host:${H}`],
    ["C:\\Users\\O'Brien\\x", H],
    ['C:\\Users\\a,b\\x', H],
    ['C:\\Users\\a;b\\x', H],
    ['C:\\Users\\a（b\\x', H],
    ['C:\\Users\\王 小明\\Desktop\\a.md', H],
    ['/home/王 小明/proj/a.md 看', `${H} 看`],
    ["file:///C:/Users/O'Brien/a.md 這", `${H} 這`],
  ];
  for (const [src, want] of cases) {
    const got = maskLocalPaths(src).text;
    assert.equal(got, want, src);
    for (const name of ['bob', 'Brien', '王', '小明']) assert.ok(!got.includes(name), `${src} 殘留 ${name}`);
  }
  // 網址與相對路徑照舊不動
  for (const s of ['https://example.com/c/Users/bob', 'http://x/home/a', 'a/b/c', './d/x', '../c/Users/y', 'src/c/x.ts']) {
    assert.deepEqual(maskLocalPaths(s), { text: s, masked: 0 }, s);
  }
});

test('本機路徑遮罩:惡意長輸入不會卡住(線性時間)', () => {
  const inputs = [
    'C:\\' + 'a '.repeat(12000),
    'C:\\' + 'a'.repeat(30000),
    '\\\\'.repeat(15000),
    '/a/'.repeat(10000),
    'C:\\Users\\bob' + ')'.repeat(30000),
    'C:\\Users\\x' + '. '.repeat(15000) + ')'.repeat(15000),
    'C:%5C' + '%5C'.repeat(10000),
    'C:\\'.repeat(10000),
    'C:\\Users\\' + "O'a,;（".repeat(6000),
    '/home/' + 'x y z w '.repeat(5000) + '/',
    ' '.repeat(30000) + 'C:\\Users\\bob',
  ];
  for (const s of inputs) {
    const t0 = Date.now();
    maskLocalPaths(s);
    assert.ok(Date.now() - t0 < 500, `耗時過長 ${Date.now() - t0}ms:${s.slice(0, 20)}`);
  }
});

test('主題遮罩後產生檔名:帳號名稱不殘留,[ ] # ^ | 被去掉', () => {
  const r = buildMeetingRecord({ ...base(), topic: "看 C:\\Users\\O'Brien\\x 與 C:\\Users\\王 小明\\a.md" });
  assert.ok(!/Brien|王|小明/.test(r.baseName), r.baseName);
  const k = buildMeetingRecord({ ...base(), topic: '連結 [[a|b]] #標籤 ^塊' });
  assert.equal(k.baseName, `${localDay(T1)}-連結 ab 標籤 塊`);
  assert.ok(!/[[\]#^|]/.test(k.baseName));
});

test('專案資料夾名稱:去掉開頭的 _ 與 .,並去掉 [ ] # ^ |', () => {
  const dirOf = projectName => buildMeetingRecord({ ...base(), projectName }).dir;
  assert.equal(dirOf('_private'), 'meetings/private');
  assert.equal(dirOf('.hidden'), 'meetings/hidden');
  assert.equal(dirOf('__..x'), 'meetings/x');
  assert.equal(dirOf('[a]#b^c|d'), 'meetings/abcd');
  assert.equal(dirOf('___'), 'meetings/未命名');
});

test('inRound:round 0 的說明放在實際發生的那一輪,輪數也算進去', () => {
  const r = buildMeetingRecord({ ...base(), conclusion: undefined, transcript: [
    { round: 1, name: '獵戶', nodeId: 'node-orion', text: 'a' },
    { round: 0, name: '主控台', nodeId: null, text: '天琴:(第 2 輪略過:目前在休眠)', inRound: 2 },
    { round: 0, name: '主控台', nodeId: null, text: '織女:(第 2 輪略過:逾時)', inRound: 2 },
  ] });
  assert.equal(r.meta['輪數'], 2);
  assert.deepEqual(r.body.split('\n').filter(l => /^#{2,3} /.test(l)), ['## 第 1 輪', '### 獵戶 · node-orion', '## 第 2 輪', '### 主控台 · -', '### 主控台 · -']);
  // 沒有 inRound 時沿用「最近一輪」
  const n = buildMeetingRecord({ ...base(), conclusion: undefined, transcript: [
    { round: 1, name: '獵戶', nodeId: 'node-orion', text: 'a' },
    { round: 0, name: '主控台', nodeId: null, text: '說明' },
  ] });
  assert.equal(n.meta['輪數'], 1);
  assert.deepEqual(n.body.split('\n').filter(l => /^## /.test(l)), ['## 第 1 輪']);
});

test('meetingRecordOf:結語去重刪最後一則、round 0 說明轉主控台並加原名稱、主持人名稱去後綴、inRound 帶過去', () => {
  const live = {
    id: 'm9', topic: '主題', callerId: 'h1', callerName: '主持(主持人)', participants: [{ id: 'p1', name: '甲' }],
    createdAt: T0, status: 'failed', conclusion: '同樣的話',
    transcript: [
      { round: 1, name: '主持(主持人)', nodeId: 'h1', text: '同樣的話' },
      { round: 1, name: '甲', nodeId: 'p1', text: '回應' },
      { round: 0, name: '甲', nodeId: 'p1', text: '(第 2 輪略過:休眠)', inRound: 2 },
      { round: 2, name: '主持(主持人)', nodeId: 'h1', text: '同樣的話' },
    ],
  };
  const r = meetingRecordOf(live, T1);
  assert.deepEqual(r.transcript.map(t => [t.round, t.name, t.nodeId, t.text, t.inRound]), [
    [1, '主持', 'h1', '同樣的話', undefined],
    [1, '甲', 'p1', '回應', undefined],
    [0, '主控台', null, '甲:(第 2 輪略過:休眠)', 2],
  ], '刪的是最後一則,第一則保留');
  assert.equal(r.hostName, '主持');
  const b = buildMeetingRecord(r);
  assert.equal(b.meta['輪數'], 2);
  assert.ok(b.body.includes('## 第 2 輪\n\n### 主控台 · -\n\n> 甲:(第 2 輪略過:休眠)'));
});

test('寫進臨時記憶庫後被索引成 meeting、狀態未確認、標題與專案讀得對', () => {
  const dir = mkdtempSync(join(tmpdir(), 'meeting-'));
  const res = writeMeetingRecord(dir, { ...base(), topic: '議題 #3: 登入' });
  const e = entryFromFile(res.path, readFileSync(join(dir, ...res.path.split('/')), 'utf8'), 0, 0);
  assert.equal(e.kind, 'meeting');
  assert.equal(e.status, '未確認');
  assert.equal(e.title, '議題 #3: 登入');
  assert.equal(e.projectId, 'c:/projects/star-app');
  assert.equal(e.nodeId, 'node-orion');
});

test('本機路徑遮罩:帳號資料夾是最後一段(含空白、撇號、全形空白),名稱不漏', () => {
  const cases = [
    ['C:\\Users\\John Doe', H],
    ['cd C:\\Users\\John Doe 然後', null],
    ['/home/john doe', H],
    ["C:\\Users\\O'Brien", H],
    ['C:\\Users\\王\u3000小明\\Desktop', H],
    ['C:\\Users\\王\u3000小明', H],
    ['/Users/John Doe', H],
    ["看 C:\\Users\\O'Brien, 然後", `看 ${H}, 然後`],
    ['在 C:\\Users\\bob.', `在 ${H}.`],
    ['C:\\Users\\John Doe\\Desktop\\a.md', H],
  ];
  for (const [src, want] of cases) {
    const got = maskLocalPaths(src).text;
    if (want !== null) assert.equal(got, want, src);
    for (const name of ['John', 'Doe', 'john', 'doe', 'Brien', '王', '小明', 'bob']) assert.ok(!got.includes(name), `${src} 殘留 ${name}:${got}`);
  }
  assert.ok(maskLocalPaths('cd C:\\Users\\John Doe 然後').text.startsWith('cd ' + H));
  // 一般最後一段的截斷規則不變
  assert.equal(maskLocalPaths('路徑 C:\\Users\\bob\\a.md,再說').text, `路徑 ${H},再說`);
});

test('本機路徑遮罩:\\\\.\\C:\\、斜線 UNC、網址編碼的反斜線;逸出字串與 regex 不誤遮', () => {
  assert.equal(maskLocalPaths('\\\\.\\C:\\Users\\bob\\x').text, H);
  assert.equal(maskLocalPaths('\\\\?\\C:\\Users\\bob\\x').text, H);
  assert.equal(maskLocalPaths('開 \\\\wsl$\\Ubuntu\\home\\bob\\x 看').text, `開 ${H} 看`);
  assert.equal(maskLocalPaths('//server/share/bob/x 在').text, `${H} 在`);
  assert.equal(maskLocalPaths('C:%5CUsers%5Cbob%5Cproj').text, H);
  assert.equal(maskLocalPaths('C:%5cUsers%2Fbob').text, H);
  for (const s of ['escape \\\\n in JSON', '`\\\\d+`', 'regex \\\\w+\\\\s', 'https://example.com/a/b', '// 註解 a/b']) {
    assert.deepEqual(maskLocalPaths(s), { text: s, masked: 0 }, s);
  }
});

test('檔頭 YAML:控制字元不破壞合法性,摘要以字元截斷不留孤立代理字元', () => {
  const r = buildMeetingRecord({ ...base(), conclusion: '😀'.repeat(199) + '😀😀尾' });
  const sum = r.meta['摘要'];
  assert.equal(Array.from(sum).length, 201);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(sum), '沒有孤立代理字元');
  const dir = mkdtempSync(join(tmpdir(), 'meeting-'));
  const res = writeMeetingRecord(dir, { ...base(), topic: '色\x1b[31m紅\x07鈴\x00', conclusion: '結\x1b[0m語\r單獨' });
  const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
  const head = text.split('\n---\n')[0].replace(/^---\n/, '');
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(head.replace(/\n/g, '')), '檔頭沒有控制字元');
  assert.doesNotThrow(() => yaml.load(head));
  assert.equal(yaml.load(head)['主題'], parseFrontMatter(text).meta.get('主題'));
});

test('空名稱改用節點ID;引號內的空字串項目讀回長度一致', () => {
  const r = buildMeetingRecord({ ...base(), hostName: '  ', participants: [{ id: 'node-a', name: '' }, { id: 'node-b', name: '乙' }] });
  assert.deepEqual(r.meta['參與者'], ['node-a', '乙']);
  assert.equal(r.meta['主持人'], 'node-orion');
  const fm = parseFrontMatter('---\n參與者: ["", "x"]\n空白項: [a, , b]\n---\n');
  assert.deepEqual(fm.meta.get('參與者'), ['', 'x']);
  assert.deepEqual(fm.meta.get('空白項'), ['a', 'b']);
});

test('參與者名稱含全形「，」「、」:每個名稱都在雙引號內,讀回不被拆開;參與者不含主持人', () => {
  const vault = mkdtempSync(join(tmpdir(), 'nexus-meeting-names-'));
  const names = ['北河、二號', '甲，乙', '丙、丁，戊', 'a, b'];
  const r = writeMeetingRecord(vault, { ...base(), participants: [{ id: 'node-orion', name: '獵戶' }, ...names.map((n, i) => ({ id: `node-${i}`, name: n })), { id: 'node-0', name: '重複' }] });
  const text = readFileSync(join(vault, r.path), 'utf8');
  assert.ok(text.includes('參與者: ["北河、二號", "甲，乙", "丙、丁，戊", "a, b"]'), text.slice(0, 500));
  assert.ok(text.includes('參與節點ID: ["node-0", "node-1", "node-2", "node-3"]'), '主持人與重複的節點不列入參與者');
  const fm = parseFrontMatter(text);
  assert.deepEqual(fm.meta.get('參與者'), names);
  assert.deepEqual(yaml.load(text.split('\n---\n')[0].replace(/^---\n/, ''))['參與者'], names);
  assert.equal(fm.meta.get('節點ID'), 'node-orion');
});

test('專案資料夾名稱也遮金鑰', () => {
  const r = buildMeetingRecord({ ...base(), projectName: 'proj-sk-abcdefghijklmnopqrstuvwxyz123456' });
  assert.ok(!r.dir.includes('sk-abcdef'), r.dir);
});

test('短標題:取第一句、拿掉括號補充、太長截斷;檔頭「標題」與檔名用它,「主題」保留全文', () => {
  const long = '討論使用 CosyVoice 直接生成 Entropy Nexus 英文版語音（只討論、不修改檔案）。背景給兩位參考：1. 我們剛在大廳用本機 Qwen3-TTS 產出了四位角色的原創英文參考音檔。2. 使用者想討論改用 CosyVoice。';
  assert.equal(shortTitle(long), '討論使用 CosyVoice 直接生成 Entropy Nexus 英文版語音');
  assert.equal(shortTitle('登入流程怎麼改'), '登入流程怎麼改');
  assert.equal(shortTitle('議題 #3: 登入'), '議題 #3: 登入');
  assert.equal(shortTitle('## **重點** 是 `API`'), '重點 是 API');
  const t = shortTitle('這是一個沒有任何標點而且非常非常非常非常非常非常長的會議主題需要被截斷');
  assert.ok(t.endsWith('…') && Array.from(t).length <= TITLE_MAX, t);
  assert.equal(shortTitle(''), '未命名會議');
  // 開頭的【…】直接當標題;【主題】這類標籤拿掉;太長時用冒號前面那一段
  assert.equal(shortTitle('【最新進度與下一步】主控台(entropy nexus public)與寶庫(entropy nexus mind vault)現況盤點,以及協作流程的規劃。'), '最新進度與下一步');
  assert.equal(shortTitle('【主題】mochii diary pilot：在「學生自評之後」套用輔導框架,請依你們已收集的文獻提出想法(只討論,不實作)。'), 'mochii diary pilot');
  assert.equal(shortTitle('整合文獻討論：針對校園第一級 SEL「自我覺察」與「自我管理」如何設計可行且有實證依據的介入方案？ 【我方已整理之統合分析】'), '整合文獻討論');
  // 寫進記憶庫:檔頭有短標題、主題是全文,檔名用短標題,同一天同一個標題加序號
  const dir = mkdtempSync(join(tmpdir(), 'meeting-title-'));
  const a = writeMeetingRecord(dir, { ...base(), topic: long });
  const b = writeMeetingRecord(dir, { ...base(), topic: long + '另一場' });
  const text = readFileSync(join(dir, ...a.path.split('/')), 'utf8');
  assert.ok(text.includes('標題: "討論使用 CosyVoice 直接生成 Entropy Nexus 英文版語音"'), text.split('\n').slice(0, 5).join('|'));
  assert.ok(text.includes('背景給兩位參考'), '主題保留全文');
  assert.ok(a.path.endsWith('-討論使用 CosyVoice 直接生成 Entropy Nexus 英文版語音.md'), a.path);
  assert.ok(b.path.endsWith('-討論使用 CosyVoice 直接生成 Entropy Nexus 英文版語音-2.md'), b.path);
  assert.equal(entryFromFile(a.path, text, 0, 0).title, '討論使用 CosyVoice 直接生成 Entropy Nexus 英文版語音');
});

console.log(`\n${passed} 項通過`);
