// 驗收:回憶錄(記憶設計第六輪):memory_draft 的 kind memoir——格式驗證(固定章節、涵蓋期間)、身分欄位由主控台填(節點填的被忽略)、
// 路徑與同名序號、可見性(未確認查不到、直接讀也不行)、每日上限、memory_write 拒絕、遮罩(金鑰、本機路徑)、檔頭讀回(parseFrontMatter 與 js-yaml)。
// 用法:node --no-warnings tests/memoir.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(String.raw`export async function resolve(s,c,n){if(/^\.\.?\//.test(s)&&!/\.\w+$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}`), import.meta.url);
const { DraftService, isMemoirKind } = await import('../src/main/memory-draft.ts');
const { MEMOIR_DAILY_CAP, buildMemoir, checkSections, cleanTitle, formatMemoirPrompt, isDraftRequest, isMemoirPrompt, isMemoirRequest, missingSections, normalizeSectionHeadings, parseMemoir, parsePeriod, waitForMemoir, writeMemoir } = await import('../src/main/memoir.ts');
const { entryFromFile, parseFrontMatter, README, readmeUpdate, VAULT_DIRS } = await import('../src/main/memory-vault.ts');
const { memoryRead, memorySearch, memoryWrite, searchMemory, statusVisible } = await import('../src/main/memory-tools.ts');
const { safeName, writeMemory } = await import('../src/main/memory-write.ts');
const { DRAFT_PROMPT_LEAD, MEMOIR_PROMPT_LEAD, accumulatedChars } = await import('../src/shared/memory-draft.ts');
let yaml;
try { yaml = (await import('js-yaml')).default; } catch (e) { throw new Error(`測試需要 js-yaml(node_modules 裡的間接相依,不是直接相依):${e.message}`); }

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
/** 這支測試建立的暫存資料夾,結束時刪掉。 */
const made = [];
const tmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
const errOf = async p => { try { await p; return ''; } catch (e) { return String(e.message); } };

const BODY = '這段期間我幫使用者整理部署流程。\n\n## 來源\n\n這個 session 的對話。\n\n## 不確定之處\n\n無';

const mkSvc = (over = {}) => {
  const vaultDir = tmp('nexus-memoir-');
  const settings = new Map();
  const requests = [];
  const agents = new Map([
    ['node-orion-0001', { id: 'node-orion-0001', name: '獵戶', backend: 'claude', model: 'sonnet', state: 'idle', terminal: false, parentId: null }],
    ['node-vega-0002', { id: 'node-vega-0002', name: '織女', backend: 'codex', model: '', state: 'idle', terminal: false, parentId: null }],
    ['sub-1', { id: 'sub-1', name: '子代理', backend: 'claude', model: '', state: 'idle', terminal: false, parentId: 'node-orion-0001' }],
  ]);
  const clock = { now: new Date(2026, 10, 23, 14, 5, 6) };
  const history = [{ type: 'message', seq: 1, role: 'user', text: '你好', ts: new Date(2026, 10, 16, 9).getTime() }, { type: 'message', seq: 2, role: 'agent', text: '好', ts: new Date(2026, 10, 17, 18).getTime() }];
  const svc = new DraftService({
    vaultDir,
    getSetting: k => settings.get(k) ?? null,
    setSetting: (k, v) => settings.set(k, v),
    history: id => (id === 'node-orion-0001' ? history : []),
    agent: id => agents.get(id),
    project: async () => ({ id: 'c:/work/demo', name: 'demo' }),
    request: (agentId, text) => requests.push({ agentId, text }),
    rescan: () => {},
    write: writeMemory,
    safeName,
    backendLabel: b => ({ claude: 'Claude Code', codex: 'Codex' })[b] ?? b,
    threshold: 100,
    now: () => clock.now,
    ...over,
  });
  return { vaultDir, svc, settings, requests, agents, clock };
};
const ORION = 'node-orion-0001';
const memoirFiles = dir => {
  const out = [];
  const walk = rel => { for (const f of readdirSync(join(dir, rel), { withFileTypes: true })) { const r = `${rel}/${f.name}`; if (f.isDirectory()) walk(r); else if (f.name.endsWith('.md')) out.push(r); } };
  if (existsSync(join(dir, 'memoirs'))) walk('memoirs');
  return out.sort();
};

// ---- 格式驗證(純函式)
test('parsePeriod:區間與單日都收;格式不對、日期不存在、起日晚於迄日都拒收', () => {
  assert.equal(parsePeriod('2026-11-16/2026-11-17'), '2026-11-16/2026-11-17');
  assert.equal(parsePeriod(' 2026-11-16 / 2026-11-17 '), '2026-11-16/2026-11-17');
  assert.equal(parsePeriod('2026-11-16'), '2026-11-16');
  assert.equal(parsePeriod('2026-11-16/2026-11-16'), '2026-11-16/2026-11-16');
  assert.equal(parsePeriod('2024-02-29'), '2024-02-29');
  assert.throws(() => parsePeriod(''), /需要 period/);
  assert.throws(() => parsePeriod('2026/11/16'), /格式不對/);
  assert.throws(() => parsePeriod('2026-11-16~2026-11-17'), /格式不對/);
  assert.throws(() => parsePeriod('上週'), /格式不對/);
  assert.throws(() => parsePeriod('2026-02-30'), /不存在的日期/);
  assert.throws(() => parsePeriod('2026-13-01'), /不存在的日期/);
  assert.throws(() => parsePeriod('2026-11-16/2026-11-31'), /不存在的日期/);
  assert.throws(() => parsePeriod('2026-11-18/2026-11-16'), /起日晚於迄日/);
});

test('missingSections:兩個固定章節都要有(內容可以是「無」),程式碼區塊裡的 ## 不算', () => {
  assert.deepEqual(missingSections(BODY), []);
  assert.deepEqual(missingSections('正文\n\n## 來源\n\n無'), ['不確定之處']);
  assert.deepEqual(missingSections('正文'), ['來源', '不確定之處']);
  assert.deepEqual(missingSections('正文\n\n```\n## 來源\n## 不確定之處\n```\n'), ['來源', '不確定之處']);
  assert.deepEqual(missingSections('### 來源\n\n#來源\n\n## 不確定之處\n無'), ['來源']);
});

