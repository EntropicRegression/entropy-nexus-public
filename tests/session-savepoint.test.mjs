// 驗收:節點 session 存點(src/main/session-savepoint.ts,docs/session存點規劃.md 里程碑 S1):
// 三家工具的檔案定位、建立存點(複製、存點.json、sha256、暫存資料夾改名、撞名加序號)、失敗不丟例外、
// 列出與讀回存點、封存檔補上「存點」欄位(addFrontMatterField)。全程用暫存的假 ~/.claude、~/.codex、~/.gemini。
// 用法:node --no-warnings tests/session-savepoint.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(String.raw`export async function resolve(s,c,n){if(/^\.\.?\//.test(s)&&!/\.\w+$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}`), import.meta.url);
const sp = await import('../src/main/session-savepoint.ts');
const { writeArchive } = await import('../src/main/memory-archive.ts');
const { addFrontMatterField, writeMemory } = await import('../src/main/memory-write.ts');
const { MemoryVault, parseFrontMatter, README } = await import('../src/main/memory-vault.ts');
const { buildVaultStats } = await import('../src/main/vault-stats.ts');
const { SAVEPOINT_RESTORE_SUPPORTED, wakeTargetOf } = await import('../src/main/wake.ts');
const { NEEDS_RESTORE, needsRestoreOf } = await import('../src/shared/types.ts');

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

// ---- S2:統計檔 ----

await test('主檔還在不在:三家各自的主檔,附屬檔不算', () => {
  const { roots } = fakeHome();
  assert.equal(sp.sessionMainExists('claude', SID, roots), true);
  assert.equal(sp.sessionMainExists('codex', CODEX, roots), true);
  assert.equal(sp.sessionMainExists('antigravity', SID, roots), true);
  assert.equal(sp.sessionMainExists('claude', 'aaaaaaaa-0000', roots), false);
  assert.equal(sp.sessionMainExists('claude', '../x', roots), false);
  const home = tmp('home');
  const r2 = sp.defaultSessionRoots({ NEXUS_SESSION_HOME: home });
  put(join(r2.agy, 'brain', SID, 'a.md'), 'x');
  assert.equal(sp.sessionMainExists('antigravity', SID, r2), false, '只有 brain 不算');
});

await test('存點摘要:讀說明檔,新的在前;格式不對或別的節點的不列', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const a = await sp.createSavepoint(vault, node(), roots, NOW);
  const b = await sp.createSavepoint(vault, node(), roots, new Date(NOW.getTime() + 60000));
  const broken = join(vault, 'nodes', '封存', '_存點', node().id, '20261101-000000');
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, '存點.json'), 'not json');
  const list = sp.savepointSummaries(vault, node().id);
  assert.deepEqual(list.map(s => s.path), [b.path, a.path]);
  assert.deepEqual({ ...list[1], time: '' }, { path: a.path, time: '', backend: 'claude', size: a.size, sessionId: SID });
  assert.deepEqual(sp.savepointSummaries(vault, 'other'), []);
});

