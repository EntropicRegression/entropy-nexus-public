// 驗收(用戶端):扮演總管 Chief 與一般節點 Worker 的 CLI,用 MCP 呼叫 memory_search / memory_write。
// 用法:node tests/memory-phase2-client.mjs <主控台記錄檔> <資料資料夾>
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [logFile, dataDir] = process.argv.slice(2);
const wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (what, ok, extra = '') => { if (!ok) bad++; console.log(`[client] ${ok ? '通過' : '不符'} ${what}${ok || !extra ? '' : ` → ${String(extra).slice(0, 400)}`}`); };

let ids = null;
for (let i = 0; i < 200 && !ids; i++) { const m = /\[test\] READY (\S+) (\S+)/.exec(readFileSync(logFile, 'utf8')); if (m) ids = m.slice(1); else await wait(300); }
if (!ids) { console.log('[client] 失敗 等不到主控台'); process.exit(1); }
const [C, W] = ids;
const urlOf = id => JSON.parse(readFileSync(join(dataDir, 'interop', `${id}.json`), 'utf8')).mcpServers.nexus.url;
let seq = 0;
const rpc = async (url, method, params) => { const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }) }); return r.json(); };
const call = async (id, name, args) => { const r = (await rpc(urlOf(id), 'tools/call', { name, arguments: args })).result; return { text: r.content[0].text, error: r.isError === true }; };
const vault = join(dataDir, 'memory-vault');
const put = (rel, text) => { const f = join(vault, ...rel.split('/')); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, text); };

try {
  const tools = (await rpc(urlOf(W), 'tools/list', {})).result.tools.map(t => t.name);
  check('工具清單有 memory_search 與 memory_write', tools.includes('memory_search') && tools.includes('memory_write'), tools.join());

  // 一般節點不能寫
  const denied = await call(W, 'memory_write', { kind: 'knowledge', title: '不該寫入', content: 'x' });
  check('一般節點寫入被拒絕', denied.error && denied.text.includes('總管'), denied.text);
  check('case 不能用 memory_write 寫', (await call(C, 'memory_write', { kind: 'case', title: 't', content: 'c' })).text.includes('case_submit'));

  // 總管寫:節點特長、偏好、專案知識(上限 3,寫 4 則)
  const n = await call(C, 'memory_write', { kind: 'node', title: 'Worker', content: '擅長圖表渲染與前端除錯\n其他' });
  check('總管寫節點特長', !n.error && n.text.includes('Worker'), n.text);
  // 側寫依節點 ID 命名(nodes/Worker-<ID 前 8 碼>.md),路徑從回覆取得
  const profileRel = /路徑:(nodes\/[^;\s]+\.md)/.exec(n.text)?.[1] ?? '';
  check('新的側寫檔名帶節點 ID', /^nodes\/Worker-[^/]+\.md$/.test(profileRel), n.text);
  const profile = profileRel ? join(vault, ...profileRel.split('/')) : join(vault, 'nodes', 'Worker.md');
  const ptext = existsSync(profile) ? readFileSync(profile, 'utf8') : '';
  check('側寫檔有特長與流程章節', /## 特長\s+擅長圖表渲染/.test(ptext) && ptext.includes('## 解決問題的流程'), ptext);
  check('總管寫使用者偏好', !(await call(C, 'memory_write', { kind: 'preference', title: '回報要精簡', content: '一兩句講完圖表結果' })).error);
  let last = { text: '' };
  for (let i = 1; i <= 4; i++) last = await call(C, 'memory_write', { kind: 'knowledge', title: `圖表知識${i}`, content: `圖表第 ${i} 則:password: hunter2secret${i}` });
  check('專案知識超過上限仍寫入並說明', !last.error && last.text.includes('上限') && last.text.includes('遮罩'), last.text);
  const projDir = readdirSync(join(vault, 'knowledge'))[0] ?? '';
  const kn = projDir ? readFileSync(join(vault, 'knowledge', projDir, '圖表知識1.md'), 'utf8') : '';
  check('祕密被遮罩、帶有更新時間', kn && !kn.includes('hunter2secret') && kn.includes('更新時間:'), kn);

  // 判例可見度:只有已確認的看得到
  // 判例屬於專案範圍:放在呼叫者(Worker)所在的專案才在搜尋範圍內;專案 ID 沿用剛才寫入的專案知識
  const projId = (/專案ID: (.+)/.exec(kn)?.[1] ?? '').trim().replace(/^"|"$/g, '');
  for (const [i, st] of ['已確認', '未確認', '退回'].entries()) put(`cases/${projDir}/${i}-圖表案.md`, `---\n種類: case\n範圍: 專案\n專案ID: ${projId}\n案由: 圖表案${i}\n狀態: ${st}\n---\n圖表壞掉的解法${i}\n`);
  await call(C, 'memory_write', { kind: 'preference', title: '觸發重新掃描', content: '讓索引讀到判例' });
  await wait(500);
  const s = await call(W, 'memory_search', { query: '圖表' });
  check('搜尋有結果與路徑', !s.error && s.text.includes('路徑:'), s.text);
  // 只查判例,避免結果被大量專案知識擠掉
  const cs = await call(W, 'memory_search', { query: '圖表案', kind: 'case' });
  check('只看得到已確認的判例', cs.text.includes('圖表案0') && !cs.text.includes('圖表案1') && !cs.text.includes('圖表案2'), cs.text);
  check('自己的側寫排最前面', /1\. \[節點側寫\] Worker/.test(s.text) && s.text.includes('(你自己的)'), s.text.slice(0, 300));
  const k = await call(W, 'memory_search', { query: '圖表', kind: 'knowledge' });
  check('kind 篩選與專案範圍(同一個工作目錄的專案知識看得到)', k.text.includes('圖表知識') && !k.text.includes('節點側寫'), k.text);
  check('沒有符合時有說明', (await call(W, 'memory_search', { query: 'zqxjv-nomatch-7731' })).text.includes('沒有符合'));

  // memory_read:用搜尋結果的路徑讀全文;未確認的判例讀不到;庫外路徑被拒
  const rp = /路徑:(cases\/\S+0-圖表案\.md)/.exec(cs.text)?.[1];
  const rd = rp ? await call(W, 'memory_read', { path: rp }) : { text: '', error: true };
  check('memory_read 讀得到已確認的判例全文', !rd.error && rd.text.includes('圖表壞掉的解法0'), rd.text);
  const rdBad = await call(W, 'memory_read', { path: rp ? rp.replace('0-圖表案', '1-圖表案') : 'x.md' });
  check('memory_read 讀不到未確認的判例', rdBad.error, rdBad.text);
  check('memory_read 拒絕庫外路徑', (await call(W, 'memory_read', { path: '../secret.md' })).error);
  check('工具清單有 memory_read', tools.includes('memory_read'), tools.join());

  console.log(`[client] ${bad ? `有 ${bad} 項不符` : '用戶端全部通過'}`);
} catch (err) {
  console.log('[client] 失敗', err.stack ?? err.message);
}
// 讓 Worker 呼叫 Chief,通知主控台那邊可以結束了
await fetch(urlOf(W), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/call', params: { name: 'ask_node', arguments: { node: 'Chief', prompt: `記憶檢查完成(${bad ? '有不符' : '全部通過'})` } } }) }).catch(() => {});