test('parseMemoir:缺章節、缺期間、缺標題都拒收,錯誤訊息請節點補上重寫;正文太長拒收', () => {
  assert.throws(() => parseMemoir({ title: 't', period: '2026-11-16', content: '正文\n\n## 來源\n\n無' }), /缺少固定章節:「## 不確定之處」.*補上後重寫/);
  assert.throws(() => parseMemoir({ title: 't', period: '2026-11-16', content: '正文' }), /「## 來源」、「## 不確定之處」/);
  assert.throws(() => parseMemoir({ title: 't', content: BODY }), /需要 period/);
  assert.throws(() => parseMemoir({ period: '2026-11-16', content: BODY }), /title/);
  assert.throws(() => parseMemoir({ title: 't', period: '2026-11-16', content: BODY + 'x'.repeat(12001) }), /超過上限/);
  const ok = parseMemoir({ title: '  第一章\n 部署  ', period: '2026-11-16/2026-11-17', content: BODY, 節點ID: 'x' });
  assert.deepEqual(ok, { title: '第一章 部署', period: '2026-11-16/2026-11-17', content: BODY });
});

test('isMemoirKind:memoir、回憶錄(大小寫、空白不拘)', () => {
  for (const k of ['memoir', 'Memoir', ' MEMOIR ', '回憶錄']) assert.equal(isMemoirKind(k), true, k);
  for (const k of ['knowledge', 'preference', '', undefined, 'memoirs']) assert.equal(isMemoirKind(k), false, String(k));
});

test('checkSections:標題寫法(結尾 #、前置 1-3 個空白、冒號、粗體)都認;4 個空白不是標題', () => {
  const ok = body => assert.deepEqual(checkSections(body), { missing: [], empty: [] }, body);
  const miss = (body, missing) => assert.deepEqual(checkSections(body).missing, missing, body);
  ok('正文\n## 來源 ##\n無\n## 不確定之處 #####\n無');
  ok('正文\n   ## 來源\n無\n ## 不確定之處\n無');
  miss('正文\n    ## 來源\n無\n## 不確定之處\n無', ['來源']);
  ok('## 來源:\n無\n## 不確定之處：\n無');
  ok('## **來源**\n無\n## __不確定之處__:\n無');
  ok('## **來源:**\n無\n## **不確定之處**：\n無');
  miss('##來源\n無\n## 不確定之處\n無', ['來源']);
});

test('checkSections:程式碼圍欄依 CommonMark 配對,HTML 註解裡的不算', () => {
  const miss = (body, missing) => assert.deepEqual(checkSections(body).missing, missing, body);
  // ``` 不能由 ~~~ 關閉,所以後面的 ## 都還在圍欄裡
  miss('正文\n```\n~~~\n## 來源\n## 不確定之處\n```\n', ['來源', '不確定之處']);
  miss('正文\n~~~\n```\n## 來源\n~~~\n## 不確定之處\n無', ['來源']);
  // 關閉的圍欄要至少一樣長
  miss('````\n```\n## 來源\n````\n## 不確定之處\n無', ['來源']);
  assert.deepEqual(checkSections('```js\n## 假的\n```\n## 來源\n無\n## 不確定之處\n無'), { missing: [], empty: [] });
  // 反引號圍欄的資訊字串含反引號就不是圍欄
  assert.deepEqual(checkSections('``` a`b\n## 來源\n無\n## 不確定之處\n無'), { missing: [], empty: [] });
  // HTML 註解(單行、跨行)
  miss('正文 <!-- ## 來源 -->\n<!--\n## 不確定之處\n-->\n', ['來源', '不確定之處']);
  miss('<!-- 註解 -->\n## 來源\n無\n<!--\n## 不確定之處\n無\n-->', ['不確定之處']);
});

test('checkSections:章節內容不能是空的(可以寫「無」);只有註解或空白也算空;三級標題與程式碼算內容', () => {
  assert.deepEqual(checkSections('## 來源\n\n## 不確定之處\n無').empty, ['來源']);
  assert.deepEqual(checkSections('## 來源\n無\n## 不確定之處\n   \n').empty, ['不確定之處']);
  assert.deepEqual(checkSections('## 來源\n<!-- 之後補 -->\n## 不確定之處\n無').empty, ['來源']);
  assert.deepEqual(checkSections('## 來源\n# 一級標題\n無\n## 不確定之處\n無').empty, ['來源'], '一級標題結束章節');
  assert.deepEqual(checkSections('## 來源\n### 對話\n## 不確定之處\n```\n不確定\n```').empty, []);
  assert.deepEqual(checkSections('## 來源\n\n## 來源\n對話\n## 不確定之處\n無').empty, [], '同名章節內容合起來算');
  assert.throws(() => parseMemoir({ title: 't', period: '2026-11-16', content: '正文\n\n## 來源\n\n## 不確定之處\n\n無' }), /「## 來源」沒有內容.*寫「無」/);
});

test('cleanTitle 與檔名:去掉不可見字元(零寬、U+202E 等)、依字元截斷不切開代理對', () => {
  assert.equal(cleanTitle('a​b‮c﻿d⁠'), 'abcd');
  const emoji = '\u{1F600}'.repeat(90);
  const t = cleanTitle(emoji);
  assert.equal(Array.from(t).length, 80);
  assert.ok(!/[\uD800-\uDBFF]$/.test(t) && !/^[\uDC00-\uDFFF]/.test(t));
  assert.equal(parseMemoir({ title: '第‍一‮章', period: '2026-11-16', content: BODY }).title, '第一章');
  // safeName 依 UTF-16 長度截在 60:剛好切在 emoji 中間時,檔名不留半個代理對
  const r = buildMemoir({ title: 'x'.repeat(59) + '\u{1F600}尾', content: BODY, period: '2026-11-16', nodeId: 'node-orion-0001', nodeName: '獵​戶', backendLabel: 'Claude Code', now: new Date(2026, 10, 23, 9) });
  assert.ok(!/[\uD800-\uDBFF]$/.test(r.baseName), JSON.stringify(r.baseName));
  assert.ok(!/[\uD800-\uDFFF]/.test(r.baseName.replace(/\u{1F600}/gu, '')), '沒有落單的代理對');
  assert.equal(r.dir, 'memoirs/獵戶-node-ori');
  assert.equal(r.meta['節點'], '獵戶');
  assert.equal(buildMemoir({ title: '​‮', content: BODY, period: '2026-11-16', nodeId: 'n', nodeName: 'n', backendLabel: 'x', now: new Date(2026, 10, 23) }).baseName, '2026-11-23-未命名');
});

test('isMemoirPrompt:認得回憶錄請求,不會把「儲存這段記憶」的草稿請求當成回憶錄', () => {
  assert.equal(isMemoirPrompt(formatMemoirPrompt({ nodeName: '獵戶', today: '2026-11-23' })), true);
  assert.equal(isMemoirPrompt(`${MEMOIR_PROMPT_LEAD}這不是使用者的新指令`), true);
  assert.equal(isMemoirPrompt(`${DRAFT_PROMPT_LEAD}這不是使用者的新指令`), false);
  assert.equal(isMemoirPrompt('請幫我寫回憶錄'), false);
});

/** 主控台自己送的請求(DraftService 用 enqueue(…, 'draft') 排入,沒有交辦者)。 */
const CONSOLE = { source: 'draft' };
/** 別的節點用 ask_node、會議、協作流程送來的(都帶交辦者 from)。 */
const OTHERS = [
  ['ask_node', { source: 'interop', from: { id: 'node-vega-0002', name: '織女' } }],
  ['會議', { source: 'interop', from: { id: 'node-vega-0002', name: '織女', meeting: true } }],
  ['協作流程', { source: 'flow', from: { id: 'flow', name: '流程', flow: { runId: 'r1', stepId: 's1' } } }],
  ['帶交辦者但來源寫成 draft', { source: 'draft', from: { id: 'node-vega-0002', name: '織女' } }],
  ['使用者從桌面打的字', { source: 'desktop' }],
  ['舊資料沒有來源', {}],
];

test('isMemoirRequest / isDraftRequest:要提示開頭對、而且來源是主控台自己送的(source draft、沒有 from);ask_node、會議、流程送來的不算', () => {
  const memoirText = formatMemoirPrompt({ nodeName: '獵戶', today: '2026-11-23' });
  const draftText = `${DRAFT_PROMPT_LEAD}這不是使用者的新指令`;
  assert.equal(isMemoirRequest(memoirText, CONSOLE), true);
  assert.equal(isDraftRequest(draftText, CONSOLE), true);
  assert.equal(isMemoirRequest(draftText, CONSOLE), false);
  assert.equal(isDraftRequest(memoirText, CONSOLE), false);
  assert.equal(isMemoirRequest('請幫我寫回憶錄', CONSOLE), false);
  for (const [name, origin] of OTHERS) {
    assert.equal(isMemoirRequest(memoirText, origin), false, name);
    assert.equal(isDraftRequest(draftText, origin), false, name);
  }
  assert.equal(isMemoirRequest(memoirText, null), false);
});

test('假造的回憶錄回合:別的節點用 ask_node、會議、流程送來以回憶錄請求開頭的文字,回合結束不會被當成回憶錄回合(請求不受影響)', async () => {
  const live = { active: true };
  const s = mkSvc({ memoirActive: () => live.active });
  await s.svc.requestMemoir(ORION);
  live.active = false;
  const fake = `${MEMOIR_PROMPT_LEAD}這不是使用者的新指令`;
  for (const [name, origin] of OTHERS) {
    s.svc.turnEnded(ORION, fake, origin);
    assert.ok(s.svc.hasPendingMemoir(ORION), `${name} 的回合結束不清請求`);
  }
  // 主控台自己送的回憶錄回合結束才清
  s.svc.turnEnded(ORION, fake, CONSOLE);
  assert.ok(!s.svc.hasPendingMemoir(ORION));
});

// ---- 刪除節點前的等待(Core.askForMemoir 用的 waitForMemoir)
/** 假的節點:queue 是佇列裡的提示 id,running 是回憶錄回合在跑,ended 是回合結束的時間;steps 依時間推進狀態。 */
/** 節點提交成功:請求用掉、記下提交時間。 */
const submitted = s => { s.pending = false; s.submittedAt = s.t; };
/** 回合結束(沒有提交時,主控台的 turnEnded 會清掉請求)。 */
const endTurn = s => { s.running = false; s.ended.push(s.t); };
const mkWait = (init = {}, steps = []) => {
  const st = { pending: false, submittedAt: 0, queue: null, running: false, ended: [], requests: 0, cancels: 0, cancelledQueued: [], interrupts: 0, t: 1000, requestError: null, stopOnInterrupt: false, ...init };
  const deps = {
    pending: () => st.pending,
    submittedAt: () => st.submittedAt,
    queuedId: () => st.queue,
    running: () => st.running,
    endedSince: since => st.ended.some(e => e >= since),
    request: async () => { if (st.requestError) throw new Error(st.requestError); st.requests++; st.pending = true; st.queue = 'q-new'; },
    cancel: () => { st.cancels++; st.pending = false; },
    cancelQueued: id => { st.cancelledQueued.push(id); if (st.queue === id) st.queue = null; },
    interrupt: () => { st.interrupts++; if (st.stopOnInterrupt) steps.push({ at: st.t + 1000, run: s => { s.running = false; s.ended.push(s.t); } }); },
    now: () => st.t,
    sleep: async ms => { st.t += ms; for (const s of steps) if (!s.done && st.t >= s.at) { s.done = true; s.run(st); } },
    timeoutMs: 10000,
    settleMs: 3000,
  };
  return { st, deps };
};

test('waitForMemoir:已有回憶錄請求在進行(節點正在寫)就不重發,等那一份寫完', async () => {
  const { st, deps } = mkWait({ pending: true, running: true }, [{ at: 2000, run: submitted }, { at: 2500, run: endTurn }]);
  assert.match(await waitForMemoir(deps), /已寫好回憶錄/);
  assert.equal(st.requests, 0, '沒有重發');
  assert.equal(st.cancels, 0);
});

test('waitForMemoir:已有回憶錄提示還在佇列(使用者先按過按鈕)就等它,不重發', async () => {
  const { st, deps } = mkWait({ pending: true, queue: 'q-old' }, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }, { at: 3000, run: s => { submitted(s); endTurn(s); } }]);
  assert.match(await waitForMemoir(deps), /已寫好回憶錄/);
  assert.equal(st.requests, 0);
});

test('waitForMemoir:請求掛著但已沒有佇列項目或進行中的回合(上一份不合格後停了)就重發', async () => {
  const { st, deps } = mkWait({ pending: true }, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }, { at: 2000, run: s => { submitted(s); endTurn(s); } }]);
  assert.match(await waitForMemoir(deps), /已寫好回憶錄/);
  assert.equal(st.requests, 1);
});

