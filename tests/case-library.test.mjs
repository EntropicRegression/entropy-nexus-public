// 驗收:判例庫(長期記憶階段 3):候選偵測、案號配發、判例檔案內容、每日上限、提交權限、先例建議。
// 用法:在 app 資料夾執行 node tests/case-library.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CASE_DAILY_CAP, CASE_MIN_AGENT_MESSAGES, CASE_MIN_MINUTES, detectCandidate, notCandidateReason } from '../src/shared/case-candidates.ts';
import { formatCommentsPrompt } from '../src/shared/review.ts';
import { CASE_PROMPT_LEAD, CASE_SECTIONS, CaseService, PENDING_RETRY_MS, caseIdFromPath, formatCaseId, formatCasePrompt, nextCaseId, parseCaseId, parseSubmission, suggestPrecedents } from '../src/main/cases.ts';
import { safeName, writeMemory } from '../src/main/memory-write.ts';
import { MemoryVault, parseFrontMatter } from '../src/main/memory-vault.ts';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const MIN = 60000;
const mkTask = (over = {}) => ({
  id: over.id ?? 'aaaaaaaa-0000-4000-8000-000000000001', agentId: 'n1', agentName: 'Hagemi', backend: 'antigravity', model: 'gemini-x', title: '修好登入逾時',
  status: 'done', note: '', startedAt: 1_000_000, endedAt: 1_000_000 + 5 * MIN, steps: [], subs: [], source: 'desktop', project: { id: 'c:/work/demo', name: 'demo' },
  ...over,
});
const detect = (task, extra = {}) => detectCandidate({ task, agentMessages: 0, failures: 0, ...extra });

// ---- 候選偵測
test('候選:耗時超過 30 分鐘才算(剛好 30 分鐘不算)', () => {
  assert.equal(CASE_MIN_MINUTES, 30);
  assert.deepEqual(detect(mkTask({ endedAt: 1_000_000 + 30 * MIN })), []);
  const r = detect(mkTask({ endedAt: 1_000_000 + 31 * MIN }));
  assert.equal(r.length, 1);
  assert.match(r[0], /31 分鐘/);
});
test('候選:中途失敗後才成功、對話回合多', () => {
  assert.match(detect(mkTask(), { failures: 2 })[0], /失敗 2 次/);
  assert.deepEqual(detect(mkTask(), { agentMessages: CASE_MIN_AGENT_MESSAGES - 1 }), []);
  assert.match(detect(mkTask(), { agentMessages: CASE_MIN_AGENT_MESSAGES })[0], /15 則/);
});
test('候選:審查評論送回後修好(用真正的評論提示詞比對)', () => {
  const prompt = formatCommentsPrompt({ title: '原本的任務', comments: [{ path: null, row: null, side: null, line: null, text: '請補測試' }], files: [] });
  const r = detect(mkTask({ title: prompt.replace(/\s+/g, ' ').trim().slice(0, 200) }));
  assert.deepEqual(r, ['審查被打回後修好']);
});
test('候選:多個理由並列;沒有理由不是候選', () => {
  assert.equal(detect(mkTask({ endedAt: 1_000_000 + 40 * MIN }), { failures: 1, agentMessages: 20 }).length, 3);
  assert.deepEqual(detect(mkTask()), []);
});
test('候選:不是完成、判例請求本身、假資料自動運作、會議發言、已有判例都跳過', () => {
  const long = { endedAt: 1_000_000 + 99 * MIN };
  for (const status of ['failed', 'interrupted', 'running']) assert.deepEqual(detect(mkTask({ ...long, status }), { failures: 1 }), [], status);
  assert.deepEqual(detect(mkTask({ ...long, endedAt: null })), []);
  assert.deepEqual(detect(mkTask({ ...long, source: 'case' })), []);
  assert.deepEqual(detect(mkTask({ ...long, source: 'autopilot' })), []);
  assert.deepEqual(detect(mkTask({ ...long, source: 'archive' })), [], '刪除節點前的工作總結請求');
  assert.deepEqual(detect(mkTask({ ...long, source: 'interop', from: { id: 'x', name: 'X', meeting: true } })), [], '會議發言回合');
  assert.equal(detect(mkTask({ ...long, source: 'interop', from: { id: 'x', name: 'X' } })).length, 1, '一般的節點交辦照常偵測');
  assert.deepEqual(detect(mkTask({ ...long, title: '(主控台:這是一場由節點「A」召開的會議,不是使用者直接下的指令。' })), []);
  assert.deepEqual(detect(mkTask({ ...long, caseId: '2026-0001' })), []);
  assert.deepEqual(detect(mkTask({ ...long, casePending: true })), []);
  assert.equal(notCandidateReason(mkTask()), null);
  assert.equal(detect(mkTask({ ...long, source: 'remote' })).length, 1, '手機與節點互相呼叫的任務照常偵測');
});
test('候選:可以覆寫門檻', () => {
  assert.equal(detect(mkTask({ endedAt: 1_000_000 + 2 * MIN }), { minMinutes: 1 }).length, 1);
  assert.equal(detect(mkTask(), { agentMessages: 3, minMessages: 3 }).length, 1);
});

