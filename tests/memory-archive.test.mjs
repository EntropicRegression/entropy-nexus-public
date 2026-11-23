// 驗收:刪除節點時的歸檔與接回(src/main/memory-archive.ts):封存檔內容與區段順序、檔名撞名加序號、
// 誰來寫總結的決策、封存比對與接回側寫(含使用者改過的側寫)。
// 用法:node --no-warnings tests/memory-archive.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archivePath, attachArchive, buildArchive, caseNumber, chiefSummaryPrompt, decideSummarizer, extractSection, findArchive, writeArchive } from '../src/main/memory-archive.ts';
import { computeNodeStats } from '../src/shared/node-stats.ts';
import { entryFromFile, parseFrontMatter } from '../src/main/memory-vault.ts';
import { writeMemory } from '../src/main/memory-write.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const tmp = () => mkdtempSync(join(tmpdir(), 'nexus-archive-'));
const NOW = new Date(2026, 10, 21, 15, 30);
const T0 = new Date(2026, 10, 20, 9, 0).getTime();
let n = 0;
const task = (status, o = {}) => ({ id: `t${++n}`, agentId: 'n1', agentName: 'Hagemi', backend: 'claude', model: 'sonnet', title: `任務${n}`, status, note: '', steps: [], subs: [], startedAt: T0 + n * 60000, endedAt: status === 'running' ? null : T0 + n * 60000 + 90000, project: { id: 'p', name: '專案甲' }, ...o });
const node = { id: 'n1', name: 'Hagemi', backend: 'claude', backendLabel: 'Claude Code', model: 'sonnet', character: '小圓', createdAt: T0 - 86400000 };
const mk = (o = {}) => {
  const tasks = o.tasks ?? [task('done', { verdict: 'accepted' }), task('failed'), task('done')];
  return { node, stats: computeNodeStats(tasks).get('n1'), tasks, traits: '擅長重構', summary: '先讀再改', summarySource: '節點自己', noSummaryReason: '', cases: ['2026-0003'], now: NOW, ...o };
};

test('封存檔:屬性與區段順序(基本資料、特長、任務紀錄、解決問題的流程、判例)', () => {
  const { meta, body } = buildArchive(mk());
  assert.deepEqual([meta.種類, meta.狀態, meta.節點ID, meta.節點, meta.後台, meta.模型, meta.角色, meta.總結來源], ['node', '封存', 'n1', 'Hagemi', 'Claude Code', 'sonnet', '小圓', '節點自己']);
  assert.equal(meta.封存時間, '2026-11-21 15:30');
  const heads = body.split('\n').filter(l => l.startsWith('## '));
  assert.deepEqual(heads, ['## 基本資料', '## 特長', '## 任務紀錄', '## 解決問題的流程', '## 判例']);
  assert.ok(body.includes('做過的專案:專案甲(3 個任務)'));
  assert.ok(body.includes('任務 3 件:完成 2、失敗 1、中斷 0'));
  assert.ok(body.includes('驗收率 100%(1/1)'));
  assert.ok(/- 2026-11-20 \d\d:\d\d 「任務\d+」完成 · 1 分 30 秒 · 已驗收/.test(body));
  assert.equal(extractSection(body, '解決問題的流程'), '先讀再改');
  assert.ok(extractSection(body, '判例').includes('- 2026-0003'));
});

test('任務紀錄只列最近 20 個、新的在前;沒有任務時寫「尚無任務紀錄」', () => {
  const many = Array.from({ length: 25 }, () => task('done'));
  const sec = extractSection(buildArchive(mk({ tasks: many })).body, '任務紀錄');
  const lines = sec.split('\n').filter(l => l.startsWith('- 2026'));
  assert.equal(lines.length, 20);
  assert.ok(lines[0].includes(`「${many.at(-1).title}」`));
  assert.ok(extractSection(buildArchive(mk({ tasks: [], stats: undefined })).body, '任務紀錄').includes('尚無任務紀錄'));
});

test('沒有總結、特長、判例時省略該區段,原因寫在基本資料', () => {
  const { meta, body } = buildArchive(mk({ summary: '', summarySource: '無', noSummaryReason: '節點無法回覆,也沒有總管可以代寫', traits: '', cases: [] }));
  assert.equal(meta.總結來源, '無');
  assert.deepEqual(body.split('\n').filter(l => l.startsWith('## ')), ['## 基本資料', '## 任務紀錄']);
  assert.ok(body.includes('工作總結:沒有(節點無法回覆,也沒有總管可以代寫)'));
});

test('檔名:封存/<名稱>-<日期>.md,同一天撞名加 -2、-3,不合法的字元被清掉', () => {
  const v = tmp();
  assert.equal(writeArchive(v, mk()).path, 'nodes/封存/Hagemi-2026-11-21.md');
  assert.equal(writeArchive(v, mk()).path, 'nodes/封存/Hagemi-2026-11-21-2.md');
  assert.equal(writeArchive(v, mk()).path, 'nodes/封存/Hagemi-2026-11-21-3.md');
  assert.equal(archivePath(v, 'a/b:c', NOW), 'nodes/封存/ab c-2026-11-21.md'.replace('ab c', 'abc'));
  const parsed = parseFrontMatter(readFileSync(join(v, 'nodes', '封存', 'Hagemi-2026-11-21.md'), 'utf8'));
  assert.equal(parsed.meta.get('狀態'), '封存');
});

test('寫入前遮罩總結裡的金鑰', () => {
  const v = tmp();
  const r = writeArchive(v, mk({ summary: '常用 password: hunter2secret 登入' }));
  assert.ok(!readFileSync(join(v, r.path), 'utf8').includes('hunter2secret'));
  assert.equal(r.masked, 1);
});