await test('統計檔:存點清單、可還原、原檔還在,以及「可接回」改成點喚醒會有結果', () => {
  const sum = (o = {}) => ({ path: 'nodes/封存/_存點/r1/20261123-200509', time: '2026-11-23T20:05:09+08:00', backend: 'claude', size: 10, sessionId: 's-1', ...o });
  const sps = {
    r1: [sum({ path: 'nodes/封存/_存點/r1/b' }), sum({ path: 'nodes/封存/_存點/r1/a', sessionId: 's-old' })],
    r2: [sum({ path: 'nodes/封存/_存點/r2/a', sessionId: 's-2' })],
    live1: [sum({ path: 'nodes/封存/_存點/live1/a', sessionId: 's-live' })],
  };
  const files = new Set(['claude:s-2', 'claude:s-live']);
  const out = buildVaultStats({
    now: NOW.getTime(), portraitsDir: tmp('p'), archives: [], tasks: [], cases: [], dispatches: [], meetings: [], cliSessions: null,
    live: [{ id: 'live1', name: '在線', character: '', backend: 'claude', sessionId: 's-live', cwd: 'C:/w', state: 'idle' }],
    removed: [
      { id: 'r1', name: '原檔沒了有存點', character: '', backend: 'claude', sessionId: 's-1', cwd: 'C:/w' },
      { id: 'r2', name: '原檔還在', character: '', backend: 'claude', sessionId: 's-2', cwd: 'C:/w' },
      { id: 'r3', name: '原檔沒了沒存點', character: '', backend: 'claude', sessionId: 's-3', cwd: 'C:/w' },
      { id: 'r4', name: '目錄沒了', character: '', backend: 'claude', sessionId: 's-1', cwd: 'C:/gone' },
    ],
    dirExists: p => p !== 'C:/gone', images: () => ({ avatar: null, portrait: null }),
    savepoints: id => sps[id] ?? (id === 'r4' ? [sum({ path: 'nodes/封存/_存點/r4/a' })] : []),
    sessionFileExists: (b, s) => files.has(`${b}:${s}`),
  });
  const n = id => out.節點[id];
  assert.deepEqual(n('r1').存點, [
    { 路徑: 'nodes/封存/_存點/r1/b', 時間: '2026-11-23T20:05:09+08:00', 後台ID: 'claude', 大小: 10, 原檔還在: false, 可還原: true },
    { 路徑: 'nodes/封存/_存點/r1/a', 時間: '2026-11-23T20:05:09+08:00', 後台ID: 'claude', 大小: 10, 原檔還在: null, 可還原: false },
  ], '只有目前那段對話的存點可還原;舊 session 的存點原檔還在是 null');
  // S3 起支援從存點還原:原檔沒了但有可還原的存點也算可接回(和喚醒網址一致)
  assert.equal(SAVEPOINT_RESTORE_SUPPORTED, true);
  assert.equal(n('r1').session.可接回, true, '原檔沒了、可以從存點還原');
  assert.equal(n('r2').session.可接回, true, '原檔還在');
  assert.equal(n('r2').存點[0].原檔還在, true);
  assert.equal(n('r3').session.可接回, false, '原檔沒了也沒有存點');
  assert.deepEqual(n('r3').存點, []);
  assert.equal(n('r4').session.可接回, false, '工作目錄不在');
  assert.equal(n('r4').存點[0].可還原, false);
  assert.equal(n('live1').存點[0].可還原, false, '在面板上的節點不還原');
  assert.equal(n('live1').session.可接回, false);
  assert.ok(!JSON.stringify(out).includes('工作目錄":"C:/w"'), '存點清單不帶工作目錄');
});

await test('統計檔:沒提供存點與檔案檢查時沿用舊判斷,存點是空清單', () => {
  const out = buildVaultStats({
    now: NOW.getTime(), portraitsDir: tmp('p'), archives: [], tasks: [], cases: [], dispatches: [], meetings: [], cliSessions: null, live: [],
    removed: [{ id: 'r1', name: 'x', character: '', backend: 'claude', sessionId: 's-1', cwd: 'C:/w' }],
    dirExists: () => true, images: () => ({ avatar: null, portrait: null }),
  });
  assert.deepEqual(out.節點.r1.存點, []);
  assert.equal(out.節點.r1.session.可接回, true);
});

