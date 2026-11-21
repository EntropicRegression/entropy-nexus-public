// 協作過程可視化的驗收(用戶端):扮演各節點的 CLI,用 MCP(Streamable HTTP)連到主控台的工具服務。
// 主控台那邊的取樣與檢查在 tests/collab.e2e.js;最後 Beta 呼叫 Alpha 一句「協作檢查完成」通知它可以開始檢查。
// 用法:node tests/collab-client.mjs <主控台記錄檔> <資料資料夾>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [logFile, dataDir] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (what, ok, extra = '') => { if (!ok) bad++; console.log(`[client] ${ok ? '通過' : '不符'} ${what}${ok || !extra ? '' : ` → ${String(extra).slice(0, 300)}`}`); };

let ids = null;
for (let i = 0; i < 200 && !ids; i++) { const m = /\[test\] READY (\S+) (\S+) (\S+)/.exec(readFileSync(logFile, 'utf8')); if (m) ids = m.slice(1); else await wait(300); }
if (!ids) { console.log('[client] 失敗 等不到主控台'); process.exit(1); }
const [A, B, C] = ids;
const urlOf = id => JSON.parse(readFileSync(join(dataDir, 'interop', `${id}.json`), 'utf8')).mcpServers.nexus.url;
let seq = 0;
const rpc = async (url, method, params) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) }); return { status: r.status, body: r.status === 200 ? await r.json() : null }; };
const call = async (id, name, args) => { const r = (await rpc(urlOf(id), 'tools/call', { name, arguments: args })).body.result; return { text: r.content[0].text, error: r.isError === true }; };
/** 工具先返回「還在執行」時照指示一直 wait_reply,直到拿到結果。 */
const finish = async (id, first) => {
  let r = first;
  for (let i = 0; i < 60 && !r.error && /還在執行|會議進行中/.test(r.text) && /request_id:(\w+)/.test(r.text); i++) r = await call(id, 'wait_reply', { request_id: /request_id:(\w+)/.exec(r.text)[1] });
  return r;
};

try {
  const r1 = await finish(A, await call(A, 'ask_node', { node: 'Beta', prompt: '請 Beta 看一下設計' }));
  check('Alpha 呼叫 Beta 拿到答覆', !r1.error && r1.text.includes('節點「Beta」的答覆'), r1.text);
  await wait(1500);
  const r2 = await finish(B, await call(B, 'ask_node', { node: 'Gamma', prompt: 'Beta 請 Gamma 提供意見' }));
  check('Beta 呼叫 Gamma 拿到答覆', !r2.error && r2.text.includes('節點「Gamma」的答覆'), r2.text);
  await wait(1500);
  const r3 = await finish(A, await call(A, 'start_meeting', { topic: '協作可視化的會議', participants: ['Beta', 'Gamma'], rounds: 1, host_turns: false }));
  check('Alpha 召開的會議結束並交回紀錄', !r3.error && r3.text.includes('會議紀錄'), r3.text);
  await wait(1500);
  console.log(`[client] ${bad ? `有 ${bad} 項不符` : '用戶端全部通過'}`);
} catch (err) {
  console.log('[client] 失敗', err.stack ?? err.message);
}
// 通知主控台的測試腳本可以開始檢查了(Beta 呼叫 Alpha)
await fetch(urlOf(B), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'ask_node', arguments: { node: 'Alpha', prompt: `協作檢查完成(${bad ? '有不符' : '全部通過'})` } } }) }).catch(() => {});