test('誰來寫總結:直接刪除→無;節點能回→自己;不能或失敗→總管;沒有總管→無', () => {
  const d = o => decideSummarizer({ mode: 'summary', selfAvailable: true, selfFailed: false, chiefAvailable: true, ...o });
  assert.equal(d({ mode: 'stats' }), 'none');
  assert.equal(d({}), 'self');
  assert.equal(d({ selfAvailable: false }), 'chief');
  assert.equal(d({ selfFailed: true }), 'chief');
  assert.equal(d({ selfAvailable: false, chiefAvailable: false }), 'none');
  assert.equal(d({ selfFailed: true, chiefAvailable: false }), 'none');
});

test('總管代寫的提示:帶任務標題與最近回覆,沒有資料時註明', () => {
  const p = chiefSummaryPrompt('Hagemi', ['修 bug', '寫測試'], ['改好了']);
  assert.ok(p.startsWith('〔歸檔總結:總管代寫〕') && p.includes('- 修 bug') && p.includes('(1) 改好了'));
  assert.ok(chiefSummaryPrompt('X', [], []).includes('(沒有紀錄)'));
});

/** 把檔案寫進記憶庫並轉成索引項目。 */
const indexOf = (v, rel) => { const abs = join(v, rel); return entryFromFile(rel, readFileSync(abs, 'utf8'), 1, 1); };

test('封存比對:名稱相同、狀態是封存,取最新(日期、序號);其次比對角色', () => {
  const v = tmp();
  const paths = ['nodes/封存/Hagemi-2026-10-01.md', 'nodes/封存/Hagemi-2026-11-21.md', 'nodes/封存/Hagemi-2026-11-21-2.md', 'nodes/封存/小圓-2026-09-09.md'];
  const entries = [];
  for (const p of paths) { writeMemory(v, p, { 種類: 'node', 狀態: '封存', 節點: 'x' }, '## 特長\n\n擅長重構'); entries.push(indexOf(v, p)); }
  assert.deepEqual(findArchive(entries, ['Hagemi']), { path: 'nodes/封存/Hagemi-2026-11-21-2.md', date: '2026-11-21', name: 'Hagemi' });
  assert.equal(findArchive(entries, ['Other', '小圓']).path, 'nodes/封存/小圓-2026-09-09.md');
  assert.equal(findArchive(entries, ['Other', '']), null);
  assert.equal(findArchive(entries, ['Hagemi2']), null);
  // 狀態不是封存(例如同名的現役側寫)不算
  writeMemory(v, 'nodes/封存/Live-2026-11-21.md', { 種類: 'node', 狀態: '已確認' }, 'x');
  assert.equal(findArchive([indexOf(v, 'nodes/封存/Live-2026-11-21.md')], ['Live']), null);
});

test('接回:特長與解決問題的流程複製進側寫,加「接回自」;任務紀錄不會帶過去', () => {
  const v = tmp();
  const a = writeArchive(v, mk());
  const r = attachArchive(v, a.path, { id: 'n2', name: 'Hagemi', backendLabel: 'Claude Code', model: 'opus' }, NOW);
  assert.equal(r.path, 'nodes/Hagemi-n2.md', '新的側寫依節點 ID 命名');
  assert.equal(r.action, 'created');
  const text = readFileSync(join(v, 'nodes', 'Hagemi-n2.md'), 'utf8');
  const { meta, body } = parseFrontMatter(text);
  assert.equal(meta.get('接回自'), a.path);
  assert.equal(meta.get('節點ID'), 'n2');
  assert.equal(meta.get('模型'), 'opus');
  assert.equal(extractSection(body, '特長'), '擅長重構');
  assert.equal(extractSection(body, '解決問題的流程'), '先讀再改');
  assert.ok(!body.includes('任務紀錄'));
});

test('接回:使用者改過的側寫只附加不覆寫;封存沒有可接回的內容時不寫檔', () => {
  const v = tmp();
  const a = writeArchive(v, mk());
  writeMemory(v, 'nodes/Hagemi.md', { 種類: 'node' }, '## 特長\n\n舊的');
  const p = join(v, 'nodes', 'Hagemi.md');
  writeFileSync(p, readFileSync(p, 'utf8') + '\n使用者手寫的備註\n');
  utimesSync(p, new Date(), new Date(Date.now() + 5000));
  const r = attachArchive(v, a.path, { id: 'n2', name: 'Hagemi', backendLabel: 'Claude Code', model: '' }, NOW);
  assert.equal(r.action, 'appended');
  const text = readFileSync(p, 'utf8');
  assert.ok(text.includes('使用者手寫的備註') && text.includes('## 主控台補充') && text.includes('先讀再改'));
  const empty = writeArchive(v, mk({ summary: '', summarySource: '無', traits: '', noSummaryReason: '無' }));
  assert.equal(attachArchive(v, empty.path, { id: 'n3', name: 'Nobody', backendLabel: 'x', model: '' }, NOW), null);
  assert.ok(!existsSync(join(v, 'nodes', 'Nobody.md')));
  assert.throws(() => attachArchive(v, '../evil.md', { id: 'n', name: 'x', backendLabel: '', model: '' }), /不正確/);
  assert.throws(() => attachArchive(v, 'nodes/封存/不存在-2026-01-01.md', { id: 'n', name: 'x', backendLabel: '', model: '' }), /找不到/);
});

test('判例編號取自檔名開頭', () => {
  assert.equal(caseNumber({ path: 'cases/p/2026-0003-案由.md' }), '2026-0003');
  assert.equal(caseNumber({ path: 'cases/p/隨手記.md' }), '隨手記');
});

console.log(`\n${passed} 項通過`);
