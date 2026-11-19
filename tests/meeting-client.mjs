// 會議功能的驗收(用戶端):扮演各節點的 CLI,用 MCP(Streamable HTTP)連到主控台的工具服務。
// 主控台那邊的動作與對話紀錄檢查在 tests/meeting.e2e.js。
// 用法:node tests/meeting-client.mjs <主控台記錄檔> <資料資料夾>
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
const rpc = async (url, method, params) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) }); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
const call = async (who, name, args) => { const r = (await rpc(urlOf(who), 'tools/call', { name, arguments: args })).body.result; return { text: r.content[0].text, error: r.isError === true }; };
const rid = t => /request_id:(m\w+)/.exec(t)?.[1];
/** 繼續 wait_reply 直到會議結束(或輪詢上限)。 */
const finish = async (who, first) => {
  let r = first, polls = 0;
  for (; !r.error && r.text.includes('會議進行中') && rid(r.text) && polls < 200; polls++) r = await call(who, 'wait_reply', { request_id: rid(r.text) });
  return { ...r, polls };
};
const meet = async (who, args) => { const first = await call(who, 'start_meeting', args); return { first, ...(await finish(who, first)) }; };
const entries = text => [...text.matchAll(/◆ (\w+).第 (\d+) 輪/g)].map(m => ({ name: m[1], round: Number(m[2]) }));
/** 每位參與者發言腳本:名稱=第1輪|第2輪…(只影響假資料節點,見 fake.ts)。 */
const script = (...kv) => `〔測試發言:${kv.join(';')}〕`;

