// 驗收:語音播報的規則摘要(src/shared/speech-summary.ts,純函式)。
// 用法:在 app 資料夾執行 node tests/voice-summary.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { MAX_UNITS, speechUnits, summarizeForSpeech } from '../src/shared/speech-summary.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const S = (...m) => summarizeForSpeech(m);

test('朗讀單位:中文一字 1、英文一詞 2、數字一組 1', () => {
  assert.equal(speechUnits('已修好'), 3);
  assert.equal(speechUnits('race condition'), 4);
  assert.equal(speechUnits('改了 3 個檔案'), 6);
});

test('短回覆直接念全文', () => {
  assert.equal(S('測試全部通過,沒有其他問題。'), '測試全部通過,沒有其他問題。');
});

test('拿掉客套收尾', () => {
  const out = S('已修好登入頁的錯誤。\n\n需要的話我可以再幫你跑一次完整測試。');
  assert.equal(out, '已修好登入頁的錯誤。');
});

test('不念完整路徑,只留檔名', () => {
  const out = S('已修改 C:\\Users\\USER\\Desktop\\entropy nexus public\\src\\main\\core.ts 和 src/renderer/src/App.tsx。');
  assert.ok(out && !/[\\/]/.test(out), out);
  assert.ok(out.includes('App.tsx'), out);
});

test('不念網址、程式碼區塊、表格、長識別符', () => {
  const out = S('已建立 PR:https://github.com/x/y/pull/12\n\n```ts\nconst a = 1;\n```\n\n| 檔案 | 變更 |\n|---|---|\n| a | b |\n\ncommit 9f2c3a1b4d5e6f708192a3b4c5d6e7f8091a2b3c 已推上。');
  assert.ok(out && !/https?:|const a|\||9f2c3a1b/.test(out), out);
});

test('長回覆優先念要使用者決定的事', () => {
  const long = '我檢查了整個佇列模組,包括排入、取出、暫停與恢復的流程,也看過資料庫的寫入時機與畫面的推送方式,整體結構大致清楚。\n\n'
    + '目前發現兩種修法,一種是在送出前鎖住佇列,另一種是改成每個節點各自一條佇列,兩者各有優缺點,影響範圍也不同。\n\n'
    + '請你選擇要用哪一種做法,我再開始修改。';
  const out = S(long);
  assert.ok(out?.includes('請你選擇要用哪一種做法'), out);
});

test('阻礙優先於成果', () => {
  const long = '我重新整理了設定面板的版面,把啟動指令與模型欄位分開,也補上了狀態說明與錯誤提示,畫面比原本清楚很多。\n\n'
    + '已經更新說明文件與 README。\n\n建置仍然失敗,錯誤出在型別檢查,我還沒找到原因。';
  const out = S(long);
  assert.ok(out?.includes('建置仍然失敗'), out);
});

test('「原本失敗,修正後已通過」整句保留,不會只念失敗', () => {
  const long = '這次花了不少時間追查問題,先後檢查了錄音、上傳、辨識與回填輸入框這幾段,每一段都加了記錄,最後確認是編碼設定的問題。\n\n'
    + '中間做過幾次嘗試,包括換掉取樣率與改用不同的音訊格式,但都沒有改善,所以才回頭看服務的輸出設定。\n\n'
    + '原本測試失敗,修正編碼後已全部通過。';
  const out = S(long);
  assert.ok(out?.includes('原本測試失敗,修正編碼後已全部通過'), out);
});

test('冒號帶出的清單收成一句「共 N 項」', () => {
  const long = '這個回合主要在整理語音模式的程式碼,也順手修了幾個之前發現的小問題,並重新跑過所有相關的驗收測試確認沒有退步。\n\n'
    + '已完成以下修改:\n- 新增播報佇列\n- 修正中斷時誤念\n- 補上單元測試';
  const out = S(long);
  assert.ok(out?.includes('已完成以下修改,共 3 項'), out);
});

test('最後一則沒有實質內容時改看倒數第二則', () => {
  assert.equal(S('已把 interop 的會議改成主持人可以發言。', '都改好了。'), '已把 interop 的會議改成主持人可以發言。');
});

test('只有程式碼或沒有可念的內容:回傳 null', () => {
  assert.equal(S('```js\nconsole.log(1)\n```'), null);
  assert.equal(S('好了'), null);
  assert.equal(S(''), null);
});

test('長回覆的摘要不超過上限', () => {
  const para = '這是一段很長的說明文字,用來確認摘要不會超過朗讀單位的上限,即使每一句都很長也一樣要控制在範圍內。';
  const out = S([para, para, para, para].join('\n\n'));
  assert.ok(out === null || speechUnits(out) <= MAX_UNITS, out);
});

test('中英夾雜的長回覆', () => {
  const long = 'I reviewed the adapter code and traced how the stream events are parsed, including the partial message deltas and the final result event.\n\n'
    + 'The root cause is that the interrupted turn still emits a normal idle state, so the console treats it as completed.\n\n'
    + 'Fixed the codex adapter so interrupted turns are reported correctly, and tests passed.';
  const out = S(long);
  assert.ok(out && /Fixed|tests passed/.test(out) && speechUnits(out) <= MAX_UNITS, out);
});

console.log(`[ok] 全部通過(${passed} 項)`);