test('waitForMemoir:回合結束卻沒有提交 → 取消請求;請求被拒(例如每日上限)→ 說明原因,不等', async () => {
  const a = mkWait({}, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }, { at: 2000, run: endTurn }]);
  assert.match(await waitForMemoir(a.deps), /節點沒有提交回憶錄/);
  assert.equal(a.st.cancels, 1);
  assert.equal(a.st.pending, false);
  // 主控台在回合結束時已經清掉請求(turnEnded):請求不在了也不能誤報「已寫好」
  const c = mkWait({}, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }, { at: 2000, run: s => { endTurn(s); s.pending = false; } }]);
  assert.match(await waitForMemoir(c.deps), /節點沒有提交回憶錄/);
  const b = mkWait({ requestError: '「獵戶」今天已經寫了 3 份回憶錄,明天再寫。' });
  assert.match(await waitForMemoir(b.deps), /沒有寫回憶錄:.*3 份/);
  assert.equal(b.st.t, 1000, '沒有等待');
});

test('waitForMemoir:逾時 → 取消請求、拿掉佇列裡的回憶錄提示、中斷正在寫的回合', async () => {
  const q = mkWait();
  assert.match(await waitForMemoir(q.deps), /沒有在時限內/);
  assert.deepEqual(q.st.cancelledQueued, ['q-new']);
  assert.equal(q.st.cancels, 1);
  assert.equal(q.st.interrupts, 0, '還在佇列、沒有在跑就不用中斷');
  const r = mkWait({}, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }]);
  assert.match(await waitForMemoir(r.deps), /沒有在時限內/);
  assert.equal(r.st.interrupts, 1);
  assert.deepEqual(r.st.cancelledQueued, []);
  // 中斷後回合一直沒結束:最多再等 settleMs 就繼續(不會卡住刪除)
  assert.ok(r.st.t >= 1000 + 10000 + 3000 && r.st.t < 1000 + 10000 + 3000 + 500, `等了 ${r.st.t}`);
});