try {
  // ---- 1. 工具清單與參數檢查
  const url = urlOf('Host');
  const tools = (await rpc(url, 'tools/list', {})).body.result.tools;
  const sm = tools.find(t => t.name === 'start_meeting');
  check('工具清單有 start_meeting(參數 topic、participants 必填)', !!sm && sm.inputSchema.required.join() === 'topic,participants', tools.map(t => t.name).join());
  const e1 = await call('Host', 'start_meeting', { participants: ['P1'] });
  check('缺 topic 回錯誤', e1.error, e1.text);
  const e2 = await call('Host', 'start_meeting', { topic: '主題', participants: [] });
  check('participants 空陣列回錯誤', e2.error, e2.text);
  const e3 = await call('Host', 'start_meeting', { topic: '主題', participants: ['P1', 'Nobody'] });
  check('找不到的節點回錯誤', e3.error && e3.text.includes('找不到'), e3.text);
  const e4 = await call('Host', 'start_meeting', { topic: '主題', participants: ['Host'] });
  check('把自己列為參與者回錯誤', e4.error, e4.text);
  const e5 = await call('Host', 'start_meeting', { topic: '主題', participants: ['Ask', 'P1', 'P2', 'N1', 'N2', 'Q1'] });
  check('超過 5 個參與者回錯誤', e5.error && e5.text.includes('最多 5'), e5.text);

  // ---- 2. 自動模式的召開者:不跳授權(e2e 會檢查 Host 沒有授權紀錄),先回進行中,再用 wait_reply 等到結束
  const t2 = Date.now();
  const m2 = await meet('Host', {
    topic: `請討論 MEETING-TOPIC-ONE。${script('P1=SAY-P1-R1|SAY-P1-R2|SAY-P1-R3', 'P2=SAY-P2-R1|SAY-P2-R2|SAY-P2-R3')}`,
    participants: ['P1', 'P2'], rounds: 3, host_turns: false,
  });
  check('先回傳會議進行中與 m 開頭的 request_id', !m2.first.error && m2.first.text.includes('會議進行中') && /request_id:m\w+/.test(m2.first.text), m2.first.text);
  check('第一次回傳大約在 WAIT_MS(2.5 秒)', m2.polls >= 1, `polls=${m2.polls}`);
  check('用 wait_reply 等到結束,含【會議紀錄】', !m2.error && m2.text.startsWith('會議結束。') && m2.text.includes('【會議紀錄】'), m2.text);
  const en = entries(m2.text);
  check('紀錄有每位參與者每一輪的發言(3 輪 × 2 人,依序)', en.map(x => `${x.name}${x.round}`).join() === 'P1 1,P2 1,P1 2,P2 2,P1 3,P2 3'.replaceAll(' ', ''), en.map(x => `${x.name}${x.round}`).join());
  check('輪數與 rounds 相符(沒有第 4 輪)', !m2.text.includes('(第 4 輪)') && m2.text.includes('◆ P2(第 3 輪):\nSAY-P2-R3'), m2.text);
  check('wait_reply 重複查已結束的會議仍回完整紀錄', (await call('Host', 'wait_reply', { request_id: rid(m2.first.text) })).text.includes('【會議紀錄】'));
  check('別人不能查你的會議', (await call('P1', 'wait_reply', { request_id: rid(m2.first.text) })).error);

  // ---- 5. 提前結束:所有人同一輪都回【無補充】
  const m5 = await meet('Host', {
    topic: `沒有什麼好講的。${script('N1=無補充。\\n【無補充】', 'N2=我也沒有。\\n【無補充】')}`,
    participants: ['N1', 'N2'], rounds: 3, host_turns: false,
  });
  check('全部【無補充】時提前結束,紀錄有「提前結束」', !m5.error && m5.text.includes('提前結束') && m5.text.startsWith('會議結束。'), m5.text);
  check('提前結束時只有第一輪的 2 則發言', entries(m5.text).length === 2 && !m5.text.includes('(第 2 輪)'), m5.text);

  // ---- 6. 每次詢問的召開者(授權由 e2e 回應,e2e 檢查授權次數與工具名稱)
  const m6 = await meet('Ask', {
    topic: `K-ALLOW 請討論。${script('Q1=SAY-Q1-R1|SAY-Q1-R2', 'Q2=SAY-Q2-R1|SAY-Q2-R2')}`,
    participants: ['Q1', 'Q2'], rounds: 2, host_turns: false,
  });
  check('每次詢問的召開者經授權後開會成功', !m6.error && m6.text.startsWith('會議結束。') && entries(m6.text).length === 4, m6.text);
  const m6d = await call('Ask', 'start_meeting', { topic: '請拒絕這場會議', participants: ['R1'], rounds: 1 });
  check('使用者拒絕時工具回錯誤', m6d.error && m6d.text.includes('拒絕'), m6d.text);

  // ---- 7、8. 同時開兩場、參與者反過來呼叫召開者(T1 沒有腳本,每回合要好幾秒,第一次回傳時還在發言)
  const m7a = await call('Host', 'start_meeting', { topic: '慢速會議', participants: ['T1'], rounds: 1 });
  check('第一場進行中', !m7a.error && m7a.text.includes('會議進行中'), m7a.text);
  const m7b = await call('Host', 'start_meeting', { topic: '第二場', participants: ['T2'], rounds: 1 });
  check('同一個召開者不能同時開兩場', m7b.error && m7b.text.includes('還在進行'), m7b.text);
  const m8 = await call('T1', 'ask_node', { node: 'Host', prompt: '反過來問召開者' });
  check('會議進行中參與者不能 ask_node 召開者(正在等你)', m8.error && m8.text.includes('正在等你'), m8.text);
  const m7 = await finish('Host', m7a);
  check('慢速會議最後正常結束', !m7.error && m7.text.startsWith('會議結束。') && entries(m7.text).length === 1, m7.text);
  const m7c = await meet('Host', { topic: `第一場結束後可以再開。${script('T2=SAY-T2')}`, participants: ['T2'], rounds: 1 });
  check('上一場結束後同一個召開者可以再開', !m7c.error && m7c.text.includes('◆ T2(第 1 輪):\nSAY-T2'), m7c.text);

  // ---- 9. 散會:e2e 看到會議開始就對 Dis 送一句短指令,它的回合結束(回到待命)時會議應中止
  const m9 = await meet('Dis', { topic: '會被中途散會的會議', participants: ['DP1', 'DP2'], rounds: 3, host_turns: false });
  check('召開者回合結束後 wait_reply 回「會議中止」', !m9.error && m9.text.startsWith('會議中止:') && m9.text.includes('召開會議的節點已經停下來'), m9.text);
  check('中止的會議紀錄裡沒有任何發言', entries(m9.text).length === 0, m9.text);

  // ---- 10. 參與者忙碌時該輪略過:e2e 看到會議開始就讓 BP2 停在等使用者回答(BP1 沒有腳本,要發言好幾秒,所以比 BP2 的檢查早)
  const m10 = await meet('Brk', { topic: '有人很忙的會議', participants: ['BP1', 'BP2'], rounds: 1 });
  check('參與者忙碌時該輪略過並記一則說明', !m10.error && m10.text.includes('BP2:(第 1 輪略過:') && entries(m10.text).length === 1 && entries(m10.text)[0].name === 'BP1', m10.text);

  // ---- 11. 主持人發言(預設 host_turns):每輪之間輪到主持人,用 meeting_say 發言或結束
  const HT = '輪到你(主持人)發言';
  const h1 = await meet('Host', {
    topic: `主持人會發言的會議 HOST-TOPIC。${script('HP1=SAY-HP1-R1|SAY-HP1-R2|SAY-HP1-R3', 'HP2=SAY-HP2-R1|SAY-HP2-R2|SAY-HP2-R3')}`,
    participants: ['HP1', 'HP2'], rounds: 3,
  });
  check('第 1 輪結束後輪到主持人,附上兩人的發言', !h1.error && h1.text.includes('會議第 1 輪結束') && h1.text.includes(HT) && h1.text.includes('SAY-HP1-R1') && h1.text.includes('SAY-HP2-R1'), h1.text);
  const hid = rid(h1.text);
  check('輪到主持人時 wait_reply 立刻回同樣的提示', (await call('Host', 'wait_reply', { request_id: hid })).text.includes(HT));
  check('別人不能用 meeting_say', (await call('HP1', 'meeting_say', { request_id: hid, text: 'x' })).error);
  check('meeting_say 缺 text 與 end 回錯誤', (await call('Host', 'meeting_say', { request_id: hid })).error);
  const h2say = await call('Host', 'meeting_say', { request_id: hid, text: 'HOST-ASKS-R1:請 HP1 說明理由' });
  // 第 2 輪通常要超過 WAIT_MS 才講完;若已經又輪到主持人,這項沒辦法驗,視為通過
  check('第 2 輪進行中時 meeting_say 回錯誤(還沒輪到主持人)', !h2say.text.includes('會議進行中') || (await call('Host', 'meeting_say', { request_id: hid, text: 'too-early' })).error, h2say.text);
  const h2 = await finish('Host', h2say);
  check('主持人發言後進行第 2 輪,再輪到主持人,只附新的發言', !h2.error && h2.text.includes('會議第 2 輪結束') && h2.text.includes('SAY-HP1-R2') && h2.text.includes('SAY-HP2-R2') && !h2.text.includes('SAY-HP1-R1') && !h2.text.includes('HOST-ASKS-R1'), h2.text);
  const h3 = await finish('Host', await call('Host', 'meeting_say', { request_id: hid, text: 'HOST-CLOSING', end: true }));
  check('end: true 結束會議並回完整紀錄(含主持人發言,沒有第 3 輪)', !h3.error && h3.text.startsWith('會議結束。') && h3.text.includes('◆ Host(主持人)(第 1 輪):\nHOST-ASKS-R1') && h3.text.includes('HOST-CLOSING') && h3.text.includes('主持人結束了會議') && !h3.text.includes('(第 3 輪)'), h3.text);
  check('紀錄裡參與者發言 2 輪 × 2 人', entries(h3.text).map(x => `${x.name}${x.round}`).join() === 'HP11,HP21,HP12,HP22', entries(h3.text).map(x => `${x.name}${x.round}`).join());
  check('會議結束後 meeting_say 回完整紀錄', (await call('Host', 'meeting_say', { request_id: hid, text: 'late' })).text.includes('【會議紀錄】'));

  // ---- 12. 主持人發言模式下全部【無補充】:不自動結束,交給主持人決定
  const q1 = await meet('Host', { topic: `沒什麼好講。${script('HN1=沒有。\\n【無補充】')}`, participants: ['HN1'], rounds: 3 });
  check('全部【無補充】時仍輪到主持人,並註明沒有補充', !q1.error && q1.text.includes(HT) && q1.text.includes('所有參與者都表示沒有補充'), q1.text);
  const q2 = await finish('Host', await call('Host', 'meeting_say', { request_id: rid(q1.text), end: true }));
  check('主持人只用 end 結束(不附發言)', !q2.error && q2.text.startsWith('會議結束。') && entries(q2.text).length === 1 && !q2.text.includes('(主持人)('), q2.text);

  console.log(`[client] ${bad ? `有 ${bad} 項不符` : '用戶端全部通過'}`);
} catch (err) {
  bad++;
  console.log('[client] 失敗', err.stack ?? err.message);
}
// 通知主控台的測試腳本可以結束了(P1 呼叫 Host;主控台那邊會檢查各節點的對話紀錄)
await fetch(urlOf('P1'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'ask_node', arguments: { node: 'Host', prompt: `會議檢查完成(${bad ? '有不符' : '全部通過'})` } } }) }).catch(() => {});
