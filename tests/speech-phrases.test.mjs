// 驗收:英文語音播報的台詞、翻譯防呆與聲音退回順序(src/shared/speech-phrases.ts,純函式)。
// 用法:在 app 資料夾執行 node tests/speech-phrases.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { applyPronounce, EN_DONE_FALLBACK, englishSummary, normalizePronounce, hasHan, normalizeSpeechLang, riskyForTranslation, speechCharacters, speechPhrase, translationLooksOk } from '../src/shared/speech-phrases.ts';

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const base = { agentId: 'a', agentName: '小銀龍', ts: 0 };

test('中文台詞與原本相同', () => {
  assert.equal(speechPhrase({ ...base, kind: 'done', taskId: 't', summary: '已修好登入頁' }), '小銀龍:已修好登入頁');
  assert.equal(speechPhrase({ ...base, kind: 'done', taskId: 't', summary: null }), '小銀龍 完成了,詳情請看畫面。');
  assert.equal(speechPhrase({ ...base, kind: 'approval', requestId: 'r' }, 'zh'), '小銀龍 在等你授權,請到畫面確認。');
  assert.equal(speechPhrase({ ...base, kind: 'failed', reason: 'lost', queuePaused: true }), '小銀龍 失去連線,排隊的指令已暫停。');
});

test('英文台詞:開頭「I’m <節點名稱>.」再接摘要或狀況,摘要不能用時念固定句', () => {
  assert.equal(EN_DONE_FALLBACK, 'Task complete. Please review the details on screen.');
  assert.equal(speechPhrase({ ...base, kind: 'done', taskId: 't', summary: null }, 'en'), `I'm 小銀龍. ${EN_DONE_FALLBACK}`);
  assert.equal(speechPhrase({ ...base, agentName: 'claudia jr', kind: 'done', taskId: 't', summary: 'Fixed the login page.' }, 'en'), "I'm claudia jr. Fixed the login page.");
  assert.equal(speechPhrase({ ...base, kind: 'approval', requestId: 'r' }, 'en'), "I'm 小銀龍. I'm waiting for your approval. Please check the screen.");
  assert.equal(speechPhrase({ ...base, kind: 'question', requestId: 'r' }, 'en'), "I'm 小銀龍. I have a question for you. Please answer on screen.");
  assert.equal(speechPhrase({ ...base, kind: 'failed', reason: 'error', queuePaused: true }, 'en'), "I'm 小銀龍. I ran into an error, and the queued prompts are paused.");
  assert.equal(speechPhrase({ ...base, kind: 'failed', reason: 'lost', queuePaused: false }, 'en'), "I'm 小銀龍. I lost my connection.");
  assert.equal(speechPhrase({ ...base, kind: 'failed', reason: 'quota', queuePaused: true }, 'en'), "I'm 小銀龍. I'm out of usage quota, so the queued prompts are paused.");
  // 每日預算不屬於任何節點:不自我介紹,只念後台名稱
  assert.equal(speechPhrase({ ...base, agentName: 'Codex', kind: 'failed', reason: 'budget', queuePaused: false }, 'en'), "Codex has gone over today's budget.");
  // 除了節點名稱以外沒有中文
  for (const n of [{ kind: 'done', taskId: 't', summary: null }, { kind: 'approval', requestId: 'r' }, { kind: 'question', requestId: 'r' }, { kind: 'failed', reason: 'error', queuePaused: true }, { kind: 'failed', reason: 'lost', queuePaused: true }, { kind: 'failed', reason: 'quota', queuePaused: true }]) {
    const said = speechPhrase({ ...base, agentName: 'Node', ...n }, 'en');
    assert.ok(!hasHan(said) && said.startsWith("I'm Node. "), said);
  }
});

test('播報語言只接受 zh、en', () => {
  assert.equal(normalizeSpeechLang('en'), 'en');
  for (const v of ['zh', 'EN', 'fr', undefined, null, 1]) assert.equal(normalizeSpeechLang(v), 'zh');
});