test('waitForMemoir:已經提交成功但回合超過時限 → 回報已寫好(不誤報未寫完);中斷後等回合真的結束才繼續', async () => {
  const w = mkWait({ stopOnInterrupt: true }, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }, { at: 3000, run: submitted }]);
  const note = await waitForMemoir(w.deps);
  assert.match(note, /已寫好回憶錄/);
  assert.match(note, /超過時限,已中斷/);
  assert.doesNotMatch(note, /沒有在時限內/);
  assert.equal(w.st.interrupts, 1);
  assert.equal(w.st.running, false, '回合已結束才回傳');
  assert.ok(w.st.t >= 1000 + 10000 + 1000, `中斷後有等回合結束(${w.st.t})`);
  // 寫好之後回合還在跑:等回合結束(節點回到待命)才回報
  const x = mkWait({}, [{ at: 1500, run: s => { s.queue = null; s.running = true; } }, { at: 2000, run: submitted }, { at: 4000, run: endTurn }]);
  assert.match(await waitForMemoir(x.deps), /已寫好回憶錄/);
  assert.ok(x.st.t >= 4000, '等到回合結束');
  assert.equal(x.st.cancels, 0);
});

// ---- 檔頭與路徑
test('buildMemoir:檔頭欄位與順序、路徑 memoirs/<節點名>-<ID 前 8 碼>/<日期>-<標題>.md、檔名去掉 [ ] # ^ |、資料夾開頭的 _ . 去掉', () => {
  const now = new Date(2026, 10, 23, 9, 8, 7);
  const r = buildMemoir({ title: '第一章 [部署] #1 ^a|b', content: BODY, period: '2026-11-16/2026-11-17', nodeId: 'node-orion-0001', nodeName: '_.獵戶', backendLabel: 'Claude Code', now });
  assert.deepEqual(Object.keys(r.meta), ['種類', '節點ID', '節點', '後台', '標題', '涵蓋期間', '範圍', '更新時間', '狀態']);
  assert.deepEqual(r.meta, { 種類: '回憶錄', 節點ID: 'node-orion-0001', 節點: '_.獵戶', 後台: 'Claude Code', 標題: '第一章 [部署] #1 ^a|b', 涵蓋期間: '2026-11-16/2026-11-17', 範圍: '全域', 更新時間: '2026-11-23 09:08:07', 狀態: '未確認' });
  assert.equal(r.dir, 'memoirs/獵戶-node-ori');
  assert.equal(r.baseName, '2026-11-23-第一章 部署 1 ab');
  const w = buildMemoir({ title: 'a/b:c?', content: BODY, period: '2026-11-16', nodeId: 'x:y', nodeName: '...', backendLabel: 'Codex', now });
  assert.equal(w.dir, 'memoirs/未命名-xy');
  assert.equal(w.baseName, '2026-11-23-abc');
});

test('writeMemoir:同名加 -2、-3 不覆蓋;檔頭字串一律雙引號,第一行就是 ---', () => {
  const dir = tmp('nexus-memoir-w-');
  const input = { title: '同一章', content: BODY, period: '2026-11-16', nodeId: 'node-orion-0001', nodeName: '獵戶', backendLabel: 'Claude Code', now: new Date(2026, 10, 23, 10) };
  assert.equal(writeMemoir(dir, input).path, 'memoirs/獵戶-node-ori/2026-11-23-同一章.md');
  assert.equal(writeMemoir(dir, { ...input, content: BODY + '\n第二份' }).path, 'memoirs/獵戶-node-ori/2026-11-23-同一章-2.md');
  assert.equal(writeMemoir(dir, input).path, 'memoirs/獵戶-node-ori/2026-11-23-同一章-3.md');
  const first = readFileSync(join(dir, 'memoirs', '獵戶-node-ori', '2026-11-23-同一章.md'), 'utf8');
  assert.ok(first.startsWith('---\n種類: "回憶錄"\n節點ID: "node-orion-0001"\n'), first.slice(0, 80));
  assert.ok(first.includes('\n涵蓋期間: "2026-11-16"\n') && first.includes('\n範圍: "全域"\n') && first.includes('\n狀態: "未確認"\n'));
  assert.ok(!first.includes('第二份'), '第一份沒有被覆蓋');
});

test('遮罩:標題與正文的本機絕對路徑、金鑰都遮掉(檔名也不含),回報遮罩處數', () => {
  const dir = tmp('nexus-memoir-m-');
  const content = '設定在 C:\\Users\\example\\star app\\deploy.json,另一份 /home/bob/x.txt;金鑰 api_key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456。相對路徑 docs/a.md 不動。\n\n## 來源\n\n對話\n\n## 不確定之處\n\n無';
  const res = writeMemoir(dir, { title: '讀 C:\\Users\\example\\a.md 與 sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456', content, period: '2026-11-16', nodeId: 'node-orion-0001', nodeName: '獵戶', backendLabel: 'Claude Code', now: new Date(2026, 10, 23, 10) });
  const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
  assert.ok(!/example|bob|sk-ant-api03/.test(text), text);
  assert.ok(!/example|sk-ant/.test(res.path), res.path);
  assert.ok(text.includes('[本機路徑已隱藏]') && text.includes('[已遮罩]') && text.includes('docs/a.md'));
  assert.ok(res.pathsMasked >= 3, `本機路徑 ${res.pathsMasked}`);
  assert.ok(res.masked >= 2, `金鑰 ${res.masked}`);
});