// ---- 案號
test('案號:格式、解析、流水號遞增、跨年重新開始', () => {
  assert.equal(formatCaseId(2026, 3), '2026-0003');
  assert.deepEqual(parseCaseId('2026-0003-某案由.md'), { year: 2026, n: 3 });
  assert.equal(parseCaseId('abc'), null);
  assert.equal(nextCaseId(2026, []), '2026-0001');
  assert.equal(nextCaseId(2026, ['2026-0001', '2026-0007', '2025-0099']), '2026-0008');
  assert.equal(nextCaseId(2026, ['2026-0002'], 5), '2026-0006', '計數器比已用的大時以計數器為準(刪過檔案也不重號)');
  assert.equal(nextCaseId(2027, ['2026-0008'], 0), '2027-0001', '跨年從 0001 開始');
  assert.equal(nextCaseId(2026, ['2026-12345']), '2026-12346', '超過四位數也能接下去');
  assert.equal(caseIdFromPath('cases/demo/2026-0003-某案由.md'), '2026-0003');
  assert.equal(caseIdFromPath('cases/demo/隨便.md'), '');
});

// ---- 服務
function setup(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-case-'));
  const vaultDir = join(dir, 'memory-vault');
  const idx = new Map();
  const vault = new MemoryVault(vaultDir, { memoryAll: () => [...idx.values()], memoryPut: e => idx.set(e.path, e), memoryDelete: p => idx.delete(p) });
  vault.init();
  const settings = new Map();
  const tasks = new Map();
  const agents = new Map([['n1', { id: 'n1', name: 'Hagemi', backend: 'antigravity', model: 'gemini-x', state: 'idle', parentId: null, terminal: false }],
    ['n2', { id: 'n2', name: 'Other', backend: 'claude', model: '', state: 'idle', parentId: null, terminal: false }]]);
  const requests = [];
  const factsOf = new Map();
  const files = new Map();
  const clock = { now: new Date(2026, 10, 21, 12, 0, 0) };
  const svc = new CaseService({
    vaultDir,
    getSetting: k => settings.get(k) ?? null,
    setSetting: (k, v) => settings.set(k, v),
    entries: () => vault.list(),
    rescan: () => vault.rescan(),
    task: id => tasks.get(id),
    agent: id => agents.get(id),
    changedFiles: async id => files.get(id) ?? [],
    facts: t => factsOf.get(t.id) ?? { agentMessages: 0, failures: 0 },
    request: (agentId, text) => { if (opts.requestThrows) throw new Error('佇列已滿'); requests.push({ agentId, text }); },
    patchTask: (id, patch) => { const t = tasks.get(id); if (!t) return; Object.assign(t, patch); if (patch.casePending === false) delete t.casePending; },
    detect: detectCandidate,
    write: writeMemory,
    safeName,
    backendLabel: b => ({ claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' })[b] ?? b,
    dailyCap: opts.dailyCap ?? CASE_DAILY_CAP,
    now: () => clock.now,
  });
  const add = (over = {}) => { const t = mkTask({ id: `task-${tasks.size + 1}`, ...over }); tasks.set(t.id, t); return t; };
  return { dir, vaultDir, vault, svc, tasks, agents, requests, settings, factsOf, files, clock, add };
}
const full = (id, extra = {}) => ({
  task_id: id, 案由: '登入逾時其實是時區造成', 關鍵字: ['登入', '逾時', '時區'], 事實經過: '登入一直逾時。', 爭點: '為什麼只在晚上發生。', 處理經過: '先調大逾時沒用。', 結論: '改用 UTC 計算。', 理由: '伺服器與用戶端時區不同。', 適用範圍: '所有用本機時間算期限的地方。', 參照先例: '無', ...extra,
});

test('自動請求:候選才請承辦節點寫,提示詞帶任務編號與固定格式', () => {
  const s = setup();
  const quick = s.add();
  assert.deepEqual(s.svc.onTaskEnded(quick), { requested: false, why: '不是候選' });
  assert.equal(s.requests.length, 0);
  const hard = s.add({ endedAt: 1_000_000 + 45 * MIN });
  const r = s.svc.onTaskEnded(hard);
  assert.equal(r.requested, true);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].agentId, 'n1');
  const text = s.requests[0].text;
  assert.ok(text.startsWith(CASE_PROMPT_LEAD));
  assert.ok(text.includes(`任務編號:${hard.id}`));
  for (const k of CASE_SECTIONS) assert.ok(text.includes(k), k);
  assert.ok(text.includes('case_submit'));
  assert.equal(hard.casePending, true);
  assert.equal(s.svc.autoCountToday(), 1);
});
test('自動請求:節點休眠、失聯、終端機模式或已不在面板上時不請求(也不計入上限)', () => {
  const s = setup();
  const t = s.add({ endedAt: 1_000_000 + 45 * MIN });
  for (const patch of [{ state: 'sleeping' }, { state: 'lost' }, { terminal: true }]) {
    Object.assign(s.agents.get('n1'), { state: 'idle', terminal: false }, patch);
    assert.equal(s.svc.onTaskEnded(t).requested, false, JSON.stringify(patch));
  }
  s.agents.delete('n1');
  assert.equal(s.svc.onTaskEnded(t).requested, false);
  assert.equal(s.requests.length, 0);
  assert.equal(s.svc.autoCountToday(), 0);
  // 忙碌中的節點照樣請求(排進它的佇列)
  s.agents.set('n1', { id: 'n1', name: 'Hagemi', backend: 'antigravity', model: '', state: 'working', parentId: null, terminal: false });
  assert.equal(s.svc.onTaskEnded(t).requested, true);
});
test('每日上限:自動撰寫一天最多 3 份,隔天重新計算;手動標記不受限也不計數', () => {
  const s = setup();
  const make = () => s.add({ endedAt: 1_000_000 + 45 * MIN });
  const [a, b, c, d] = [make(), make(), make(), make()];
  assert.equal(s.svc.onTaskEnded(a).requested, true);
  assert.equal(s.svc.onTaskEnded(b).requested, true);
  assert.equal(s.svc.onTaskEnded(c).requested, true);
  const r = s.svc.onTaskEnded(d);
  assert.equal(r.requested, false);
  assert.match(r.why, /上限/);
  assert.equal(s.requests.length, 3);
  assert.equal(d.casePending, undefined);
  // 手動標記:超過上限仍可以,而且不增加今天的自動份數
  assert.match(s.svc.mark(d.id), /已請「Hagemi」/);
  assert.equal(s.requests.length, 4);
  assert.equal(s.svc.autoCountToday(), 3);
  // 隔天又可以自動請求
  s.clock.now = new Date(2026, 10, 22, 9, 0, 0);
  assert.equal(s.svc.autoCountToday(), 0);
  assert.equal(s.svc.onTaskEnded(make()).requested, true);
  // 上限可以設定
  const z = setup({ dailyCap: 0 });
  assert.equal(z.svc.onTaskEnded(z.add({ endedAt: 1_000_000 + 45 * MIN })).requested, false);
});
test('手動標記:各種不能標的情形', () => {
  const s = setup();
  assert.throws(() => s.svc.mark('nope'), /找不到/);
  assert.throws(() => s.svc.mark(s.add({ endedAt: null, status: 'running' }).id), /還沒結束/);
  assert.throws(() => s.svc.mark(s.add({ source: 'case' }).id), /撰寫判例的請求/);
  assert.throws(() => s.svc.mark(s.add({ caseId: '2026-0001' }).id), /已經有判例 2026-0001/);
  const ok = s.add({ status: 'failed' });
  Object.assign(s.agents.get('n1'), { state: 'sleeping' });
  assert.throws(() => s.svc.mark(ok.id), /休眠/);
  Object.assign(s.agents.get('n1'), { state: 'idle' });
  s.svc.mark(ok.id);
  assert.throws(() => s.svc.mark(ok.id), /已經請承辦節點/);
  // 節點遲遲沒有提交,過了一段時間可以重新請它寫
  s.clock.now = new Date(s.clock.now.getTime() + PENDING_RETRY_MS + 1000);
  s.svc.mark(ok.id);
  assert.equal(s.requests.length, 2);
});
test('提交權限:只有任務自己的節點、而且必須是被請求過的、一個任務只能一份', async () => {
  const s = setup();
  const t = s.add({ endedAt: 1_000_000 + 45 * MIN });
  // 還沒有請求:不能提交
  await assert.rejects(s.svc.submit('n1', full(t.id)), /沒有請你/);
  s.svc.onTaskEnded(t);
  await assert.rejects(s.svc.submit('n2', full(t.id)), /只有承辦這個任務的節點/);
  await assert.rejects(s.svc.submit('n1', full('不存在的任務')), /找不到這個任務/);
  await assert.rejects(s.svc.submit('n1', { ...full(t.id), 案由: '' }), /缺少必要的欄位:案由/);
  assert.equal(t.caseId, undefined, '被拒絕的提交沒有留下判例');
  assert.deepEqual(readdirSync(join(s.vaultDir, 'cases')), []);
  const ok = await s.svc.submit('n1', full(t.id));
  assert.match(ok, /2026-0001/);
  assert.equal(t.caseId, '2026-0001');
  assert.equal(t.casePending, undefined);
  await assert.rejects(s.svc.submit('n1', full(t.id)), /已經有判例 2026-0001/);
  assert.equal(readdirSync(join(s.vaultDir, 'cases', 'demo')).length, 1);
});
test('判例檔案:路徑、屬性欄位、章節順序、客觀欄位由主控台填、機密遮罩、未確認', async () => {
  const s = setup();
  const t = s.add({ endedAt: 1_000_000 + 45 * MIN, changes: { git: true, base: 'a', end: 'b', files: 2, added: 3, removed: 1, committed: '4b91ec0' } });
  s.factsOf.set(t.id, { agentMessages: 4, failures: 2 });
  s.files.set(t.id, ['src/main/index.ts', 'tests/layout.sh']);
  s.svc.onTaskEnded(t);
  await s.svc.submit('n1', full(t.id, {
    處理經過: '試過 password: hunter2secret 沒用,也試過 sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456。\n# 不該變成一級標題\n## 也不該變成二級標題\n只有這行是正文。',
    // 節點想偷偷改客觀欄位:多給的參數一律忽略
    耗時分鐘: 1, 失敗次數: 0, 狀態: '已確認', 來源: '使用者標記',
  }));
  const rel = 'cases/demo/2026-0001-登入逾時其實是時區造成.md';
  assert.ok(existsSync(join(s.vaultDir, rel)), '一案一檔,檔名是案號加案由');
  const text = readFileSync(join(s.vaultDir, rel), 'utf8');
  const { meta, body } = parseFrontMatter(text);
  assert.equal(meta.get('案號'), '2026-0001');
  assert.equal(meta.get('案由'), '登入逾時其實是時區造成');
  assert.equal(meta.get('種類'), 'case');
  assert.equal(meta.get('範圍'), '專案');
  assert.equal(meta.get('專案ID'), 'c:/work/demo');
  assert.equal(meta.get('專案'), 'demo');
  assert.equal(meta.get('承辦節點'), 'Hagemi(Antigravity · gemini-x)');
  assert.equal(meta.get('節點ID'), 'n1');
  assert.equal(meta.get('任務'), t.id);
  assert.equal(meta.get('來源'), '自動偵測');
  assert.equal(meta.get('耗時分鐘'), '45');
  assert.equal(meta.get('失敗次數'), '2');
  assert.deepEqual(meta.get('改過的檔案'), ['src/main/index.ts', 'tests/layout.sh']);
  assert.equal(meta.get('commit'), '4b91ec0');
  assert.equal(meta.get('狀態'), '未確認');
  assert.deepEqual(meta.get('關鍵字'), ['登入', '逾時', '時區']);
  assert.match(String(meta.get('更新時間')), /^2026-11-21 12:00:00$/);
  assert.deepEqual([...meta.keys()], ['案號', '案由', '種類', '範圍', '專案ID', '專案', '承辦節點', '節點ID', '任務', '來源', '耗時分鐘', '失敗次數', '改過的檔案', 'commit', '狀態', '關鍵字', '更新時間']);
  // 本文:標題與章節順序固定
  assert.match(body, /^\s*# 解法第 2026-0001 號/);
  const heads = [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(heads, [...CASE_SECTIONS]);
  assert.equal([...body.matchAll(/^# /gm)].length, 1, '敘述裡的標題被降級,不會多出一級標題');
  // 遮罩(writeMemory)
  assert.ok(!text.includes('hunter2secret') && !text.includes('sk-ant-api03'), '機密已遮罩');
  assert.ok(text.includes('[已遮罩]'));
  // 索引立刻更新,而且是未確認(未確認的判例查不到)
  const e = s.vault.list().find(x => x.path === rel);
  assert.ok(e && e.kind === 'case' && e.status === '未確認' && e.projectId === 'c:/work/demo' && e.nodeId === 'n1', JSON.stringify(e));
  assert.deepEqual(suggestPrecedents('登入逾時', s.vault.list(), 'c:/work/demo'), []);
});
test('判例檔案:手動標記的來源、沒有專案的舊任務、沒有 commit 與改過的檔案', async () => {
  const s = setup();
  const t = s.add({ project: undefined });
  s.svc.mark(t.id);
  await s.svc.submit('n1', full(t.id, { 關鍵字: '登入, 逾時、時區' }));
  const rel = readdirSync(join(s.vaultDir, 'cases', '未分類專案'))[0];
  const { meta } = parseFrontMatter(readFileSync(join(s.vaultDir, 'cases', '未分類專案', rel), 'utf8'));
  assert.equal(meta.get('來源'), '使用者標記');
  assert.equal(meta.get('專案'), '未分類專案');
  assert.equal(meta.has('專案ID'), false);
  assert.equal(meta.has('commit'), false);
  assert.deepEqual(meta.get('關鍵字'), ['登入', '逾時', '時區']);
  assert.equal(meta.get('耗時分鐘'), '5');
});
test('案號:連續提交不重號、資料夾裡已有的案號不會被蓋、跨年重新編號', async () => {
  const s = setup();
  mkdirSync(join(s.vaultDir, 'cases', '別的專案'), { recursive: true });
  writeFileSync(join(s.vaultDir, 'cases', '別的專案', '2026-0007-舊案.md'), '---\n案號: 2026-0007\n---\n# 舊案\n');
  s.vault.rescan();
  const ids = [];
  const ts = [s.add(), s.add(), s.add()];
  for (const t of ts) s.svc.mark(t.id);
  // 同時提交也要得到不同的案號
  await Promise.all(ts.map(t => s.svc.submit('n1', full(t.id, { 案由: `案 ${t.id}` })).then(r => ids.push(/(\d{4}-\d{4})/.exec(r)[1]))));
  assert.deepEqual(ids.sort(), ['2026-0008', '2026-0009', '2026-0010']);
  // 刪掉最新的檔案後,計數器仍記得用過的號碼
  s.clock.now = new Date(2027, 0, 2, 8, 0, 0);
  const t2 = s.add();
  s.svc.mark(t2.id);
  assert.match(await s.svc.submit('n1', full(t2.id)), /2027-0001/);
});
test('提交內容檢查:章節上限、缺欄位的說明、參照先例預設「無」', () => {
  const p = parseSubmission({ 案由: '  很長的  案由 ', 事實經過: 'a', 結論: 'b', 理由: 'x'.repeat(20000) });
  assert.equal(p.title, '很長的 案由');
  assert.equal(p.sections['理由'].length, 8000);
  assert.equal(p.sections['參照先例'], '無');
  assert.throws(() => parseSubmission({}), /缺少必要的欄位:案由、事實經過、結論/);
});
test('先例建議:只列「已確認」的判例,同專案優先,沒有共同字詞的不列', () => {
  const e = (path, title, status, projectId = 'p1', updatedAt = 1) => ({ path, kind: 'case', scope: '專案', projectId, nodeId: '', title, updatedAt, mtime: 1, size: 1, status });
  const entries = [
    e('cases/a/2026-0001-登入逾時.md', '登入逾時的處理', '已確認', 'p2'),
    e('cases/a/2026-0002-登入逾時二.md', '登入逾時又出現', '已確認', 'p1'),
    e('cases/a/2026-0003-登入逾時三.md', '登入逾時第三次', '未確認', 'p1'),
    e('cases/a/2026-0004-登入逾時四.md', '登入逾時被退回', '退回', 'p1'),
    e('cases/a/2026-0005-無關.md', '字型顯示異常', '已確認', 'p1'),
    { ...e('knowledge/p1/note.md', '登入逾時的筆記', '已確認'), kind: 'knowledge' },
  ];
  const r = suggestPrecedents('修好登入逾時問題', entries, 'p1');
  assert.deepEqual(r.map(x => x.caseId), ['2026-0002', '2026-0001']);
  assert.deepEqual(suggestPrecedents('完全不相干 zzz', entries, 'p1'), []);
  assert.deepEqual(suggestPrecedents('Electron window resize', [e('cases/a/2026-0009-x.md', 'Electron window 調整大小', '已確認')], undefined).map(x => x.caseId), ['2026-0009']);
});
test('請求提示詞:附上相關的已確認先例;使用者標記的說法不同', async () => {
  const s = setup();
  mkdirSync(join(s.vaultDir, 'cases', 'demo'), { recursive: true });
  writeFileSync(join(s.vaultDir, 'cases', 'demo', '2026-0001-登入逾時的處理.md'), '---\n案由: 登入逾時的處理\n狀態: 已確認\n專案ID: c:/work/demo\n---\n# x\n');
  writeFileSync(join(s.vaultDir, 'cases', 'demo', '2026-0002-登入逾時的未確認案.md'), '---\n案由: 登入逾時的未確認案\n狀態: 未確認\n專案ID: c:/work/demo\n---\n# x\n');
  s.vault.rescan();
  const t = s.add({ endedAt: 1_000_000 + 45 * MIN });
  s.svc.onTaskEnded(t);
  const text = s.requests[0].text;
  assert.ok(text.includes('[[2026-0001]] 登入逾時的處理'));
  assert.ok(!text.includes('2026-0002'), '未確認的不建議');
  assert.match(text, /困難任務/);
  const manual = formatCasePrompt({ taskId: 'x', title: 't', reasons: [], source: '使用者標記', precedents: [] });
  assert.match(manual, /使用者要求/);
  assert.ok(!manual.includes('可能相關'));
});
test('請求排進佇列失敗(例如佇列已滿)時,不留下待撰寫的記錄', () => {
  const s = setup({ requestThrows: true });
  const t = s.add({ endedAt: 1_000_000 + 45 * MIN });
  assert.equal(s.svc.onTaskEnded(t).requested, false);
  assert.equal(t.casePending, undefined);
  assert.equal(s.svc.autoCountToday(), 0);
  assert.throws(() => s.svc.mark(s.add().id), /佇列已滿/);
});
test('假資料轉接器認得的請求開頭和主控台送出的一致', () => {
  const fake = readFileSync(new URL('../src/main/adapters/fake.ts', import.meta.url), 'utf8');
  assert.ok(fake.includes(CASE_PROMPT_LEAD), 'fake.ts 裡的比對字串要和 CASE_PROMPT_LEAD 相同');
  const iop = readFileSync(new URL('../src/main/interop.ts', import.meta.url), 'utf8');
  assert.ok(iop.includes('(主控台:這是一場由節點'), '會議提示詞的開頭沒變(候選偵測靠它跳過會議)');
});

for (const [name, fn] of tests) { await fn(); passed++; console.log('[ok]', name); }
console.log(`通過 ${passed} 項`);