await test('統計檔與喚醒網址:可接回與喚醒結果一致(有檔案檢查與存點時)', () => {
  const removed = [
    { id: 'ok', name: '原檔還在', character: '', backend: 'claude', sessionId: 's-ok', cwd: 'C:/w', model: '' },
    { id: 'gone', name: '原檔沒了有存點', character: '', backend: 'claude', sessionId: 's-gone', cwd: 'C:/w', model: '' },
    { id: 'none', name: '原檔沒了沒存點', character: '', backend: 'codex', sessionId: 's-none', cwd: 'C:/w', model: '' },
  ];
  const files = new Set(['claude:s-ok']);
  const fileOk = (b, s) => files.has(`${b}:${s}`);
  const sps = { gone: [{ path: 'p', time: 't', backend: 'claude', size: 1, sessionId: 's-gone' }] };
  const out = buildVaultStats({
    now: NOW.getTime(), portraitsDir: tmp('p'), archives: [], tasks: [], cases: [], dispatches: [], meetings: [], cliSessions: null, live: [], removed,
    dirExists: () => true, images: () => ({ avatar: null, portrait: null }), savepoints: id => sps[id] ?? [], sessionFileExists: fileOk,
  });
  for (const r of removed) {
    const t = wakeTargetOf(r.id, [], removed, () => true, fileOk, id => (sps[id] ?? []).length > 0);
    assert.equal(out.節點[r.id].session.可接回, t?.kind === 'removed', r.id);
  }
  assert.match(wakeTargetOf('none', [], removed, () => true, fileOk).reason, /清除/);
  assert.equal(wakeTargetOf('ok', [], removed, () => true).kind, 'removed', '沒提供檔案檢查時沿用舊判斷');
});

await test('索引:每家掃一次,判斷和 sessionMainExists 相同(含 Codex 的時間前綴與 archived_sessions)', () => {
  const { roots } = fakeHome();
  put(join(roots.codex, 'archived_sessions', 'rollout-2026-01-01T00-00-00-019aaaaa-0000-7000-8000-000000000001.jsonl'), 'x');
  const cl = sp.sessionIndex('claude', roots);
  const cx = sp.sessionIndex('codex', roots);
  const ag = sp.sessionIndex('antigravity', roots);
  assert.ok(cl.has(SID) && cl.has(OTHER));
  assert.ok(!cl.has('agent-1'), '子代理資料夾裡的檔案不算');
  assert.ok(cx.has(CODEX) && cx.has('019aaaaa-0000-7000-8000-000000000001'), 'sessions 與 archived_sessions 都收');
  assert.ok(ag.has(SID) && !ag.has(`${SID}.db-wal`));
  for (const [b, id] of [['claude', SID], ['codex', CODEX], ['antigravity', SID], ['claude', 'aaaaaaaa-0000'], ['codex', 'abcdefgh']]) {
    assert.equal(sp.sessionIndex(b, roots).has(id.toLowerCase()), sp.sessionMainExists(b, id, roots), `${b}:${id}`);
  }
  assert.equal(sp.sessionIndex('claude', sp.defaultSessionRoots({ NEXUS_SESSION_HOME: tmp('empty') })).size, 0, '工具資料夾不存在時是空集合');
});

await test('存點摘要:說明檔的節點ID、後台ID、sessionId 不對時不列', async () => {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const a = await sp.createSavepoint(vault, node(), roots, NOW);
  const file = join(vault, ...a.path.split('/'), '存點.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  for (const bad of [{ 節點ID: 'other' }, { 後台ID: 'gemini' }, { sessionId: '../x' }]) {
    writeFileSync(file, JSON.stringify({ ...m, ...bad }));
    assert.deepEqual(sp.savepointSummaries(vault, node().id), [], JSON.stringify(bad));
  }
  writeFileSync(file, JSON.stringify({ ...m, 總大小: 'x' }));
  assert.equal(sp.savepointSummaries(vault, node().id)[0].size, 0, '大小不是數字時是 0');
});

// ---- S3:還原 ----

/** 建一個存點,再把原檔刪掉(模擬工具清掉對話)。 */
async function savedThenGone(backend = 'claude') {
  const { roots } = fakeHome();
  const vault = tmp('vault');
  const n = backend === 'claude' ? node() : backend === 'codex' ? node({ backend, backendLabel: 'Codex', sessionId: CODEX }) : node({ backend, backendLabel: 'Antigravity' });
  const r = await sp.createSavepoint(vault, n, roots, NOW);
  assert.equal(r.ok, true);
  for (const f of sp.locateSessionFiles(backend, n.sessionId, roots)) rmSync(join(roots[f.root], ...f.rel.split('/')), { force: true });
  assert.equal(sp.sessionMainExists(backend, n.sessionId, roots), false);
  return { roots, vault, r, n };
}

