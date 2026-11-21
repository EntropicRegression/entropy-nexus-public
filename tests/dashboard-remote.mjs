// 總覽儀表的遠端部分,從外部用 HTTP 檢查。由 tests/dashboard.sh 呼叫(主控台以假資料模式執行 tests/dashboard.e2e.js):
// 限定節點的唯讀裝置只拿得到範圍內節點的花費與任務統計(狀態、快照、即時更新三條路都檢查),也不能改每日預算;
// 另外對 hooks 接收端送模擬的外部節點事件,讓畫面那一側檢查儀表的「外部觀察」區塊。做完對節點甲送一句「遠端檢查完成」。
// 用法:node tests/dashboard-remote.mjs <遠端連接埠> <配對碼> <節點甲的 id> <節點乙的 id> <hooks 連接埠> <測試用的 Claude 設定檔> <外部節點的工作目錄>
import { readFileSync } from 'node:fs';

const [port, code, A, B, hooksPort, settingsFile, work] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (what, ok, extra = '') => { if (!ok) bad++; console.log(`[remote] ${ok ? '通過' : '不符'} ${what}${ok || extra === '' ? '' : ` → ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 320)}`}`); };

const http = async (token, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* 沒有內容 */ }
  return { status: r.status, body: j };
};
const get = (t, path) => http(t, 'GET', path);
const post = (t, path, body) => http(t, 'POST', path, body);
const rpc = (t, method, ...args) => post(t, '/api/rpc', { method, args });
const pair = async (name, c) => { const r = await post(null, '/pair', { code: c, name }); if (r.status !== 200) throw new Error(`配對 ${name} 失敗:${r.status}`); return r.body.token; };
/** 訂閱即時更新,stop() 之後回傳這段時間收到的更新。 */
const listen = async token => {
  const ac = new AbortController();
  const out = [];
  const r = await fetch(`${base}/api/stream?full=1`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); if (c.startsWith('data: ')) { try { out.push(JSON.parse(c.slice(6))); } catch { /* 略過 */ } } } } } catch { /* 中止 */ } })();
  return { stop: async () => { ac.abort(); await pump; return out; } };
};
const tokensOf = (d, id) => d.spend.filter(r => r.agentId === id).reduce((n, r) => n + r.tokens, 0);

