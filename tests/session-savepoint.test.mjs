// 驗收:節點 session 存點(src/main/session-savepoint.ts,docs/session存點規劃.md 里程碑 S1):
// 三家工具的檔案定位、建立存點(複製、存點.json、sha256、暫存資料夾改名、撞名加序號)、失敗不丟例外、
// 列出與讀回存點、封存檔補上「存點」欄位(addFrontMatterField)。全程用暫存的假 ~/.claude、~/.codex、~/.gemini。
// 用法:node --no-warnings tests/session-savepoint.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(String.raw`export async function resolve(s,c,n){if(/^\.\.?\//.test(s)&&!/\.\w+$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}`), import.meta.url);
const sp = await import('../src/main/session-savepoint.ts');
const { writeArchive } = await import('../src/main/memory-archive.ts');
const { addFrontMatterField, writeMemory } = await import('../src/main/memory-write.ts');
const { MemoryVault, parseFrontMatter, README } = await import('../src/main/memory-vault.ts');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('[ok]', name); };
const tmp = p => mkdtempSync(join(tmpdir(), `nexus-sp-${p}-`));
const put = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text); };
const sha = text => createHash('sha256').update(text).digest('hex');

const SID = '3c8aaa02-4f3d-47eb-9b55-96dd3fc6683c';
const OTHER = '9f703ca9-169a-4560-a09a-7cb48806f7c9';
const CODEX = '019fe47e-2d83-7be3-8f9c-f6a0473ae84f';

/** 假的家目錄:三家工具各有一段要封存的對話,外加不相干的對話。 */
function fakeHome() {
  const home = tmp('home');
  const roots = sp.defaultSessionRoots({ NEXUS_SESSION_HOME: home });
  put(join(roots.claude, 'projects', 'C--work-a', `${SID}.jsonl`), '{"a":1}\n');
  put(join(roots.claude, 'projects', 'C--work-a', SID, 'subagents', 'agent-1.jsonl'), '{"sub":1}\n');
  put(join(roots.claude, 'projects', 'C--work-a', `${OTHER}.jsonl`), 'other\n');
  put(join(roots.claude, 'projects', 'C--work-b', `${OTHER}.jsonl`), 'other\n');
  put(join(roots.codex, 'sessions', '2026', '08', '09', `rollout-2026-08-09T11-08-22-${CODEX}.jsonl`), '{"codex":1}\n');
  put(join(roots.codex, 'sessions', '2026', '08', '09', `rollout-2026-08-09T11-08-22-${OTHER}.jsonl`), 'other\n');
  put(join(roots.codex, 'archived_sessions', `rollout-2026-07-01T00-00-00-${CODEX}.jsonl`), '{"old":1}\n');
  put(join(roots.agy, 'conversations', `${SID}.db`), 'DB');
  put(join(roots.agy, 'conversations', `${SID}.db-wal`), 'WAL');
  put(join(roots.agy, 'conversations', `${OTHER}.db`), 'other');
  put(join(roots.agy, 'brain', SID, 'notes', 'a.md'), 'brain');
  return { home, roots };
}
const node = (o = {}) => ({ id: 'b65bc7d7-9c2a-4158-a89e-5f5f66add0ff', name: 'claudia', backend: 'claude', backendLabel: 'Claude Code', sessionId: SID, cwd: 'C:\\work\\a', ...o });
const NOW = new Date(2026, 10, 23, 20, 5, 9);

await test('預設根目錄:NEXUS_SESSION_HOME 指向假的家目錄', () => {
  const r = sp.defaultSessionRoots({ NEXUS_SESSION_HOME: join('X:', 'h') });
  assert.equal(r.claude, join('X:', 'h', '.claude'));
  assert.equal(r.codex, join('X:', 'h', '.codex'));
  assert.equal(r.agy, join('X:', 'h', '.gemini', 'antigravity-cli'));
});