test('原文只擋容易被漏翻的否定與禁止詞', () => {
  for (const s of ['請勿部署到正式環境', '測試未通過', '不要合併', '不能推送', '測試不通過', '沒有找到問題', '禁止推送', '無法連線', '還沒完成', '除非先備份', '別刪掉', '非必要']) assert.ok(riskyForTranslation(s), s);
  // 放寬:聊天語氣的「不對」「不錯」、本身就是負面結果的詞(交給譯文檢查)、「非常」都可以翻
  for (const s of ['已修好登入頁的排版', '新增三個單元測試', '整理了 README', '聽完覺得哪裡不對再告訴我', '效果不錯', '已修好登入頁的錯字', '建置失敗', '已取消這次合併', '可以合併但要先測', '非常順利']) assert.ok(!riskyForTranslation(s), s);
});

test('翻譯結果的防呆:中文、特殊記號、數字對不上、重複、太長都擋下', () => {
  assert.ok(translationLooksOk('新增 3 個測試', 'Added 3 tests.'));
  assert.ok(!translationLooksOk('新增 3 個測試', 'Added three tests.'), '數字不見');
  assert.ok(!translationLooksOk('新增測試', '新增 tests'), '還有中文');
  assert.ok(!translationLooksOk('新增測試', 'Added <unk> tests'), '特殊記號');
  assert.ok(!translationLooksOk('新增測試', '▁Added tests'), 'sentencepiece 記號');
  assert.ok(!translationLooksOk('新增測試', ''), '空白');
  assert.ok(!translationLooksOk('新增測試', '...'), '沒有英文字');
  assert.ok(!translationLooksOk('新增測試', 'test test test test test'), '重複');
  assert.ok(!translationLooksOk('新增測試', 'a'.repeat(401)), '太長');
  assert.ok(translationLooksOk('版本 1.3.0 已發布,時間 3:30', 'Version 1.3.0 was released at 3:30.'));
  // 原文沒有否定,譯文卻出現否定或負面結果:模型自己加的,不能念
  for (const bad of ['The tests did not pass.', "Don't deploy.", 'The build failed.', 'Deploy without review.', 'No changes were made.', 'The merge was cancelled.']) assert.ok(!translationLooksOk('已部署到正式環境', bad), bad);
  // 原文是負面結果:譯文帶 error、fail、cancel 一律不念
  assert.ok(!translationLooksOk('建置失敗', 'The build failed.'));
  assert.ok(!translationLooksOk('已修好錯誤', 'Fixed the error.'));
  // 原文有放行的「不」:譯文要有否定,漏掉就是翻反
  assert.ok(translationLooksOk('聽完覺得哪裡不對再告訴我', "Tell me if anything is wrong after you listen."));
  assert.ok(!translationLooksOk('聽完覺得哪裡不對再告訴我', 'Tell me after you listen.'), '漏翻否定');
  // 原文的英文字要留在譯文裡(不分大小寫):整段翻譯漏掉名字的情況擋下
  const hz = '連主控台的角色卡也正式正名成 hagemi 了,聽起來超讚的對吧~';
  assert.ok(translationLooksOk(hz, 'Even the role card of the Console is officially called Hagemi. That sounds awesome, right?'));
  assert.ok(!translationLooksOk(hz, 'Even the role card of the Constabulary is officially well-known.'), '名字不見了');
  assert.ok(translationLooksOk('整理了 README 的安裝步驟', 'Set up installation steps for README'));
  assert.ok(!translationLooksOk('整理了 README 的安裝步驟', 'Organized the installation steps'), 'README 不見了');
  // 「A 不 A」是問句,不是否定:譯文不必有否定,也不會被當成「不要」擋下
  const q = '如果你現在聽得到我的聲音,可以留意一下語速、斷句和停頓自不自然。';
  assert.ok(!riskyForTranslation(q));
  assert.ok(translationLooksOk(q, 'If you can hear my voice now, you can keep an eye on speed, break and pause.'));
  assert.ok(!riskyForTranslation('要不要先合併'), '要不要不是不要');
  assert.ok(riskyForTranslation('不要合併'), '真正的不要仍然擋');
  assert.ok(!translationLooksOk('新增 ３ 個測試', 'Added tests.'), '全形數字也要比對');
  assert.ok(translationLooksOk('新增 ３ 個測試', 'Added 3 tests.'));
  assert.ok(!translationLooksOk('新增三個測試', 'Added three tests.'), '中文數字寫的數量不翻');
});

