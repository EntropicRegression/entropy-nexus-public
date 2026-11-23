// 驗收:長期記憶階段 4.5(記憶內容):對話草稿(門檻判斷、memory_draft 的權限與一次請求一份)、子類與取代的解析、
// 判例的摘要與回顧、封存檔的回顧、新來源 draft 不算工作任務也不是判例候選。
// 用法:node --no-warnings tests/memory-draft.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAFT_THRESHOLD, accumulatedChars, draftSegment, shouldOfferDraft } from '../src/shared/memory-draft.ts';
import { DRAFT_RETRY_MS, DraftService, draftThreshold, formatDraftPrompt, parseDraft } from '../src/main/memory-draft.ts';
import { buildCaseBody, firstSentence, parseSubmission } from '../src/main/cases.ts';
import { buildArchive, chiefSummaryPrompt, SELF_SUMMARY_PROMPT, splitReview } from '../src/main/memory-archive.ts';
import { entryFromFile, parseFrontMatter } from '../src/main/memory-vault.ts';
import { notCandidateReason } from '../src/shared/case-candidates.ts';
import { computeNodeStats, isWorkTask } from '../src/shared/node-stats.ts';
import { safeName, writeMemory } from '../src/main/memory-write.ts';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const msg = (seq, role, text) => ({ type: 'message', seq, role, text });

// ---- 門檻判斷(純函式)
test('累積字數:只算上次儲存之後使用者與節點的訊息,主控台自己的請求不算', () => {
  const ev = [msg(1, 'user', 'a'.repeat(100)), msg(2, 'agent', 'b'.repeat(50)), { type: 'tool', seq: 3 }, msg(4, 'user', '(主控台:判例撰寫請求。' + 'x'.repeat(500)), msg(5, 'user', '〔歸檔總結〕' + 'y'.repeat(500)), msg(6, 'agent', 'c'.repeat(30))];
  assert.equal(accumulatedChars(ev, 0), 180);
  assert.equal(accumulatedChars(ev, 2), 30);
  assert.equal(accumulatedChars(ev, 6), 0);
});

test('shouldOfferDraft:達到門檻才顯示,預設 3000', () => {
  assert.equal(DRAFT_THRESHOLD, 3000);
  assert.equal(shouldOfferDraft(2999), false);
  assert.equal(shouldOfferDraft(3000), true);
  assert.equal(shouldOfferDraft(299, 300), false);
  assert.equal(shouldOfferDraft(300, 300), true);
  assert.equal(shouldOfferDraft(Number.NaN), false);
});

test('環境變數 NEXUS_DRAFT_THRESHOLD 覆寫門檻,不合法就用預設', () => {
  assert.equal(draftThreshold({}), 3000);
  assert.equal(draftThreshold({ NEXUS_DRAFT_THRESHOLD: '500' }), 500);
  assert.equal(draftThreshold({ NEXUS_DRAFT_THRESHOLD: 'abc' }), 3000);
  assert.equal(draftThreshold({ NEXUS_DRAFT_THRESHOLD: '0' }), 3000);
});

test('draftSegment:標明誰說的、超過上限保留最近的部分、回傳涵蓋到的最後 seq', () => {
  const ev = [msg(1, 'user', '請改成 UTC'), msg(2, 'agent', '好,已改')];
  const s = draftSegment(ev, 0);
  assert.equal(s.text, '使用者:請改成 UTC\n\n節點:好,已改');
  assert.equal(s.lastSeq, 2);
  assert.equal(s.chars, '請改成 UTC'.length + '好,已改'.length);
  const long = draftSegment([msg(1, 'user', 'x'.repeat(100)), msg(2, 'agent', 'END')], 0, 50);
  assert.ok(long.text.startsWith('(前面較早的部分已省略)') && long.text.endsWith('END'));
  assert.equal(draftSegment([], 7).lastSeq, 7);
});