await test('定位:Claude Code 找到 jsonl 與同名資料夾,不含別的 session', () => {
  const { roots } = fakeHome();
  const got = sp.locateSessionFiles('claude', SID, roots).map(f => `${f.root}:${f.rel}`).sort();
  assert.deepEqual(got, [`claude:projects/C--work-a/${SID}.jsonl`, `claude:projects/C--work-a/${SID}/subagents/agent-1.jsonl`]);
});

await test('定位:Codex 找 sessions 與 archived_sessions,依檔名結尾比對', () => {
  const { roots } = fakeHome();
  const got = sp.locateSessionFiles('codex', CODEX, roots).map(f => f.rel).sort();
  assert.deepEqual(got, [`archived_sessions/rollout-2026-07-01T00-00-00-${CODEX}.jsonl`, `sessions/2026/08/09/rollout-2026-08-09T11-08-22-${CODEX}.jsonl`]);
});

await test('定位:Antigravity 找 .db、-wal 與 brain 資料夾', () => {
  const { roots } = fakeHome();
  const got = sp.locateSessionFiles('antigravity', SID, roots).map(f => f.rel).sort();
  assert.deepEqual(got, [`brain/${SID}/notes/a.md`, `conversations/${SID}.db`, `conversations/${SID}.db-wal`]);
});

await test('定位:sessionId 含路徑字元或太短時不找', () => {
  const { roots } = fakeHome();
  for (const bad of ['../x', '..\\..\\x', 'a/b', '', 'short']) assert.deepEqual(sp.locateSessionFiles('claude', bad, roots), [], bad);
});

await test('建立存點:複製檔案、存點.json 欄位與 sha256、路徑相對記憶庫、不留暫存資料夾', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const r = await sp.createSavepoint(vault, node(), roots, NOW);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.path, 'nodes/封存/_存點/b65bc7d7-9c2a-4158-a89e-5f5f66add0ff/20261123-200509');
  assert.equal(r.files, 2);
  assert.equal(r.warnLarge, false);
  const m = sp.readSavepoint(vault, r.path);
  assert.ok(m);
  assert.deepEqual([m.版本, m.節點ID, m.節點, m.後台, m.後台ID, m.sessionId, m.工作目錄, m.原因], [1, node().id, 'claudia', 'Claude Code', 'claude', SID, 'C:\\work\\a', '終止']);
  assert.match(m.建立時間, /^2026-11-23T20:05:09[+-]\d{2}:\d{2}$/);
  const main = m.檔案.find(f => f.位置.endsWith('.jsonl') && !f.位置.includes('subagents'));
  assert.deepEqual(main, { 位置: `projects/C--work-a/${SID}.jsonl`, 根目錄: 'claude', 大小: 8, sha256: sha('{"a":1}\n') });
  assert.equal(m.總大小, m.檔案.reduce((n, f) => n + f.大小, 0));
  const copied = join(vault, ...r.path.split('/'), 'files', 'claude', 'projects', 'C--work-a', SID, 'subagents', 'agent-1.jsonl');
  assert.equal(readFileSync(copied, 'utf8'), '{"sub":1}\n');
  const nodeDir = join(vault, 'nodes', '封存', '_存點', node().id);
  assert.deepEqual(readdirSync(nodeDir), ['20261123-200509'], '暫存資料夾已改名,沒有殘留');
  // 原檔沒有被動到
  assert.equal(readFileSync(join(roots.claude, 'projects', 'C--work-a', `${SID}.jsonl`), 'utf8'), '{"a":1}\n');
});

await test('建立存點:Codex 與 Antigravity 的根目錄記成 codex、agy', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const c = await sp.createSavepoint(vault, node({ backend: 'codex', backendLabel: 'Codex', sessionId: CODEX }), roots, NOW);
  assert.equal(c.ok, true);
  assert.ok(sp.readSavepoint(vault, c.path).檔案.every(f => f.根目錄 === 'codex'));
  const a = await sp.createSavepoint(vault, node({ backend: 'antigravity', backendLabel: 'Antigravity' }), roots, new Date(NOW.getTime() + 1000));
  assert.equal(a.ok, true);
  const m = sp.readSavepoint(vault, a.path);
  assert.ok(m.檔案.every(f => f.根目錄 === 'agy'));
  assert.equal(existsSync(join(vault, ...a.path.split('/'), 'files', 'agy', 'conversations', `${SID}.db-wal`)), true);
});