test('檔頭讀回:parseFrontMatter 與 js-yaml 讀到的值和寫入的相同(含引號、反斜線、冒號、井號)', () => {
  const dir = tmp('nexus-memoir-y-');
  const title = '他說 "好": 第 #2 章 \\ 結尾';
  const res = writeMemoir(dir, { title, content: BODY, period: '2026-11-16/2026-11-17', nodeId: 'node-orion-0001', nodeName: '獵戶: 一號 #A', backendLabel: 'Claude Code', now: new Date(2026, 10, 23, 10, 0, 0) });
  const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
  const { meta, body } = parseFrontMatter(text);
  const doc = yaml.load(/^---\n([\s\S]*?)\n---/.exec(text)[1]);
  const want = { 種類: '回憶錄', 節點ID: 'node-orion-0001', 節點: '獵戶: 一號 #A', 後台: 'Claude Code', 標題: title, 涵蓋期間: '2026-11-16/2026-11-17', 範圍: '全域', 更新時間: '2026-11-23 10:00:00', 狀態: '未確認' };
  assert.deepEqual(Object.fromEntries(meta), want);
  assert.deepEqual(doc, want);
  assert.ok(body.includes('## 來源') && body.includes('## 不確定之處'));
  const e = entryFromFile(res.path, text, 0, text.length);
  assert.equal(e.kind, 'memoir');
  assert.equal(e.scope, '全域');
  assert.equal(e.nodeId, 'node-orion-0001');
  assert.equal(e.status, '未確認');
  assert.equal(e.title, title);
});

// ---- 請求與提交
test('請求:排進節點佇列(提示文字專門寫給回憶錄,含今天日期與對話期間);子代理、終端機、休眠、失聯被拒絕', async () => {
  const s = mkSvc();
  const note = await s.svc.requestMemoir(ORION);
  assert.match(note, /已請「獵戶」寫一章回憶錄/);
  assert.equal(s.requests.length, 1);
  const t = s.requests[0].text;
  assert.ok(t.startsWith(MEMOIR_PROMPT_LEAD) && t.includes('kind:memoir') && t.includes('## 來源') && t.includes('## 不確定之處') && t.includes('period'));
  assert.ok(t.includes('今天是 2026-11-23') && t.includes('2026-11-16 到 2026-11-17'), t);
  assert.ok(!t.includes('記憶草稿請求'), '和一般記憶草稿請求分開');
  assert.equal(accumulatedChars([{ type: 'message', seq: 1, role: 'user', text: t }], 0), 0, '回憶錄請求不算對話內容');
  assert.ok(s.svc.hasPendingMemoir(ORION));
  assert.match(await errOf(s.svc.requestMemoir(ORION)), /已經請這個節點寫回憶錄/);
  assert.match(await errOf(s.svc.requestMemoir('sub-1')), /子代理不能寫回憶錄/);
  assert.match(await errOf(s.svc.requestMemoir('nobody')), /找不到/);
  const v = s.agents.get('node-vega-0002');
  v.terminal = true;
  assert.match(await errOf(s.svc.requestMemoir(v.id)), /終端機/);
  v.terminal = false; v.state = 'sleeping';
  assert.match(await errOf(s.svc.requestMemoir(v.id)), /休眠/);
  v.state = 'lost';
  assert.match(await errOf(s.svc.requestMemoir(v.id)), /失聯/);
  assert.ok(formatMemoirPrompt({ nodeName: '獵戶', today: '2026-11-23', farewell: true }).includes('即將刪除'));
});

test('重新請求:舊請求還在進行就拒絕;掛著但已沒有在進行(佇列與回合都沒有)就可以重發並覆蓋舊請求', async () => {
  const live = { active: true };
  const s = mkSvc({ memoirActive: () => live.active });
  await s.svc.requestMemoir(ORION);
  assert.match(await errOf(s.svc.requestMemoir(ORION)), /已經請這個節點寫回憶錄/);
  assert.match(await errOf(s.svc.requestMemoir(ORION, { farewell: true })), /已經請這個節點寫回憶錄/);
  live.active = false;
  s.clock.now = new Date(s.clock.now.getTime() + 60 * 1000);
  assert.match(await s.svc.requestMemoir(ORION, { farewell: true }), /已請「獵戶」/);
  assert.equal(s.requests.length, 2);
  assert.ok(s.requests[1].text.includes('即將刪除'));
  assert.equal(JSON.parse(s.settings.get('memoir:pending'))[ORION].at, s.clock.now.getTime(), '舊請求被覆蓋');
  // 請求的回合已經不在進行時提交:拒收並清掉請求(不能事後補交);按鈕可以重新請求
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: 't', period: '2026-11-16', content: BODY })), /沒有進行中的回憶錄請求.*按「寫回憶錄」/);
  assert.ok(!s.svc.hasPendingMemoir(ORION));
  assert.deepEqual(memoirFiles(s.vaultDir), []);
  assert.match(await s.svc.requestMemoir(ORION), /已請「獵戶」/);
  // 沒有提供 memoirActive 時退回用時間判斷(30 分鐘內拒絕)
  const t = mkSvc();
  await t.svc.requestMemoir(ORION);
  assert.match(await errOf(t.svc.requestMemoir(ORION)), /已經請/);
  t.clock.now = new Date(t.clock.now.getTime() + 31 * 60 * 1000);
  assert.match(await t.svc.requestMemoir(ORION), /已請/);
});

test('提交:沒有請求不能交;回憶錄請求和一般記憶草稿請求互不通用', async () => {
  const s = mkSvc();
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: 't', period: '2026-11-16', content: BODY })), /沒有請你寫回憶錄/);
  await s.svc.requestMemoir(ORION);
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'knowledge', title: 't', content: 'x' })), /沒有請你整理記憶草稿.*kind 請填 memoir/);
  assert.ok(s.svc.hasPendingMemoir(ORION), '交錯種類不會用掉回憶錄請求');
  assert.match(await errOf(s.svc.submit('node-vega-0002', { kind: 'memoir', title: 't', period: '2026-11-16', content: BODY })), /沒有請你寫回憶錄/, '不能替別的節點交');
});

test('提交:格式不合格拒收,請求保留可以補上重寫;合格後寫進 memoirs/ 且未確認;同一個請求只能交一份', async () => {
  const s = mkSvc();
  await s.svc.requestMemoir(ORION);
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '第一章', period: '2026-11-16', content: '正文\n\n## 來源\n\n無' })), /缺少固定章節/);
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '第一章', period: '2026-11-18/2026-11-16', content: BODY })), /起日晚於迄日/);
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '第一章', period: '2026-02-30', content: BODY })), /不存在的日期/);
  assert.ok(s.svc.hasPendingMemoir(ORION));
  assert.deepEqual(memoirFiles(s.vaultDir), []);
  const out = await s.svc.submit(ORION, { kind: '回憶錄', title: '第一章', period: '2026-11-16/2026-11-17', content: BODY });
  assert.match(out, /已寫入回憶錄「第一章」.*未確認.*memoirs\/獵戶-node-ori\/2026-11-23-第一章\.md/);
  assert.ok(!s.svc.hasPendingMemoir(ORION));
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '第二章', period: '2026-11-16', content: BODY })), /沒有請你寫回憶錄/);
  assert.deepEqual(memoirFiles(s.vaultDir), ['memoirs/獵戶-node-ori/2026-11-23-第一章.md']);
});