// ---- memory_draft 的權限與一次請求一份
const mkSvc = (over = {}) => {
  const vaultDir = mkdtempSync(join(tmpdir(), 'nexus-draft-'));
  const settings = new Map();
  const events = [];
  const requests = [];
  const agents = new Map([['n1', { id: 'n1', name: 'Hagemi', backend: 'claude', model: 'sonnet', state: 'idle', terminal: false, parentId: null }], ['n2', { id: 'n2', name: '乙號', backend: 'codex', model: '', state: 'idle', terminal: false, parentId: null }]]);
  const clock = { now: new Date(2026, 10, 21, 12, 0, 0) };
  const svc = new DraftService({
    vaultDir,
    getSetting: k => settings.get(k) ?? null,
    setSetting: (k, v) => settings.set(k, v),
    history: id => (id === 'n1' ? events : []),
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
  return { vaultDir, svc, settings, events, requests, agents, clock };
};
const talk = (s, n = 120, seq0 = 1) => { s.events.push(msg(seq0, 'user', '請把逾時改成 UTC 計算。'.padEnd(n, '。')), msg(seq0 + 1, 'agent', '好。')); };

test('請求:累積不夠不能請求;夠了才排進節點佇列(來源 draft),記下位置', async () => {
  const s = mkSvc();
  s.events.push(msg(1, 'user', '短'));
  await assert.rejects(s.svc.request('n1'), /累積到 100 字/);
  assert.equal(s.requests.length, 0);
  talk(s, 150, 2);
  const note = await s.svc.request('n1');
  assert.match(note, /已請「Hagemi」/);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].agentId, 'n1');
  assert.ok(s.requests[0].text.startsWith('(主控台:記憶草稿請求。') && s.requests[0].text.includes('memory_draft') && s.requests[0].text.includes('請把逾時改成 UTC'));
  assert.deepEqual(s.svc.info('n1'), { lastSeq: 3, threshold: 100, memoirBusy: false });
  // 剛儲存過,累積不夠
  await assert.rejects(s.svc.request('n1'), /累積到 100 字|已經請/);
});

test('請求:休眠、終端機、子代理、找不到的節點被拒絕', async () => {
  const s = mkSvc();
  talk(s);
  s.agents.get('n1').state = 'sleeping';
  await assert.rejects(s.svc.request('n1'), /休眠/);
  s.agents.get('n1').state = 'lost';
  await assert.rejects(s.svc.request('n1'), /失聯/);
  s.agents.get('n1').state = 'idle';
  s.agents.get('n1').terminal = true;
  await assert.rejects(s.svc.request('n1'), /終端機/);
  s.agents.get('n1').terminal = false;
  s.agents.get('n1').parentId = 'x';
  await assert.rejects(s.svc.request('n1'), /找不到|子代理/);
  await assert.rejects(s.svc.request('nope'), /找不到/);
  assert.equal(s.requests.length, 0);
});

test('提交權限:沒被請求的節點不能提交;被請求的只能交一次', async () => {
  const s = mkSvc();
  talk(s);
  await assert.rejects(s.svc.submit('n1', { kind: 'preference', title: 't', content: 'c' }), /沒有請你/);
  await s.svc.request('n1');
  await assert.rejects(s.svc.submit('n2', { kind: 'preference', title: 't', content: 'c' }), /沒有請你/);
  const ok = await s.svc.submit('n1', { kind: 'preference', title: '回報要精簡', content: '使用者要求一兩句講完。password: hunter2secret' });
  assert.match(ok, /狀態:未確認/);
  assert.match(ok, /遮罩/);
  await assert.rejects(s.svc.submit('n1', { kind: 'preference', title: '再一份', content: 'c' }), /沒有請你/);
  assert.equal(s.svc.hasPending('n1'), false);
});