await test('建立存點:同一秒撞名加 -2,列出時新的在前', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const a = await sp.createSavepoint(vault, node(), roots, NOW);
  const b = await sp.createSavepoint(vault, node(), roots, NOW);
  assert.equal(b.path, `${a.path}-2`);
  const c = await sp.createSavepoint(vault, node(), roots, new Date(NOW.getTime() - 60000));
  assert.deepEqual(sp.listSavepoints(vault, node().id), [b.path, a.path, c.path]);
});

await test('建立存點失敗:不丟例外,回傳原因,不留下資料夾', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const none = await sp.createSavepoint(vault, node({ sessionId: null }), roots, NOW);
  assert.equal(none.ok, false);
  assert.match(none.reason, /沒有對話紀錄/);
  const gone = await sp.createSavepoint(vault, node({ sessionId: 'aaaaaaaa-0000-0000-0000-000000000000' }), roots, NOW);
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /找不到/);
  const badId = await sp.createSavepoint(vault, node({ id: '../evil' }), roots, NOW);
  assert.equal(badId.ok, false);
  assert.equal(existsSync(join(vault, 'nodes')), false, '失敗時不建立任何資料夾');
  // 記憶庫路徑其實是檔案:建立資料夾失敗,回傳原因
  const fileVault = join(tmp('v'), 'not-a-dir');
  writeFileSync(fileVault, 'x');
  const broken = await sp.createSavepoint(fileVault, node(), roots, NOW);
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /建立存點失敗/);
});

await test('讀回:說明檔不存在或格式不對時是 null;listSavepoints 不列暫存資料夾、拒絕不合法的節點 ID', () => {
  const vault = tmp('vault');
  const dir = join(vault, 'nodes', '封存', '_存點', 'n1');
  mkdirSync(join(dir, '.20261123-000000.tmp'), { recursive: true });
  mkdirSync(join(dir, '20261122-000000'), { recursive: true });
  writeFileSync(join(dir, '20261122-000000', '存點.json'), '{"版本":2}');
  assert.equal(sp.readSavepoint(vault, 'nodes/封存/_存點/n1/20261122-000000'), null);
  assert.equal(sp.readSavepoint(vault, 'nodes/封存/_存點/n1/none'), null);
  assert.deepEqual(sp.listSavepoints(vault, 'n1'), ['nodes/封存/_存點/n1/20261122-000000']);
  assert.deepEqual(sp.listSavepoints(vault, '../n1'), []);
});

await test('說明文字:成功、失敗、超過 500 MB', () => {
  assert.match(sp.savepointNote({ ok: true, path: 'p', size: 3 * 1024 * 1024, files: 2, warnLarge: false }), /2 個檔案,3\.0 MB/);
  assert.match(sp.savepointNote({ ok: true, path: 'p', size: 1, files: 1, warnLarge: true }), /超過 500 MB/);
  assert.match(sp.savepointNote({ ok: false, reason: '找不到' }), /沒有建立對話存點:找不到/);
});

await test('封存檔補上「存點」欄位:只加一次、其他內容不變、讀得回來', () => {
  const vault = tmp('vault');
  const r = writeArchive(vault, { node: { id: 'n1', name: 'claudia', backend: 'claude', backendLabel: 'Claude Code', model: 'opus', character: '', createdAt: 0 }, stats: undefined, tasks: [], traits: '', summary: '', summarySource: '無', noSummaryReason: '只存統計', cases: [], now: NOW });
  const before = readFileSync(join(vault, ...r.path.split('/')), 'utf8');
  assert.equal(addFrontMatterField(vault, r.path, '存點', 'nodes/封存/_存點/n1/20261123-200509'), true);
  const after = readFileSync(join(vault, ...r.path.split('/')), 'utf8');
  assert.equal(parseFrontMatter(after).meta.get('存點'), 'nodes/封存/_存點/n1/20261123-200509');
  assert.equal(after.replace(/\n存點: [^\n]*/, ''), before, '只多了這一行');
  assert.equal(addFrontMatterField(vault, r.path, '存點', 'other'), false, '已有欄位就不動');
  // 寫完仍算主控台寫的:之後整份取代不會變成附加
  assert.equal(writeMemory(vault, r.path, { 種類: 'node' }, 'x').action, 'replaced');
});