let F = '';
try {
  F = await pair('完整裝置', code);
  await rpc(F, 'remotePairAccess', { role: 'viewer', agents: [A] });
  const V = await pair('唯讀裝置', (await rpc(F, 'remoteStatus')).body.result.pairCode);

  // ---------- 完整裝置看得到全部;唯讀、限定節點甲的裝置只看得到甲的花費與任務統計
  const all = (await rpc(F, 'snapshot')).body.result.dashboard;
  check('完整裝置:儀表有甲和乙的花費(26000、5000 tokens)', tokensOf(all, A) === 26000 && tokensOf(all, B) === 5000, all.spend);
  check('完整裝置:今天的任務統計含兩個以上的節點', all.tasks.length >= 2 && all.tasks.reduce((n, t) => n + t.assigned, 0) === 12, all.tasks);
  for (const [via, d] of [['狀態(/api/state)', (await get(V, '/api/state')).body.dashboard], ['快照(/api/rpc snapshot)', (await rpc(V, 'snapshot')).body.result.dashboard]]) {
    check(`唯讀裝置 ${via}:只有甲的花費,數字正確`, !!d && d.spend.length >= 1 && d.spend.every(r => r.agentId === A) && tokensOf(d, A) === 26000, d?.spend);
    check(`唯讀裝置 ${via}:任務統計只有甲`, !!d && d.tasks.length === 1 && d.tasks[0].agentId === A && d.tasks[0].assigned === all.tasks.find(t => t.agentId === A).assigned, d?.tasks);
    check(`唯讀裝置 ${via}:後台的額度與預算照樣看得到(帳號層級)`, !!d && d.budgets.length === 3 && d.budgets.find(b => b.backend === 'claude').budget === 30 && d.budgets.find(b => b.backend === 'claude').used === 7, d?.budgets);
  }
  const vs = (await rpc(V, 'snapshot')).body.result;
  check('唯讀裝置:快照沒有外部觀察節點,額度(usage)和完整裝置相同', vs.observed.length === 0 && JSON.stringify(vs.usage) === JSON.stringify((await rpc(F, 'snapshot')).body.result.usage));

  // ---------- 即時更新:乙有新的花費時,唯讀裝置收到的儀表更新仍然只有甲
  const sV = await listen(V), sF = await listen(F);
  await rpc(F, 'send', B, '〔測試用量:{"windows":[{"label":"5 小時","used":0.2,"resetsAt":null},{"label":"每週","used":0.53,"resetsAt":null}],"spent":{"tokens":7000}}〕');
  await wait(3500);
  const uV = await sV.stop(), uF = await sF.stop();
  const dV = uV.filter(u => u.dashboard).map(u => u.dashboard), dF = uF.filter(u => u.dashboard).map(u => u.dashboard);
  check('完整裝置的即時更新:乙的花費變成 12000 tokens', dF.length >= 1 && tokensOf(dF.at(-1), B) === 12000, dF.at(-1)?.spend);
  check('唯讀裝置的即時更新:有收到儀表更新,而且只有甲的花費與任務', dV.length >= 1 && dV.every(d => d.spend.every(r => r.agentId === A) && d.tasks.every(t => t.agentId === A)), dV.at(-1));
  check('唯讀裝置的即時更新:收得到後台額度(Codex 5 小時 20%),收不到乙的節點與任務', uV.some(u => u.usage?.backend === 'codex' && u.usage.windows[0].used === 0.2) && !uV.some(u => u.agent?.id === B || u.task?.agentId === B || u.event?.agentId === B), uV.map(u => Object.keys(u).join('+')));

  // ---------- 每日預算只有完整權限能改
  const deny = await rpc(V, 'setDailyBudget', 'claude', 50);
  check('唯讀裝置不能改每日預算(403),預算沒變', deny.status === 403 && (await rpc(F, 'snapshot')).body.result.dashboard.budgets.find(b => b.backend === 'claude').budget === 30, `${deny.status}`);
  const allow = await rpc(F, 'setDailyBudget', 'codex', 40);
  check('完整裝置可以改每日預算,改完讀得到', allow.status === 200 && (await rpc(V, 'snapshot')).body.result.dashboard.budgets.find(b => b.backend === 'codex').budget === 40, `${allow.status}`);
  const audit = (await rpc(F, 'remoteAudit')).body.result;
  check('操作紀錄記下改預算與被拒的嘗試', audit.some(e => e.action === 'setDailyBudget' && e.ok && e.detail.includes('codex 每日預算 40%')) && audit.some(e => e.action === 'setDailyBudget' && !e.ok), audit.filter(e => e.action === 'setDailyBudget'));

  // ---------- 模擬一個外部節點(Claude Code 的 hooks),停在待授權
  const token = (JSON.stringify(JSON.parse(readFileSync(settingsFile, 'utf8'))).match(/entropy-nexus-hook\/([0-9a-f]+)/) ?? [])[1] ?? '';
  const hook = (name, extra = {}) => fetch(`http://127.0.0.1:${hooksPort}/entropy-nexus-hook/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: 'dash-ext-1', transcript_path: 'x.jsonl', cwd: work, permission_mode: 'default', hook_event_name: name, ...extra }) }).then(r => r.status, () => 0);
  const h1 = await hook('SessionStart', { source: 'startup' });
  const h2 = await hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  check('hooks 接收端收下外部節點的事件', token.length > 0 && h1 === 200 && h2 === 200, `${token.length} ${h1} ${h2}`);
  await wait(500);
  check('唯讀裝置仍然拿不到外部觀察節點', (await rpc(V, 'snapshot')).body.result.observed.length === 0 && (await rpc(F, 'snapshot')).body.result.observed.length === 1);
} catch (err) {
  bad++;
  console.log(`[remote] 失敗 ${err.stack ?? err.message}`);
}
// 不論結果都通知主控台繼續(畫面那一側還有外部觀察的檢查)
if (F) await rpc(F, 'send', A, '〔測試執行:200〕遠端檢查完成').catch(() => {});
console.log(bad ? `[remote] 有 ${bad} 項不符` : '[remote] 遠端檢查全部通過');