test('提交內容:偏好進 preferences/、知識進 knowledge/<專案>/,屬性齊全、狀態未確認、機密遮罩', async () => {
  const s = mkSvc();
  talk(s);
  await s.svc.request('n1');
  const r = await s.svc.submit('n1', { kind: 'knowledge', title: '逾時改用 UTC', content: '決定:期限一律用 UTC。\nBearer abcdefghijklmnop12345678', subtype: 'decision', supersedes: '[[knowledge/demo/舊逾時.md]]' });
  assert.match(r, /knowledge\/demo\/逾時改用 UTC\.md/);
  const text = readFileSync(join(s.vaultDir, 'knowledge', 'demo', '逾時改用 UTC.md'), 'utf8');
  const fm = parseFrontMatter(text).meta;
  assert.equal(fm.get('狀態'), '未確認');
  assert.equal(fm.get('子類'), '決策');
  assert.equal(fm.get('取代'), '[[knowledge/demo/舊逾時.md]]');
  assert.equal(fm.get('節點ID'), 'n1');
  assert.equal(fm.get('來源節點'), 'Hagemi(Claude Code · sonnet)');
  assert.equal(fm.get('專案'), 'demo');
  assert.equal(fm.get('專案ID'), 'c:/work/demo');
  assert.ok(fm.get('更新時間'));
  assert.ok(!text.includes('abcdefghijklmnop12345678') && text.includes('已遮罩'));
  const e = entryFromFile('knowledge/demo/逾時改用 UTC.md', text, 1, text.length);
  assert.equal(e.status, '未確認');
  assert.equal(e.subtype, '決策');
  assert.equal(e.supersedes, 'knowledge/demo/舊逾時.md');

  talk(s, 150, 10);
  await s.svc.request('n1');
  await s.svc.submit('n1', { kind: 'preference', title: '回報要精簡', content: '一兩句。' });
  const pt = readFileSync(join(s.vaultDir, 'preferences', '回報要精簡.md'), 'utf8');
  assert.match(pt, /^種類: preference$/m);
  assert.match(pt, /^範圍: 全域$/m);
  assert.match(pt, /^狀態: 未確認$/m);
});

test('提交不覆寫既有檔案:同名時加「-草稿」後綴', async () => {
  const s = mkSvc();
  writeMemory(s.vaultDir, 'preferences/回報要精簡.md', { 種類: 'preference', 狀態: '已確認' }, '原本已確認的內容');
  talk(s);
  await s.svc.request('n1');
  const r = await s.svc.submit('n1', { kind: 'preference', title: '回報要精簡', content: '新草稿' });
  assert.match(r, /回報要精簡-草稿\.md/);
  assert.match(readFileSync(join(s.vaultDir, 'preferences', '回報要精簡.md'), 'utf8'), /原本已確認的內容/);
  assert.ok(existsSync(join(s.vaultDir, 'preferences', '回報要精簡-草稿.md')));
});

test('逾時後可以重新請求(請求超過 30 分鐘沒提交)', async () => {
  const s = mkSvc();
  talk(s);
  await s.svc.request('n1');
  talk(s, 150, 10);
  await assert.rejects(s.svc.request('n1'), /已經請/);
  s.clock.now = new Date(s.clock.now.getTime() + DRAFT_RETRY_MS + 1000);
  await s.svc.request('n1');
  assert.equal(s.requests.length, 2);
});

test('請求的有效期:草稿回合結束沒提交就清掉請求,之後不能補交;回合不在時(或超過 30 分鐘)提交被拒並清掉', async () => {
  const live = { active: true };
  const s = mkSvc({ draftActive: () => live.active });
  talk(s);
  await s.svc.request('n1');
  assert.ok(s.svc.hasPending('n1'));
  // 別種回合結束不影響
  s.svc.turnEnded('n1', '使用者的一般指令', { source: 'desktop' });
  assert.ok(s.svc.hasPending('n1'));
  // 草稿回合結束(Core 的 finishTask 呼叫 turnEnded),節點沒有提交
  live.active = false;
  const title = s.requests[0].text.replace(/\s+/g, ' ').slice(0, 200);
  // 別的節點用 ask_node、會議、流程送來同樣開頭的文字:不算草稿回合
  for (const origin of [{ source: 'interop', from: { id: 'n2', name: '乙號' } }, { source: 'interop', from: { id: 'n2', name: '乙號', meeting: true } }, { source: 'flow', from: { id: 'f', name: '流程' } }]) {
    s.svc.turnEnded('n1', title, origin);
    assert.ok(s.svc.hasPending('n1'), JSON.stringify(origin));
  }
  s.svc.turnEnded('n1', title, { source: 'draft' });
  assert.equal(s.svc.hasPending('n1'), false);
  const err = await s.svc.submit('n1', { kind: 'preference', title: '補交', content: 'c' }).then(() => '', e => String(e.message));
  assert.match(err, /沒有進行中的記憶草稿請求/);
  assert.match(err, /請使用者在對話視窗按「儲存這段記憶」/);
  // 請求還掛著但回合已經不在:拒收並清掉
  talk(s, 150, 10);
  live.active = true;
  await s.svc.request('n1');
  live.active = false;
  await assert.rejects(s.svc.submit('n1', { kind: 'preference', title: 't', content: 'c' }), /沒有進行中的記憶草稿請求/);
  assert.equal(s.svc.hasPending('n1'), false);
  // 沒有接上 draftActive 時退回用 30 分鐘時限
  const t = mkSvc();
  talk(t);
  await t.svc.request('n1');
  t.clock.now = new Date(t.clock.now.getTime() + DRAFT_RETRY_MS + 1000);
  await assert.rejects(t.svc.submit('n1', { kind: 'preference', title: 't', content: 'c' }), /沒有進行中的記憶草稿請求/);
  assert.equal(t.svc.hasPending('n1'), false);
});