test('身分欄位由主控台填:節點在參數裡填的 節點ID / 節點 / 後台 / 狀態 / 範圍 一律忽略', async () => {
  const s = mkSvc();
  await s.svc.requestMemoir(ORION);
  const res = await s.svc.submit(ORION, { kind: 'memoir', title: '冒名', period: '2026-11-16', content: BODY, 節點ID: 'node-vega-0002', 節點: '織女', 後台: 'Codex', node_id: 'node-vega-0002', node: '織女', backend: 'codex', 狀態: '已確認', status: '已確認', 範圍: '專案', 種類: 'knowledge' });
  assert.match(res, /memoirs\/獵戶-node-ori\//);
  const [rel] = memoirFiles(s.vaultDir);
  const { meta } = parseFrontMatter(readFileSync(join(s.vaultDir, ...rel.split('/')), 'utf8'));
  assert.equal(meta.get('節點ID'), ORION);
  assert.equal(meta.get('節點'), '獵戶');
  assert.equal(meta.get('後台'), 'Claude Code');
  assert.equal(meta.get('狀態'), '未確認');
  assert.equal(meta.get('範圍'), '全域');
  assert.equal(meta.get('種類'), '回憶錄');
});

test('每日上限:同一個節點同一天最多 3 份(請求與提交都擋);別的節點、隔天不受影響', async () => {
  assert.equal(MEMOIR_DAILY_CAP, 3);
  const s = mkSvc();
  for (let i = 1; i <= 3; i++) {
    await s.svc.requestMemoir(ORION);
    await s.svc.submit(ORION, { kind: 'memoir', title: '同一章', period: '2026-11-16', content: BODY });
  }
  assert.equal(s.svc.memoirCountToday(ORION), 3);
  assert.deepEqual(memoirFiles(s.vaultDir), ['memoirs/獵戶-node-ori/2026-11-23-同一章-2.md', 'memoirs/獵戶-node-ori/2026-11-23-同一章-3.md', 'memoirs/獵戶-node-ori/2026-11-23-同一章.md']);
  assert.match(await errOf(s.svc.requestMemoir(ORION)), /今天已經寫了 3 份/);
  // 刪除前的告別請求:說明已達上限、這次不寫,不說「明天再寫」
  const farewellErr = await errOf(s.svc.requestMemoir(ORION, { farewell: true }));
  assert.match(farewellErr, /已達每日上限,這次不寫回憶錄/);
  assert.doesNotMatch(farewellErr, /明天/);
  // 上限之前發出的請求,提交時也要再擋一次(例如請求後別的路徑先寫滿)
  s.settings.set(`memoir:pending`, JSON.stringify({ [ORION]: { at: s.clock.now.getTime() } }));
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '第四章', period: '2026-11-16', content: BODY })), /每日上限/);
  assert.ok(!s.svc.hasPendingMemoir(ORION));
  assert.equal(memoirFiles(s.vaultDir).length, 3);
  await s.svc.requestMemoir('node-vega-0002');
  s.clock.now = new Date(2026, 10, 24, 8);
  await s.svc.requestMemoir(ORION);
  assert.match(await s.svc.submit(ORION, { kind: 'memoir', title: '隔天', period: '2026-11-24', content: BODY }), /2026-11-24-隔天/);
});

test('取消請求:cancelMemoir 之後不能再交(刪除節點時逾時就取消)', async () => {
  const s = mkSvc();
  await s.svc.requestMemoir(ORION);
  s.svc.cancelMemoir(ORION);
  assert.ok(!s.svc.hasPendingMemoir(ORION));
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: 't', period: '2026-11-16', content: BODY })), /沒有請你寫回憶錄/);
});

test('請求的有效期:回合還在進行時可以交(不合格可在同一回合重寫);回合結束沒提交就清掉,之後被別的節點叫去也不能補交', async () => {
  const live = { active: true };
  const s = mkSvc({ memoirActive: () => live.active });
  await s.svc.requestMemoir(ORION);
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: 't', period: '2026-11-16', content: '正文' })), /缺少固定章節/);
  assert.ok(s.svc.hasPendingMemoir(ORION), '同一個回合裡不合格,請求保留');
  // 回憶錄回合結束(Core 的 finishTask 呼叫 turnEnded,title 是任務標題),節點沒有提交
  live.active = false;
  s.svc.turnEnded(ORION, formatMemoirPrompt({ nodeName: '獵戶', today: '2026-11-23' }).replace(/\s+/g, ' ').slice(0, 200), CONSOLE);
  assert.ok(!s.svc.hasPendingMemoir(ORION), '回合結束就清掉請求');
  // 幾天後別的節點用 ask_node 叫它寫(那個回合不是回憶錄回合)
  s.clock.now = new Date(2026, 10, 26, 10);
  const err = await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '補交', period: '2026-11-16', content: BODY }));
  assert.match(err, /沒有進行中的回憶錄請求/);
  assert.match(err, /請使用者在對話視窗按「寫回憶錄」/);
  assert.deepEqual(memoirFiles(s.vaultDir), []);
  assert.equal(s.svc.memoirSubmittedAt(ORION), 0);
  // 別種回合結束不影響請求;回憶錄提示還在佇列時也不清
  live.active = true;
  await s.svc.requestMemoir(ORION);
  s.svc.turnEnded(ORION, '使用者的一般指令', { source: 'desktop' });
  s.svc.turnEnded(ORION, `${DRAFT_PROMPT_LEAD}這不是使用者的新指令`, CONSOLE);
  assert.ok(s.svc.hasPendingMemoir(ORION));
  s.svc.turnEnded(ORION, `${MEMOIR_PROMPT_LEAD}這不是使用者的新指令`, CONSOLE);
  assert.ok(s.svc.hasPendingMemoir(ORION), '回憶錄提示還在佇列(仍在進行)就不清');
  // 合格提交後記下提交時間(刪除流程用來分辨寫好了)
  assert.match(await s.svc.submit(ORION, { kind: 'memoir', title: '準時', period: '2026-11-26', content: BODY }), /已寫入回憶錄/);
  assert.equal(s.svc.memoirSubmittedAt(ORION), s.clock.now.getTime());
});

test('請求的有效期:請求還掛著但回合已經不在(沒有接上 memoirActive 時退回用 30 分鐘時限)也拒收並清掉', async () => {
  const s = mkSvc();
  await s.svc.requestMemoir(ORION);
  s.clock.now = new Date(s.clock.now.getTime() + 31 * 60 * 1000);
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: '晚交', period: '2026-11-16', content: BODY })), /沒有進行中的回憶錄請求/);
  assert.ok(!s.svc.hasPendingMemoir(ORION));
  assert.deepEqual(memoirFiles(s.vaultDir), []);
});