await test('封存檔補欄位:使用者改過的檔案、不存在的檔案、不合法的路徑都不寫', () => {
  const vault = tmp('vault');
  const r = writeMemory(vault, 'nodes/封存/a.md', { 種類: 'node' }, '內容');
  const abs = join(vault, 'nodes', '封存', 'a.md');
  writeFileSync(abs, readFileSync(abs, 'utf8') + '\n使用者加的一行\n');
  assert.equal(addFrontMatterField(vault, r.path, '存點', 'x'), false);
  assert.doesNotMatch(readFileSync(abs, 'utf8'), /存點/);
  assert.equal(addFrontMatterField(vault, 'nodes/封存/none.md', '存點', 'x'), false);
  assert.equal(addFrontMatterField(vault, '../a.md', '存點', 'x'), false);
  assert.equal(addFrontMatterField(vault, r.path, 'bad key', 'x'), false);
});

await test('定位:Codex 檔名要有邊界,短 id 不會誤中別的檔名結尾', () => {
  const home = tmp('home');
  const roots = sp.defaultSessionRoots({ NEXUS_SESSION_HOME: home });
  put(join(roots.codex, 'sessions', '2026', '01', '01', 'rollout-x-xxabcdefgh.jsonl'), 'no');
  put(join(roots.codex, 'sessions', '2026', '01', '01', 'rollout-x-abcdefgh.jsonl'), 'yes');
  put(join(roots.codex, 'sessions', 'abcdefgh.jsonl'), 'yes');
  assert.deepEqual(sp.locateSessionFiles('codex', 'abcdefgh', roots).map(f => f.rel).sort(), ['sessions/2026/01/01/rollout-x-abcdefgh.jsonl', 'sessions/abcdefgh.jsonl']);
});

await test('定位:不跟隨 junction 或符號連結(資料夾本身是連結也一樣)', () => {
  const { roots } = fakeHome();
  const outside = tmp('outside');
  put(join(outside, 'secret.txt'), 'secret');
  // Claude 的同名資料夾、Antigravity 的 brain/<id> 換成指向外面的 junction
  const claudeDir = join(roots.claude, 'projects', 'C--work-b', SID);
  symlinkSync(outside, claudeDir, 'junction');
  put(join(roots.claude, 'projects', 'C--work-b', `${SID}.jsonl`), 'b\n');
  const agyHome = tmp('agy');
  const agyRoots = sp.defaultSessionRoots({ NEXUS_SESSION_HOME: agyHome });
  put(join(agyRoots.agy, 'conversations', `${SID}.db`), 'DB');
  mkdirSync(join(agyRoots.agy, 'brain'), { recursive: true });
  symlinkSync(outside, join(agyRoots.agy, 'brain', SID), 'junction');
  const c = sp.locateSessionFiles('claude', SID, roots).map(f => f.rel);
  assert.ok(!c.some(r => r.includes('secret')), JSON.stringify(c));
  assert.ok(c.includes(`projects/C--work-b/${SID}.jsonl`));
  const a = sp.locateSessionFiles('antigravity', SID, agyRoots).map(f => f.rel);
  assert.deepEqual(a, [`conversations/${SID}.db`]);
});

await test('建立存點:同時建立兩個(同一秒)也不會寫進同一個資料夾', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const [a, b] = await Promise.all([sp.createSavepoint(vault, node(), roots, NOW), sp.createSavepoint(vault, node(), roots, NOW)]);
  assert.equal(a.ok && b.ok, true);
  assert.notEqual(a.path, b.path);
  for (const r of [a, b]) assert.equal(sp.readSavepoint(vault, r.path).檔案.length, 2);
});