await test('還原:三家都放回原位、內容相同,Claude 的修改時間設成現在', async () => {
  for (const backend of ['claude', 'codex', 'antigravity']) {
    const { roots, vault, r, n } = await savedThenGone(backend);
    const later = new Date(2026, 11, 31, 12, 0, 0);
    const res = await sp.restoreSavepoint(vault, r.path, roots, later);
    assert.equal(res.ok, true, `${backend}:${res.reason}`);
    assert.equal(sp.sessionMainExists(backend, n.sessionId, roots), true, backend);
    const m = sp.readSavepoint(vault, r.path);
    assert.equal(res.restored, m.檔案.length, backend);
    for (const f of m.檔案) {
      const dst = join(roots[f.根目錄], ...f.位置.split('/'));
      assert.equal(await sp.sha256File(dst), f.sha256, f.位置);
      if (backend === 'claude') assert.equal(statSync(dst).mtime.getTime(), later.getTime(), '修改時間是還原當下');
      assert.equal(existsSync(`${dst}.nexus-restore.tmp`), false);
    }
  }
});

await test('還原:不覆蓋已經存在的檔案', async () => {
  const { roots, vault, r } = await savedThenGone('claude');
  const main = join(roots.claude, 'projects', 'C--work-a', `${SID}.jsonl`);
  writeFileSync(main, 'NEWER');
  const res = await sp.restoreSavepoint(vault, r.path, roots, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.kept, 1);
  assert.equal(readFileSync(main, 'utf8'), 'NEWER');
});

await test('還原:存點損壞時什麼都不寫', async () => {
  const { roots, vault, r } = await savedThenGone('claude');
  const copied = join(vault, ...r.path.split('/'), 'files', 'claude', 'projects', 'C--work-a', `${SID}.jsonl`);
  writeFileSync(copied, '{"a":2}\n');
  const res = await sp.restoreSavepoint(vault, r.path, roots, NOW);
  assert.equal(res.ok, false);
  assert.match(res.reason, /損壞/);
  assert.equal(existsSync(join(roots.claude, 'projects', 'C--work-a', SID, 'subagents', 'agent-1.jsonl')), false, '子代理紀錄也沒有寫回');
  assert.equal(sp.sessionMainExists('claude', SID, roots), false);
});