test('主控台重開:清掉上次留下的回憶錄與記憶草稿請求;提示還在佇列(重開後才送出)的保留;刪除節點時也清掉', async () => {
  const queued = new Set();
  const s = mkSvc({ memoirActive: id => queued.has(id), draftActive: () => false });
  s.settings.set('memoir:pending', JSON.stringify({ [ORION]: { at: 1 }, 'node-vega-0002': { at: 2 } }));
  s.settings.set('draft:pending', JSON.stringify({ [ORION]: { at: 1, project: 'demo', projectId: 'x' } }));
  queued.add('node-vega-0002');
  s.svc.resetOnStartup();
  assert.ok(!s.svc.hasPendingMemoir(ORION));
  assert.ok(s.svc.hasPendingMemoir('node-vega-0002'), '提示還在佇列的保留');
  assert.ok(!s.svc.hasPending(ORION));
  assert.match(await errOf(s.svc.submit(ORION, { kind: 'memoir', title: 't', period: '2026-11-16', content: BODY })), /沒有進行中的回憶錄請求/);
  // 沒有接上 memoirActive(單元測試)時全部清掉
  const t = mkSvc();
  t.settings.set('memoir:pending', JSON.stringify({ [ORION]: { at: t.clock.now.getTime() } }));
  t.svc.resetOnStartup();
  assert.ok(!t.svc.hasPendingMemoir(ORION));
  // 節點被刪除時兩種請求都清掉
  const u = mkSvc();
  await u.svc.requestMemoir(ORION);
  u.svc.forget(ORION);
  assert.ok(!u.svc.hasPendingMemoir(ORION));
});

test('對話視窗的按鈕狀態:info 的 memoirBusy 依主控台的請求判斷(關掉再開也一樣)', async () => {
  const live = { active: true };
  const s = mkSvc({ memoirActive: () => live.active });
  assert.equal(s.svc.info(ORION).memoirBusy, false);
  await s.svc.requestMemoir(ORION);
  assert.equal(s.svc.info(ORION).memoirBusy, true);
  live.active = false;
  assert.equal(s.svc.info(ORION).memoirBusy, false, '回合不在了就不算進行中');
});

test('每日上限跨午夜:以提交當下的日期為準,上限檢查、檔名日期、計數都用同一天', async () => {
  // 請求在 23:59、提交在 00:01:算新的一天
  const s = mkSvc();
  s.clock.now = new Date(2026, 10, 23, 23, 59, 0);
  s.settings.set(`memoir:count:${ORION}:2026-11-23`, '3');
  assert.match(await errOf(s.svc.requestMemoir(ORION)), /今天已經寫了 3 份/, '請求時用請求當天檢查');
  s.settings.set(`memoir:count:${ORION}:2026-11-23`, '2');
  await s.svc.requestMemoir(ORION);
  s.clock.now = new Date(2026, 10, 24, 0, 1, 0);
  assert.match(await s.svc.submit(ORION, { kind: 'memoir', title: '跨夜', period: '2026-11-23', content: BODY }), /2026-11-24-跨夜/);
  assert.equal(s.settings.get(`memoir:count:${ORION}:2026-11-23`), '2', '前一天的計數不變');
  assert.equal(s.settings.get(`memoir:count:${ORION}:2026-11-24`), '1');
  // 提交途中時鐘剛好跨過午夜:整個提交只取一次時間,計數記在檔名的那一天、累加在那一天原本的數字上
  let armed = false, calls = 0;
  const t = mkSvc({ now: () => (!armed ? new Date(2026, 10, 23, 23, 50) : calls++ === 0 ? new Date(2026, 10, 23, 23, 59, 59, 999) : new Date(2026, 10, 24, 0, 0, 0)) });
  t.settings.set(`memoir:count:${ORION}:2026-11-23`, '2');
  await t.svc.requestMemoir(ORION);
  armed = true;
  assert.match(await t.svc.submit(ORION, { kind: 'memoir', title: '午夜', period: '2026-11-23', content: BODY }), /2026-11-23-午夜/);
  assert.equal(t.settings.get(`memoir:count:${ORION}:2026-11-23`), '3');
  assert.equal(t.settings.get(`memoir:count:${ORION}:2026-11-24`), undefined);
});

test('章節標題正規化:寫入檔案時固定章節的標題行改成標準寫法,其他內容與圍欄、註解裡的不動', () => {
  const body = '正文 ## 來源 不是標題\n\n## **來源**:\r\n無\n\n```\n## 來源:\n```\n<!--\n## 不確定之處:\n-->\n   ## 不確定之處 ##\n- 記不清\n## 其他:\n## 來源\n補充';
  assert.equal(normalizeSectionHeadings(body), '正文 ## 來源 不是標題\n\n## 來源\r\n無\n\n```\n## 來源:\n```\n<!--\n## 不確定之處:\n-->\n## 不確定之處\n- 記不清\n## 其他:\n## 來源\n補充');
  for (const [src, want] of [['## 來源:', '## 來源'], ['## 來源：', '## 來源'], ['## **來源**', '## 來源'], ['## __不確定之處__：', '## 不確定之處'], ['## 來源 ###', '## 來源'], [' ## **不確定之處:**', '## 不確定之處']]) {
    assert.equal(normalizeSectionHeadings(`${src}\n無`), `${want}\n無`, src);
  }
  // writeMemoir 寫出來的檔案是標準寫法
  const dir = tmp('nexus-memoir-n-');
  const res = writeMemoir(dir, { title: '標題', content: '正文\n\n## **來源**:\n對話\n\n## 不確定之處：\n無', period: '2026-11-16', nodeId: 'node-orion-0001', nodeName: '獵戶', backendLabel: 'Claude Code', now: new Date(2026, 10, 23, 10) });
  const text = readFileSync(join(dir, ...res.path.split('/')), 'utf8');
  assert.ok(text.includes('\n## 來源\n對話\n') && text.includes('\n## 不確定之處\n無'), text);
  assert.ok(!text.includes('**來源**') && !text.includes('不確定之處：'));
});

