// 語音播報驗收的用戶端:主控台畫面印出 INTEROP-GO 之後,扮演節點 G 與 E 的 CLI 用 ask_node 呼叫 C 與 H。
// 用法:node tests/voice-speech-client.mjs <主控台記錄檔> <資料資料夾>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [logFile, dataDir] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
const read = () => { try { return readFileSync(logFile, 'utf8'); } catch { return ''; } };
let id = null;
for (let i = 0; i < 300 && !id; i++) { const m = /\[test\] READY (\{.*\})/.exec(read()); if (m) id = JSON.parse(m[1]); else await wait(300); }
if (!id) { console.log('[client] 失敗 等不到主控台'); process.exit(1); }
for (let i = 0; i < 600 && !read().includes('[test] INTEROP-GO'); i++) await wait(300);
const urlOf = n => JSON.parse(readFileSync(join(dataDir, 'interop', `${id[n]}.json`), 'utf8')).mcpServers.nexus.url;
let seq = 0;
const call = async (who, name, args) => {
  const r = await fetch(urlOf(who), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }) });
  const res = (await r.json()).result;
  return { text: res.content[0].text, error: res.isError === true };
};
const ask = async (who, node, prompt) => {
  let r = await call(who, 'ask_node', { node, prompt });
  for (let i = 0; i < 60 && !r.error && /request_id:(\w+)/.test(r.text) && r.text.includes('還在執行'); i++) r = await call(who, 'wait_reply', { request_id: /request_id:(\w+)/.exec(r.text)[1] });
  return r;
};
const [rc, rh] = await Promise.all([ask('G', 'C', '圖片測試\nINTEROP-REPLY-C'), ask('E', 'H', '圖片測試\nINTEROP-REPLY-H')]);
console.log(`[client] ${!rc.error && rc.text.startsWith('節點「C」的答覆') ? '通過' : '不符'} G 呼叫 C 拿到答覆`);
console.log(`[client] ${!rh.error && rh.text.startsWith('節點「H」的答覆') ? '通過' : '不符'} E 經授權後呼叫 H 拿到答覆`);
