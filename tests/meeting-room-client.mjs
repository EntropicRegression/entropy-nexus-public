// 會議室虛擬節點的驗收(用戶端):扮演節點的 CLI,用 MCP 連到主控台的工具服務開會、讓主持人發言與散會。
// 主面板與旁聽視窗的檢查在 tests/meeting-room.e2e.js;每個階段等主控台那邊在記錄檔印出「GO n」(檢查完了)才往下走。
// 用法:node tests/meeting-room-client.mjs <主控台記錄檔> <資料資料夾>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [logFile, dataDir] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (what, ok, extra = '') => { if (!ok) bad++; console.log(`[client] ${ok ? '通過' : '不符'} ${what}${ok || !extra ? '' : ` → ${String(extra).slice(0, 400)}`}`); };

let id = null;
for (let i = 0; i < 200 && !id; i++) { const m = /\[test\] READY (\{.*\})/.exec(readFileSync(logFile, 'utf8')); if (m) id = JSON.parse(m[1]); else await wait(300); }
if (!id) { console.log('[client] 失敗 等不到主控台'); process.exit(1); }
const urlOf = n => JSON.parse(readFileSync(join(dataDir, 'interop', `${id[n]}.json`), 'utf8')).mcpServers.nexus.url;
let seq = 0;
const rpc = async (url, method, params) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) }); return r.status === 200 ? await r.json() : null; };
const call = async (who, name, args) => { const r = (await rpc(urlOf(who), 'tools/call', { name, arguments: args })).result; return { text: r.content[0].text, error: r.isError === true }; };
const rid = t => /request_id:(m\w+)/.exec(t)?.[1];
const HT = '輪到你(主持人)發言';
/** 繼續 wait_reply,直到輪到主持人或會議結束。 */
const settle = async (who, first) => {
  let r = first;
  for (let i = 0; !r.error && r.text.includes('會議進行中') && !r.text.includes(HT) && rid(r.text) && i < 120; i++) r = await call(who, 'wait_reply', { request_id: rid(r.text) });
  return r;
};
/** 等主控台那邊檢查完第 n 階段。 */
const go = async n => {
  for (let i = 0; i < 400; i++) { if (readFileSync(logFile, 'utf8').includes(`[test] GO ${n}`)) return true; await wait(250); }
  console.log(`[client] 等不到主控台的 GO ${n}`);
  return false;
};
const script = (...kv) => `〔測試發言:${kv.join(';')}〕`;

try {
  // ---- 1. 同時開兩場會(3 輪與 2 輪、主持人每輪之間發言),各自停在「輪到主持人」
  const [a0, b0] = await Promise.all([
    call('Host', 'start_meeting', { topic: `會議室驗收 ROOM-A。${script('P1=SAY-P1-R1|SAY-P1-R2|SAY-P1-R3', 'P2=SAY-P2-R1|SAY-P2-R2|SAY-P2-R3')}`, participants: ['P1', 'P2'], rounds: 3 }),
    call('Host2', 'start_meeting', { topic: `第二間 ROOM-B。${script('Q1=SAY-Q1-R1|SAY-Q1-R2')}`, participants: ['Q1'], rounds: 2 }),
  ]);
  const ridA = rid(a0.text), ridB = rid(b0.text);
  const [a1, b1] = await Promise.all([settle('Host', a0), settle('Host2', b0)]);
  check('第一場第 1 輪結束後輪到主持人', !a1.error && a1.text.includes(HT), a1.text);
  check('第二場第 1 輪結束後輪到主持人', !b1.error && b1.text.includes(HT), b1.text);

  // ---- 2. 主持人發言,進行第 2 輪(主控台那邊看發言者與立繪切換),再停在輪到主持人
  if (await go(1)) {
    const a2 = await settle('Host', await call('Host', 'meeting_say', { request_id: ridA, text: 'HOST-R1:請兩位補充' }));
    check('主持人發言後跑完第 2 輪,又輪到主持人', !a2.error && a2.text.includes(HT) && a2.text.includes('SAY-P2-R2'), a2.text);
  }
  // ---- 3. 第一場散會(旁聽視窗開著),第二場繼續
  if (await go(2)) {
    const a3 = await settle('Host', await call('Host', 'meeting_say', { request_id: ridA, text: 'HOST-END-A', end: true }));
    check('第一場散會', !a3.error && a3.text.startsWith('會議結束。'), a3.text);
  }
  // ---- 4. 第二場也散會
  if (await go(3)) {
    const b3 = await settle('Host2', await call('Host2', 'meeting_say', { request_id: ridB, end: true }));
    check('第二場散會', !b3.error && b3.text.startsWith('會議結束。'), b3.text);
  }
  console.log(`[client] ${bad ? `有 ${bad} 項不符` : '用戶端全部通過'}`);
} catch (err) {
  bad++;
  console.log('[client] 失敗', err.stack ?? err.message);
}