test('checkSections:<pre> 等 HTML 區塊裡的 ## 不算標題;行內的 <!--(同一行關閉、行中間、行內程式碼裡)不會吞掉後面的內容', () => {
  const ok = body => assert.deepEqual(checkSections(body), { missing: [], empty: [] }, body);
  const miss = (body, missing) => assert.deepEqual(checkSections(body).missing, missing, body);
  miss('正文\n<pre>\n## 來源\n無\n</pre>\n## 不確定之處\n無', ['來源']);
  miss('<PRE class="x">\n## 來源\n</PRE>\n## 不確定之處\n無', ['來源']);
  miss('<script>\n## 來源\n</script>\n## 不確定之處\n無', ['來源']);
  ok('<pre>一行就結束</pre>\n## 來源\n無\n## 不確定之處\n無');
  // <pre> 區塊裡的內容算章節內容
  assert.deepEqual(checkSections('## 來源\n<pre>\n對話紀錄\n</pre>\n## 不確定之處\n無').empty, []);
  // 行內程式碼裡寫了 <!--
  ok('我用了 `<!--` 標記註解。\n\n## 來源\n對話\n\n## 不確定之處\n無');
  ok('## 來源\n用了 ``<!-- x`` 這種寫法\n## 不確定之處\n無');
  // 行中間出現、沒有在同一行關閉的 <!--:當一般文字
  ok('註解要寫成 <!-- 開頭\n## 來源\n對話\n## 不確定之處\n無');
  // 同一行就關閉的註解拿掉,後面的文字照算
  ok('<!-- 草稿 --> 正文\n## 來源 <!-- 補 -->\n對話\n## 不確定之處\n無 <!-- x -->');
  assert.deepEqual(checkSections('## 來源\n<!-- a --> 有字\n## 不確定之處\n無').empty, []);
  // 註解區塊結束那一行的 ## 不算標題
  miss('<!--\n註解\n--> ## 來源\n## 不確定之處\n無', ['來源']);
  assert.equal(parseMemoir({ title: 't', period: '2026-11-16', content: '正文用了 `<!--`\n\n## 來源\n\n對話\n\n## 不確定之處\n\n無' }).title, 't');
});

// ---- 可見性與 memory_write
const toolDeps = dir => ({
  vaultDir: dir,
  list: () => {
    const out = [];
    const walk = rel => { for (const f of readdirSync(join(dir, rel), { withFileTypes: true })) { const r = `${rel}/${f.name}`; if (f.isDirectory()) { if (!f.name.startsWith('_')) walk(r); } else if (f.name.endsWith('.md')) out.push(entryFromFile(r, readFileSync(join(dir, r), 'utf8'), 0, 0)); } };
    for (const d of VAULT_DIRS) if (existsSync(join(dir, d))) walk(d);
    return out;
  },
  rescan: () => {}, nodes: () => [], project: async () => ({ id: 'c:/work/demo', name: 'demo', root: 'c:/work/demo' }), head: async () => null, commitsAhead: async () => null, noteChief: () => {}, now: () => Date.parse('2026-11-23T00:00:00Z'),
});
const CALLER = { id: 'node-vega-0002', name: '織女', cwd: 'c:/work/demo', isChief: false };
const CHIEF = { id: 'chief', name: '總管', cwd: 'c:/work/demo', isChief: true };

test('可見性:未確認的回憶錄搜尋不到、直接給路徑也讀不到(寫入者自己也一樣);改成已確認後才看得到(全域,任何專案)', async () => {
  const dir = tmp('nexus-memoir-v-');
  const res = writeMemoir(dir, { title: '星圖部署', content: BODY, period: '2026-11-16', nodeId: 'node-orion-0001', nodeName: '獵戶', backendLabel: 'Claude Code', now: new Date(2026, 10, 23, 10) });
  const deps = toolDeps(dir);
  assert.equal(statusVisible('memoir', '未確認'), false);
  assert.equal(statusVisible('memoir', ''), false);
  assert.equal(statusVisible('memoir', '已確認'), true);
  assert.deepEqual(await searchMemory(deps, CALLER, { query: '部署' }), []);
  assert.deepEqual(await searchMemory(deps, { ...CALLER, id: 'node-orion-0001', name: '獵戶' }, { query: '部署', kind: 'memoir' }), []);
  assert.match(await errOf(memoryRead(deps, CALLER, { path: res.path })), /找不到這則記憶.*回憶錄要使用者確認後才看得到/);
  // 使用者在記憶庫管理 app 確認
  const abs = join(dir, ...res.path.split('/'));
  writeFileSync(abs, readFileSync(abs, 'utf8').replace('狀態: "未確認"', '狀態: "已確認"'));
  const hits = await searchMemory(deps, { ...CALLER, cwd: 'c:/elsewhere' }, { query: '部署', kind: '回憶錄' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].entry.kind, 'memoir');
  assert.match(await memorySearch(deps, CALLER, { query: '部署' }), /\[回憶錄\] 星圖部署/);
  assert.match(await memoryRead(deps, CALLER, { path: res.path }), /## 不確定之處/);
  // 退回也看不到
  writeFileSync(abs, readFileSync(abs, 'utf8').replace('狀態: "已確認"', '狀態: "退回"'));
  assert.match(await errOf(memoryRead(deps, CALLER, { path: res.path })), /找不到這則記憶/);
});

test('memory_write 不能寫回憶錄(總管也不行),也不會建立 memoirs/', async () => {
  const dir = tmp('nexus-memoir-mw-');
  for (const kind of ['memoir', '回憶錄', 'MEMOIR']) {
    assert.match(await errOf(memoryWrite(toolDeps(dir), CHIEF, { kind, title: 't', content: BODY })), /回憶錄不能用 memory_write/, kind);
  }
  assert.ok(!existsSync(join(dir, 'memoirs')));
});

test('記憶庫:memoirs 是記憶庫的子資料夾;說明檔列出 memoirs,舊版說明檔會換成新版', () => {
  assert.ok(VAULT_DIRS.includes('memoirs'));
  assert.ok(README.includes('  memoirs      回憶錄'));
  assert.ok(README.indexOf('  meetings') < README.indexOf('  memoirs'));
  const v4 = README.replace(/nodes\/封存\/_存點\/ [^\n]*\n/, '').replace(/\n {2}memoirs {6}[^\n]*/, '');
  assert.notEqual(v4, README);
  assert.equal(readmeUpdate(v4), README, '上一版(只有 meetings)換成新版');
  assert.equal(readmeUpdate(README), null);
  assert.equal(readmeUpdate(v4 + '使用者加的字'), null, '使用者改過不動');
  const e = entryFromFile('memoirs/獵戶-node-ori/2026-11-23-a.md', '沒有屬性區塊的回憶錄', 1, 1);
  assert.equal(e.kind, 'memoir', '資料夾 memoirs 推得出種類');
  assert.equal(e.scope, '全域');
  // 種類判斷和寶庫一致:memoirs/ 以外寫著「種類: 回憶錄」的舊檔照資料夾算
  const legacy = entryFromFile('knowledge/demo/舊回憶.md', '---\n種類: 回憶錄\n狀態: 已確認\n---\n內容', 1, 1);
  assert.equal(legacy.kind, 'knowledge');
  assert.equal(entryFromFile('preferences/舊回憶.md', '---\n種類: memoir\n---\n內容', 1, 1).kind, 'preference');
  assert.equal(entryFromFile('memoirs/獵戶-node-ori/a.md', '---\n種類: 回憶錄\n---\n內容', 1, 1).kind, 'memoir');
  assert.equal(entryFromFile('knowledge/demo/a.md', '---\n種類: 判例\n---\n內容', 1, 1).kind, 'case', '其他種類照舊以屬性優先');
});

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log('[ok]', name);
}
for (const d of made) rmSync(d, { recursive: true, force: true });
console.log(`通過 ${passed} 項`);