test('parseDraft:參數檢查與別名', () => {
  assert.throws(() => parseDraft({}), /需要 kind/);
  assert.throws(() => parseDraft({ kind: 'case', title: 't', content: 'c' }), /需要 kind/);
  assert.throws(() => parseDraft({ kind: 'knowledge', title: 't', content: 'c', subtype: '亂寫' }), /subtype/);
  assert.throws(() => parseDraft({ kind: 'preference', title: 't', content: 'c', subtype: 'decision' }), /knowledge/);
  const d = parseDraft({ kind: '知識', title: '  很長的  標題 ', content: 'c', subtype: 'bookmark', supersedes: '[[a/b.md]]' });
  assert.deepEqual(d, { kind: 'knowledge', title: '很長的 標題', content: 'c', subtype: '書籤', supersedes: 'a/b.md' });
});

test('草稿提示詞:英文參數名稱、說明單一作者與誰說的、帶對話片段', () => {
  const p = formatDraftPrompt({ nodeName: '甲號', segment: '使用者:你好', project: 'demo' });
  for (const k of ['kind', 'title', 'content', 'subtype', 'supersedes', 'memory_draft', '單一作者', '誰說的']) assert.ok(p.includes(k), k);
  assert.ok(p.includes('使用者:你好'));
});

// ---- 子類與取代
test('entryFromFile:子類(決策、書籤、英文別名)、取代去掉 [[ ]]、狀態未完', () => {
  const mk = extra => `---\n種類: knowledge\n專案: demo\n${extra}---\n# 標題\n內容`;
  const a = entryFromFile('knowledge/demo/a.md', mk('子類: 決策\n取代: "[[knowledge/demo/old.md]]"\n'), 1, 1);
  assert.equal(a.subtype, '決策');
  assert.equal(a.supersedes, 'knowledge/demo/old.md');
  const b = entryFromFile('knowledge/demo/b.md', mk('子類: 書籤\n狀態: 未完\n'), 1, 1);
  assert.equal(b.subtype, '書籤');
  assert.equal(b.status, '未完');
  assert.equal(b.supersedes, '');
  assert.equal(entryFromFile('knowledge/demo/c.md', mk('subtype: bookmark\n'), 1, 1).subtype, '書籤');
  assert.equal(entryFromFile('knowledge/demo/d.md', mk('取代: [[x.md]]\n'), 1, 1).supersedes, 'x.md');
  const none = entryFromFile('knowledge/demo/e.md', mk(''), 1, 1);
  assert.equal(none.subtype, '');
  assert.equal(none.supersedes, '');
});

// ---- 判例:摘要與回顧
const sub = (extra = {}) => ({ title: '登入逾時其實是時區造成', keywords: ['登入'], facts: '登入一直逾時。', conclusion: '改用 UTC 計算。同時調整了設定檔。', ...extra });

test('判例:摘要沒填時取結論的第一句,寫在標題正下方', () => {
  const p = parseSubmission(sub());
  assert.equal(p.summary, '改用 UTC 計算。');
  assert.equal(p.review, '');
  const body = buildCaseBody('2026-0002', p.sections, p.summary, p.review);
  const lines = body.split('\n');
  assert.equal(lines[0], '# 解法第 2026-0002 號');
  assert.equal(lines[2], '摘要:改用 UTC 計算。');
  assert.ok(!body.includes('## 回顧'));
});