await test('建立存點:只找到附屬檔、沒有主檔時不建立', async () => {
  const home = tmp('home');
  const roots = sp.defaultSessionRoots({ NEXUS_SESSION_HOME: home });
  put(join(roots.agy, 'brain', SID, 'a.md'), 'x');
  const r = await sp.createSavepoint(tmp('vault'), node({ backend: 'antigravity', backendLabel: 'Antigravity' }), roots, NOW);
  assert.equal(r.ok, false);
  assert.equal(sp.isMainFile(`conversations/${SID}.db`, SID), true);
  assert.equal(sp.isMainFile(`conversations/${SID}.db-wal`, SID), false);
  assert.equal(sp.isMainFile(`projects/p/${SID}/subagents/a.jsonl`, SID), false);
});

await test('清理:超過時限的暫存資料夾會清掉,新的與正式存點不動', async () => {
  const vault = tmp('vault');
  const dir = join(vault, 'nodes', '封存', '_存點', 'n1');
  mkdirSync(join(dir, '.20261101-000000.tmp', 'files'), { recursive: true });
  mkdirSync(join(dir, '20261101-000000'), { recursive: true });
  const later = Date.now() + 2 * 60 * 60 * 1000;
  assert.equal(await sp.cleanStaleSavepointTemps(vault, 60 * 60 * 1000, Date.now()), 0, '還沒超過時限');
  assert.equal(await sp.cleanStaleSavepointTemps(vault, 60 * 60 * 1000, later), 1);
  assert.deepEqual(readdirSync(dir), ['20261101-000000']);
  assert.equal(await sp.cleanStaleSavepointTemps(tmp('empty')), 0, '沒有存點資料夾時不出錯');
});

await test('封存檔補欄位:保留 CRLF 與 BOM', () => {
  const vault = tmp('vault');
  const r = writeMemory(vault, 'nodes/封存/b.md', { 種類: 'node' }, '內容');
  const abs = join(vault, 'nodes', '封存', 'b.md');
  // 模擬主控台用 CRLF、BOM 寫的檔案(重新登記,視為主控台寫的)
  const crlf = '﻿' + readFileSync(abs, 'utf8').replace(/\n/g, '\r\n');
  writeFileSync(abs, crlf);
  writeMemory(vault, 'nodes/封存/c.md', { 種類: 'node' }, 'x');
  const reg = JSON.parse(readFileSync(join(vault, '.nexus-writes.json'), 'utf8'));
  const st = statSync(abs);
  reg[r.path] = { mtime: Math.floor(st.mtimeMs), size: st.size };
  writeFileSync(join(vault, '.nexus-writes.json'), JSON.stringify(reg));
  assert.equal(addFrontMatterField(vault, r.path, '存點', 'nodes/封存/_存點/n1/x'), true);
  const after = readFileSync(abs, 'utf8');
  assert.ok(after.startsWith('﻿---\r\n'));
  assert.match(after, /\r\n存點: nodes\/封存\/_存點\/n1\/x\r\n---\r\n/);
  assert.equal(parseFrontMatter(after).meta.get('存點'), 'nodes/封存/_存點/n1/x');
});

await test('記憶庫:存點裡的 .md(例如 Antigravity 的 brain)不會被索引,說明檔寫明 _存點 是未遮罩的原始對話', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const r = await sp.createSavepoint(vault, node({ backend: 'antigravity', backendLabel: 'Antigravity' }), roots, NOW);
  assert.equal(r.ok, true);
  assert.ok(existsSync(join(vault, ...r.path.split('/'), 'files', 'agy', 'brain', SID, 'notes', 'a.md')));
  const entries = new Map();
  const v = new MemoryVault(vault, { memoryAll: () => [...entries.values()], memoryPut: e => entries.set(e.path, e), memoryDelete: p => entries.delete(p) });
  v.rescan();
  assert.ok(![...entries.keys()].some(p => p.includes('_存點')), JSON.stringify([...entries.keys()]));
  assert.match(README, /nodes\/封存\/_存點\/ 是終止節點時封存的完整原始對話/);
  assert.match(README, /沒有遮罩/);
});

console.log(`session-savepoint:${passed} 項通過`);
