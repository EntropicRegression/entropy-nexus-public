// 節點互相呼叫的驗收(用戶端):扮演各節點的 CLI,用 MCP(Streamable HTTP)連到主控台的工具服務。
// 網址從主控台寫在資料資料夾 interop/<節點 id>.json 的設定檔讀出(和主控台交給 Claude Code 的是同一份)。
// 用法:node tests/interop-client.mjs <主控台記錄檔> <資料資料夾>
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
/** ask_node 之後照工具的指示一直 wait_reply,直到拿到結果。 */
const ask = async (id, node, prompt) => {
  let r = await call(id, 'ask_node', { node, prompt });
  let rounds = 0;
  for (; !r.error && r.text.includes('還在執行') && /request_id:(\w+)/.test(r.text); rounds++) r = await call(id, 'wait_reply', { request_id: /request_id:(\w+)/.exec(r.text)[1] });
  return { ...r, rounds };
};

try {
  const url = urlOf(A);
  check('網址只在本機迴路', /^http:\/\/127\.0\.0\.1:\d+\/mcp\/[0-9a-f]{48}$/.test(url), url);
  const init = await rpc(url, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  check('initialize', init.body.result.serverInfo.name === 'entropy-nexus' && !!init.body.result.capabilities.tools);
  check('通知回 202', (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status === 202);
  const tools = (await rpc(url, 'tools/list', {})).body.result.tools.map(t => t.name);
  // 只比對有哪些工具,不比對順序(工具是幾個功能各自加進清單的)
  check('十個工具', [...tools].sort().join() === ['list_nodes', 'ask_node', 'wait_reply', 'start_meeting', 'meeting_say', 'memory_search', 'memory_read', 'memory_write', 'case_submit', 'memory_draft'].sort().join(), tools.join());
  check('權杖不對是 404', (await rpc(url.replace(/[0-9a-f]{48}$/, 'f'.repeat(48)), 'tools/list', {})).status === 404);
  check('GET 不接受', (await fetch(url)).status === 405);

  const list = await call(A, 'list_nodes', {});
  check('list_nodes 列出其他節點、不含自己', list.text.includes('Beta') && list.text.includes('Gamma') && !list.text.includes('名稱:Alpha') && list.text.includes('可以呼叫'), list.text);

  // 自動模式的 Alpha 呼叫 Beta:不必經過使用者同意
  const r1 = await ask(A, 'Beta', '請幫我看一下這段設計。');
  check('Alpha(自動)呼叫 Beta 拿到答覆', !r1.error && r1.text.includes('節點「Beta」的答覆'), r1.text);
  check('等太久會先返回,再用 wait_reply 接著等', r1.rounds >= 1, `rounds=${r1.rounds}`);

  // 每次詢問的 Beta 呼叫 Gamma:主控台那邊允許後才送出;用 id 指定也可以
  const r2 = await ask(B, C, '請提供第二意見。');
  check('Beta(每次詢問)經授權後呼叫 Gamma', !r2.error && r2.text.includes('節點「Gamma」的答覆'), r2.text);
  const r3 = await ask(B, 'gamma', '這一筆請拒絕。');
  check('使用者拒絕時回報錯誤', r3.error && r3.text.includes('拒絕'), r3.text);

  check('不能呼叫自己', (await call(A, 'ask_node', { node: 'Alpha', prompt: 'x' })).error);
  check('找不到的節點', (await call(A, 'ask_node', { node: 'Nobody', prompt: 'x' })).error);
  check('空的指令', (await call(A, 'ask_node', { node: 'Beta', prompt: '  ' })).error);

  // 忙碌與迴圈:Alpha 呼叫 Gamma(先返回,Gamma 還在跑)
  const first = await call(A, 'ask_node', { node: 'Gamma', prompt: '請慢慢做。' });
  check('對方還在執行時先返回 request_id', !first.error && first.text.includes('還在執行') && /request_id:\w+/.test(first.text), first.text);
  const rid = /request_id:(\w+)/.exec(first.text)[1];
  const busy = await call(A, 'ask_node', { node: 'Gamma', prompt: '再一句' });
  check('對方忙碌時拒絕', busy.error && busy.text.includes('正在忙'), busy.text);
  const cycle = await call(C, 'ask_node', { node: 'Alpha', prompt: '反過來問你' });
  check('不能反過來呼叫正在等自己的節點', cycle.error && cycle.text.includes('正在等你'), cycle.text);
  check('別人的 request_id 不能用', (await call(B, 'wait_reply', { request_id: rid })).error);
  let last = await call(A, 'wait_reply', { request_id: rid });
  for (let i = 0; i < 40 && !last.error && last.text.includes('還在執行'); i++) last = await call(A, 'wait_reply', { request_id: rid });
  check('最後拿到 Gamma 的答覆', !last.error && last.text.includes('節點「Gamma」的答覆'), last.text);

  console.log(`[client] ${bad ? `有 ${bad} 項不符` : '用戶端全部通過'}`);
} catch (err) {
  console.log('[client] 失敗', err.stack ?? err.message);
}
// 通知主控台的測試腳本可以結束了(Beta 呼叫 Alpha;主控台那邊會允許)
await fetch(urlOf(B), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'ask_node', arguments: { node: 'Alpha', prompt: `互叫檢查完成(${bad ? '有不符' : '全部通過'})` } } }) }).catch(() => {});