test('判例:自己填的摘要與回顧,回顧是最後一段(在參照先例之後)', () => {
  const p = parseSubmission(sub({ summary: '時區不一致,統一用 UTC', review: '一開始誤以為是網路問題,使用者提醒只有晚上發生才找到時區。', precedents: '[[2026-0001]]' }));
  assert.equal(p.summary, '時區不一致,統一用 UTC');
  const body = buildCaseBody('2026-0002', p.sections, p.summary, p.review);
  const heads = body.split('\n').filter(l => /^## /.test(l));
  assert.deepEqual(heads, ['## 事實經過', '## 爭點', '## 處理經過', '## 結論', '## 理由', '## 適用範圍', '## 參照先例', '## 回顧']);
  assert.ok(body.trimEnd().endsWith('才找到時區。'));
  assert.ok(body.split('\n')[2].startsWith('摘要:時區'));
});

test('firstSentence:到句號、驚嘆號或換行為止,太長截斷,忽略開頭的標記符號', () => {
  assert.equal(firstSentence('改用 UTC。其他'), '改用 UTC。');
  assert.equal(firstSentence('- 改設定\n再來'), '改設定');
  assert.equal(firstSentence('x'.repeat(500)).length, 120);
  assert.equal(firstSentence(''), '');
});

// ---- 封存:回顧
test('splitReview:從回覆分出「## 回顧」,沒有就整段是總結', () => {
  const r = splitReview('1. 習慣先讀再改\n2. 常用 grep\n\n## 回顧\n使用者多次要求先寫測試。我後來照做。');
  assert.equal(r.summary, '1. 習慣先讀再改\n2. 常用 grep');
  assert.equal(r.review, '使用者多次要求先寫測試。我後來照做。');
  assert.deepEqual(splitReview('只有總結'), { summary: '只有總結', review: '' });
  assert.equal(splitReview('總結\n回顧:一句話').review, '一句話');
  assert.equal(splitReview('總結\n**回顧**\n一句話').review, '一句話');
});

test('封存:回顧是最後一段(在判例之後);沒有回顧就沒有這一段;提示詞要求回顧與單一作者', () => {
  const T0 = new Date(2026, 10, 20, 9, 0).getTime();
  const node = { id: 'n1', name: 'Hagemi', backend: 'claude', backendLabel: 'Claude Code', model: 'sonnet', character: '', createdAt: T0 };
  const base = { node, stats: computeNodeStats([]).get('n1'), tasks: [], traits: '擅長重構', summary: '先讀再改', summarySource: '節點自己', noSummaryReason: '', cases: ['2026-0003'], now: new Date(2026, 10, 21, 15, 30) };
  const withReview = buildArchive({ ...base, review: '使用者要求先寫測試,我照做。' }).body;
  const heads = withReview.split('\n').filter(l => /^## /.test(l));
  assert.deepEqual(heads, ['## 基本資料', '## 特長', '## 任務紀錄', '## 解決問題的流程', '## 判例', '## 回顧']);
  assert.ok(withReview.trimEnd().endsWith('我照做。'));
  assert.ok(!buildArchive(base).body.includes('## 回顧'));
  assert.ok(!buildArchive({ ...base, review: '  ' }).body.includes('## 回顧'));
  for (const p of [SELF_SUMMARY_PROMPT, chiefSummaryPrompt('Hagemi', ['任務'], ['回覆'])]) {
    assert.ok(p.includes('## 回顧') && p.includes('2 到 3 句') && p.includes('單一作者') && p.includes('誰說了什麼'), p.slice(0, 20));
  }
});

// ---- 新來源 draft
test('來源 draft:不算工作任務、不列入節點統計、不是判例候選', () => {
  const t = (source, id) => ({ id, agentId: 'n1', agentName: 'H', backend: 'claude', model: '', title: id, status: 'done', note: '', steps: [], subs: [], startedAt: 1000, endedAt: 2000, source });
  assert.equal(isWorkTask(t('draft', 'a')), false);
  assert.equal(isWorkTask(t('desktop', 'b')), true);
  assert.equal(isWorkTask(t('case', 'c')), false);
  assert.equal(isWorkTask(t('archive', 'd')), false);
  assert.equal(computeNodeStats([t('draft', 'a'), t('desktop', 'b')], isWorkTask).get('n1').tasks, 1);
  assert.equal(notCandidateReason(t('draft', 'a')), '來源不列入判例候選');
});

for (const [name, fn] of tests) {
  await fn();
  passed++;
  console.log('[ok]', name);
}
console.log(`通過 ${passed} 項`);