test('念法表:整理、替換節點名稱與摘要裡的名稱', () => {
  const list = normalizePronounce([
    { name: ' claudia jr ', zh: '克勞迪婭', en: 'Claudia Junior' },
    { name: '小銀龍', zh: '', en: 'Little Silver Dragon' },
    { name: '空的', zh: '', en: '' },
    { name: '', zh: 'x', en: 'y' },
    { name: 'CLAUDIA JR', zh: '克勞迪婭', en: 'Claudia Junior' },
    'bad',
  ]);
  assert.deepEqual(list.map(p => p.name), ['小銀龍', 'CLAUDIA JR'], '去掉空的與重複(不分大小寫,以後面的為準)');
  assert.equal(applyPronounce("I'm claudia jr. Done.", list, 'en'), "I'm Claudia Junior. Done.");
  assert.equal(applyPronounce('claudia jr 完成了', list, 'zh'), '克勞迪婭 完成了');
  assert.equal(applyPronounce('小銀龍:已修好排版', list, 'en'), 'Little Silver Dragon:已修好排版', '英文時中文名稱在翻譯之前換掉');
  assert.equal(applyPronounce('小銀龍 完成了', list, 'zh'), '小銀龍 完成了', '中文念法留白就照原名');
  assert.equal(applyPronounce('claudia jrx is here', list, 'en'), 'claudia jrx is here', '英文名稱只在單字邊界替換');
  // 長的名稱先換:「claude」與「claude code」同時存在時不會只換掉前半
  const two = normalizePronounce([{ name: 'claude', zh: '', en: 'Clawed' }, { name: 'claude code', zh: '', en: 'Clawed Code' }]);
  assert.equal(applyPronounce('claude code and claude', two, 'en'), 'Clawed Code and Clawed');
  // 名稱裡的特殊字元照字面比對
  assert.equal(applyPronounce('a.b(c) ok', normalizePronounce([{ name: 'a.b(c)', zh: '', en: 'ABC' }]), 'en'), 'ABC ok');
  assert.equal(normalizePronounce(Array.from({ length: 150 }, (_, i) => ({ name: `n${i}`, zh: 'x', en: '' }))).length, 100, '最多 100 筆');
});

test('聲音的退回順序:中文維持原本的行為,英文是節點 → 總管', () => {
  assert.deepEqual(speechCharacters({ own: 'claude', chief: 'gemini' }, 'zh'), ['claude']);
  assert.deepEqual(speechCharacters({ own: null, chief: 'gemini' }, 'zh'), ['gemini']);
  assert.deepEqual(speechCharacters({ own: null, chief: null }, 'zh'), []);
  assert.deepEqual(speechCharacters({ own: 'claude', chief: 'gemini' }, 'en'), ['claude', 'gemini']);
  assert.deepEqual(speechCharacters({ own: 'gemini', chief: 'gemini' }, 'en'), ['gemini']);
  assert.deepEqual(speechCharacters({ own: null, chief: 'gemini' }, 'en'), ['gemini']);
  assert.deepEqual(speechCharacters({ own: null, chief: null }, 'en'), []);
});

test('英文摘要:英文照用、中文翻譯後通過防呆才用,其他情況是 null', async () => {
  let calls = 0;
  const ok = async () => { calls++; return 'Fixed the layout of the login page.'; };
  assert.equal(await englishSummary('Fixed the login page.', ok), 'Fixed the login page.');
  assert.equal(calls, 0, '本來就是英文不必翻');
  assert.equal(await englishSummary('已修好登入頁的排版', ok), 'Fixed the layout of the login page.');
  assert.equal(await englishSummary(null, ok), null);
  assert.equal(await englishSummary('   ', ok), null);
  calls = 0;
  assert.equal(await englishSummary('請勿部署', ok), null, '否定詞不翻');
  assert.equal(calls, 0, '有否定詞時根本不送去翻譯');
  assert.equal(await englishSummary('新增 3 個測試', async () => 'Added tests.'), null, '數字不見');
  assert.equal(await englishSummary('已修好登入頁', async () => null), null, '沒有翻譯模型');
  assert.equal(await englishSummary('已修好登入頁', async () => { throw new Error('x'); }), null, '翻譯出錯');
  const t0 = Date.now();
  assert.equal(await englishSummary('已修好登入頁', () => new Promise(r => setTimeout(() => r('Fixed.'), 2000)), 100), null, '逾時');
  assert.ok(Date.now() - t0 < 1000, '逾時就不再等');
});

for (const [name, fn] of tests) { await fn(); passed++; console.log('[ok]', name); }
console.log(`\n${passed} 項通過`);