await test('還原:說明檔被改成寫到別處時拒絕(..、絕對路徑、別家資料夾、不含 id、別的根目錄)', async () => {
  const { roots, vault, r } = await savedThenGone('claude');
  const file = join(vault, ...r.path.split('/'), '存點.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  const main = m.檔案.find(f => f.位置.endsWith(`${SID}.jsonl`));
  const bad = [
    { 位置: `projects/../../evil/${SID}.jsonl` }, { 位置: `C:/evil/${SID}.jsonl` }, { 位置: `/evil/${SID}.jsonl` },
    { 位置: `settings/${SID}.jsonl` }, { 位置: 'projects/C--work-a/other.jsonl' }, { 根目錄: 'codex' }, { 位置: `projects\\x\\${SID}.jsonl` },
    { 位置: `projects/C--work-a/memory/x-${SID}.md` }, { 位置: `projects/C--work-a/${SID}.jsonl:ads` }, { 位置: `projects/CON/${SID}.jsonl` },
    { 位置: `projects/C--work-a./${SID}.jsonl` }, { 位置: `projects/a/b/${SID}.jsonl` },
  ];
  for (const b of bad) {
    // 存點的 files/ 底下真的放好對應的來源檔,確定是被「位置」檢查擋下,而不是缺檔
    writeFileSync(file, JSON.stringify({ ...m, 檔案: [{ ...main, ...b }] }));
    const res = await sp.restoreSavepoint(vault, r.path, roots, NOW);
    assert.equal(res.ok, false, JSON.stringify(b));
    assert.match(res.reason, /不能還原的檔案位置/, JSON.stringify(b));
  }
  assert.equal((await sp.restoreSavepoint(vault, 'nodes/other/x', roots, NOW)).ok, false, '存點路徑不在 _存點 底下');
  assert.equal((await sp.restoreSavepoint(vault, `${r.path}/../..`, roots, NOW)).ok, false);
});

await test('還原:主檔最後放回;附屬檔失敗時主檔不放,下次還能再還原', async () => {
  const { roots, vault, r } = await savedThenGone('claude');
  // 子代理資料夾的位置被一個檔案佔住:附屬檔放不回去
  const dirPath = join(roots.claude, 'projects', 'C--work-a', SID);
  rmSync(dirPath, { recursive: true, force: true });
  writeFileSync(dirPath, 'blocker');
  const res = await sp.restoreSavepoint(vault, r.path, roots, NOW);
  assert.equal(res.ok, false);
  assert.equal(sp.sessionMainExists('claude', SID, roots), false, '主檔沒有放回,所以下次接回仍會詢問還原');
  assert.ok(!readdirSync(join(roots.claude, 'projects', 'C--work-a')).some(n => n.includes('nexus-restore')), '沒有留下暫存檔');
  rmSync(dirPath, { force: true });
  assert.equal((await sp.restoreSavepoint(vault, r.path, roots, NOW)).ok, true, '排除問題後可以再還原');
});

await test('還原:目的路徑經過 junction 時拒絕;存在檢查會跟隨 junction', async () => {
  const { roots, vault, r } = await savedThenGone('claude');
  const proj = join(roots.claude, 'projects', 'C--work-a');
  const moved = join(tmp('moved'), 'C--work-a');
  mkdirSync(moved, { recursive: true });
  rmSync(proj, { recursive: true, force: true });
  symlinkSync(moved, proj, 'junction');
  const res = await sp.restoreSavepoint(vault, r.path, roots, NOW);
  assert.equal(res.ok, false);
  assert.match(res.reason, /連結/);
  assert.deepEqual(readdirSync(moved), [], '沒有穿過 junction 寫入');
  // 使用者把專案資料夾搬到別處用 junction 接回:對話照樣算在(不會被誤判成已清除)
  writeFileSync(join(moved, `${SID}.jsonl`), 'x');
  assert.equal(sp.sessionMainExists('claude', SID, roots), true);
  assert.ok(sp.sessionIndex('claude', roots).has(SID));
});

await test('還原:Antigravity 主檔不在但舊的 -wal 還在時不還原', async () => {
  const { roots, vault, r } = await savedThenGone('antigravity');
  writeFileSync(join(roots.agy, 'conversations', `${SID}.db-wal`), 'stale');
  const res = await sp.restoreSavepoint(vault, r.path, roots, NOW);
  assert.equal(res.ok, false);
  assert.match(res.reason, /-wal/);
  assert.equal(existsSync(join(roots.agy, 'conversations', `${SID}.db`)), false);
});

await test('還原:兩個同時還原不會寫壞檔案', async () => {
  const { roots, vault, r } = await savedThenGone('codex');
  const [a, b] = await Promise.all([sp.restoreSavepoint(vault, r.path, roots, NOW), sp.restoreSavepoint(vault, r.path, roots, NOW)]);
  assert.equal(a.ok && b.ok, true, `${a.reason ?? ''} ${b.reason ?? ''}`);
  const m = sp.readSavepoint(vault, r.path);
  assert.equal(a.restored + b.restored, m.檔案.length, '每個檔案只放回一次');
  for (const f of m.檔案) assert.equal(await sp.sha256File(join(roots.codex, ...f.位置.split('/'))), f.sha256);
});

await test('還原的詢問:NEEDS_RESTORE 錯誤訊息讀得回資料,其他錯誤是 null', () => {
  const msg = `Error invoking remote method 'x': Error: ${NEEDS_RESTORE}${JSON.stringify({ 時間: '2026-11-23T20:05:09+08:00', 大小: 5, 後台: 'Claude Code' })}`;
  assert.deepEqual(needsRestoreOf(msg), { 時間: '2026-11-23T20:05:09+08:00', 大小: 5, 後台: 'Claude Code' });
  assert.equal(needsRestoreOf('一般錯誤'), null);
  assert.equal(needsRestoreOf(`${NEEDS_RESTORE}not json`), null);
});

console.log(`session-savepoint:${passed} 項通過`);
