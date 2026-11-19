// 遠端裝置權限(完整、操作、唯讀與節點範圍)的驗收,從外部用 HTTP 檢查。由 tests/access.sh 呼叫:
// 主控台以假資料模式執行 tests/web-full.e2e.js(印出第一組配對碼,等「瀏覽器檢查完成」這句指令後結束)。
// 用法:node tests/access-remote.mjs <連接埠> <配對碼> <節點 A 的 id>
const [port, code, A] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
let bad = 0;
const check = (what, ok, extra = '') => { if (!ok) bad++; console.log(`[access] ${ok ? '通過' : '不符'} ${what}${ok || !extra ? '' : ` → ${extra}`}`); };

const http = async (token, method, path, body, headers = {}) => {
  const r = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* 沒有內容 */ }
  return { status: r.status, body: j };
};
const get = (t, path) => http(t, 'GET', path);
const post = (t, path, body) => http(t, 'POST', path, body);
const rpc = (t, method, ...args) => post(t, '/api/rpc', { method, args });
const pairAs = async (name, viaToken, access) => {
  let c = code;
  if (viaToken) { await rpc(viaToken, 'remotePairAccess', access); c = (await rpc(viaToken, 'remoteStatus')).body.result.pairCode; }
  const r = await post(null, '/pair', { code: c, name });
  if (r.status !== 200) throw new Error(`配對 ${name} 失敗:${r.status}`);
  return r.body.token;
};
/** 訂閱即時更新一段時間,回傳收到的更新。 */
const listen = async (token, ms, full = false) => {
  const ac = new AbortController();
  const out = [];
  const r = await fetch(`${base}/api/stream${full ? '?full=1' : ''}`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const pump = (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); if (c.startsWith('data: ')) out.push(JSON.parse(c.slice(6))); } } } catch { /* 中止 */ } })();
  return { stop: async () => { await wait(ms); ac.abort(); await pump; return out; } };
};
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

try {
  const F = await pairAs('完整裝置');
  const all = (await rpc(F, 'snapshot')).body.result;
  check('完整角色的快照帶權限', all.access?.role === 'full' && all.access.agents === null, JSON.stringify(all.access));
  const B = all.agents.find(a => !a.parentId && a.id !== A).id;
  const O = await pairAs('操作裝置', F, { role: 'operator', agents: [A] });
  const V = await pairAs('唯讀裝置', F, { role: 'viewer', agents: [A] });
  const VA = await pairAs('唯讀全部', F, { role: 'viewer', agents: null });
  await rpc(F, 'remotePairAccess', { role: 'full', agents: ['x'] });
  const st = (await rpc(F, 'remoteStatus')).body.result;
  check('完整角色不限節點', st.pairAccess.role === 'full' && st.pairAccess.agents === null, JSON.stringify(st.pairAccess));
  check('裝置清單帶角色與範圍', st.devices.map(d => `${d.name}:${d.role}:${d.agents ? d.agents.length : '全部'}`).join(',') === '完整裝置:full:全部,操作裝置:operator:1,唯讀裝置:viewer:1,唯讀全部:viewer:全部', JSON.stringify(st.devices.map(d => [d.name, d.role, d.agents])));

  // ---------- 看得到什麼
  for (const [who, t] of [['操作', O], ['唯讀', V]]) {
    const s = (await get(t, '/api/state')).body;
    check(`${who}:狀態只有範圍內的節點`, s.agents.length >= 1 && s.agents.every(a => a.id === A || a.parentId === A) && s.tasks.every(x => x.agentId === A), JSON.stringify(s.agents.map(a => a.name)));
    check(`${who}:狀態回報權限`, s.access?.role === (who === '操作' ? 'operator' : 'viewer') && s.access.agents?.[0] === A, JSON.stringify(s.access));
    const snap = (await rpc(t, 'snapshot')).body.result;
    check(`${who}:快照過濾`, snap.agents.every(a => a.id === A || a.parentId === A) && snap.events.every(e => e.agentId === A) && snap.observed.length === 0 && snap.portraitsDir === '', JSON.stringify({ agents: snap.agents.length, events: snap.events.length, dir: snap.portraitsDir }));
    check(`${who}:範圍內的對話`, (await get(t, `/api/history?id=${A}`)).status === 200 && (await rpc(t, 'history', A)).status === 200);
    check(`${who}:範圍外的對話`, (await get(t, `/api/history?id=${B}`)).status === 403 && (await rpc(t, 'history', B)).status === 403);
    check(`${who}:範圍外的圖片`, (await get(t, `/api/file?id=${B}&path=x.png`)).status === 403);
    check(`${who}:不提供最近的資料夾`, (await get(t, '/api/meta')).body.dirs.length === 0);
  }
  check('唯讀全部:看得到所有節點', (await get(VA, '/api/state')).body.agents.length === all.agents.length && (await get(VA, `/api/history?id=${B}`)).status === 200);

  // ---------- 只有完整角色能做的事(操作與唯讀都被拒)
  const adminCalls = [
    ['新增節點', t => post(t, '/api/create', { backend: 'claude', cwd: process.cwd(), name: 'x', permissionMode: 'auto' })],
    ['新增節點(完整介面)', t => rpc(t, 'create', { backend: 'claude', cwd: process.cwd(), name: 'x', character: '', model: '', permissionMode: 'auto' })],
    ['終止節點', t => post(t, '/api/remove', { id: A })],
    ['終止節點(完整介面)', t => rpc(t, 'remove', A)],
    ['改名', t => rpc(t, 'updateAgent', A, { name: 'pwned' })],
    ['設定', t => post(t, '/api/settings', { maxActive: 9 })],
    ['同時上限(完整介面)', t => rpc(t, 'maxActive', 9)],
    ['讀配對碼', t => rpc(t, 'remoteStatus')],
    ['產生配對碼', t => rpc(t, 'remoteNewCode')],
    ['設定配對權限', t => rpc(t, 'remotePairAccess', { role: 'full', agents: null })],
    ['改裝置權限', t => rpc(t, 'remoteSetDevice', 'x', { role: 'full', agents: null })],
    ['撤銷裝置', t => rpc(t, 'remoteRevoke', 'x')],
    ['讀操作紀錄', t => rpc(t, 'remoteAudit')],
    ['關閉遠端', t => rpc(t, 'remoteSet', { enabled: false })],
    ['讀角色卡', t => get(t, '/api/persona?character=x')],
    ['寫角色卡', t => rpc(t, 'setPersona', 'x', 'pwned')],
    ['終端機模式', t => rpc(t, 'openTerminal', A, 80, 24)],
    ['終端機輸入', t => rpc(t, 'termWrite', A, 'dir\r')],
    ['安裝 hooks', t => rpc(t, 'observeInstall')],
    ['舊 session', t => get(t, '/api/oldsessions')],
    ['開啟舊 session', t => post(t, '/api/opensession', { backend: 'claude', sessionId: 'x', cwd: process.cwd() })],
    ['分支', t => rpc(t, 'forkAgent', { agentId: A, name: 'x', model: '', isolate: false })],
    ['列出資料夾', t => get(t, '/api/dirs')],
    ['檢查資料夾', t => get(t, `/api/inspect?cwd=${encodeURIComponent(process.cwd())}`)],
    ['任意檔案上傳', t => http(t, 'POST', '/api/attach', Uint8Array.from([1, 2, 3]), { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.bin' })],
    ['合併工作區', t => post(t, '/api/merge', { id: A })],
    ['還原', t => post(t, '/api/revert', { taskId: 'x' })],
    ['清除任務', t => rpc(t, 'clearTasks')],
    ['自動運作', t => rpc(t, 'autopilot', true)],
    ['沒登記的方法', t => rpc(t, 'requestReview', 'x', A)],
  ];
  for (const [who, t] of [['操作', O], ['唯讀', V]]) {
    const leaked = [];
    for (const [label, fn] of adminCalls) { const r = await fn(t); if (r.status !== 403) leaked.push(`${label}=${r.status}`); }
    check(`${who}:${adminCalls.length} 項管理功能全部被拒`, leaked.length === 0, leaked.join(','));
  }
  check('設定沒有被改動', (await rpc(F, 'snapshot')).body.result.maxActive === all.maxActive && (await rpc(F, 'snapshot')).body.result.agents.find(a => a.id === A).name === all.agents.find(a => a.id === A).name);
  check('不存在的方法仍是 404', (await rpc(O, 'constructor')).status === 404);

  // ---------- 唯讀不能操作
  const operateCalls = [
    ['送出', t => post(t, '/api/send', { id: A, text: '唯讀不該送得出去' })],
    ['送出(完整介面)', t => rpc(t, 'send', A, '唯讀不該送得出去')],
    ['排隊', t => post(t, '/api/enqueue', { id: A, text: 'x' })],
    ['授權', t => post(t, '/api/approve', { id: A, requestId: 'x', decision: 'allow' })],
    ['授權(完整介面)', t => rpc(t, 'approval', A, 'x', 'allow')],
    ['回答', t => rpc(t, 'answer', A, 'x', null)],
    ['中斷', t => post(t, '/api/interrupt', { id: A })],
    ['休眠', t => post(t, '/api/sleep', { id: A })],
    ['喚醒', t => rpc(t, 'wake', A)],
    ['上傳', t => http(t, 'POST', '/api/upload', PNG, { 'Content-Type': 'image/png' })],
  ];
  for (const [who, t] of [['唯讀', V], ['唯讀全部', VA]]) {
    const leaked = [];
    for (const [label, fn] of operateCalls) { const r = await fn(t); if (r.status !== 403) leaked.push(`${label}=${r.status}`); }
    check(`${who}:${operateCalls.length} 項操作全部被拒`, leaked.length === 0, leaked.join(','));
  }

  // ---------- 操作角色:範圍內可以,範圍外不行;即時更新只收到範圍內的
  const scoped = await listen(O, 4500);
  const everything = await listen(F, 4500, true);
  await wait(300);
  check('操作:範圍外送出', (await post(O, '/api/send', { id: B, text: '不該送到 B' })).status === 403 && (await rpc(O, 'send', B, '不該送到 B')).status === 403);
  check('操作:範圍外中斷與休眠', (await post(O, '/api/interrupt', { id: B })).status === 403 && (await rpc(O, 'sleep', B)).status === 403);
  await rpc(F, 'send', B, '完整裝置送給 B');
  const up = await http(O, 'POST', '/api/upload', PNG, { 'Content-Type': 'image/png', 'X-File-Name': 'dot.png' });
  check('操作:上傳圖片', up.status === 200 && /uploads/.test(up.body.path), JSON.stringify(up.body));
  check('操作:任意檔案的縮圖讀不到', (await rpc(O, 'attachmentPreview', 'C:\\Windows\\Web\\Screen\\img100.jpg')).body.result === null);
  const sent = await rpc(O, 'send', A, '操作裝置送出的指令', [up.body.path, 'C:\\Windows\\win.ini']);
  check('操作:範圍內送出', sent.status === 200, JSON.stringify(sent.body));
  const seenO = await scoped.stop();
  const seenF = await everything.stop();
  const ids = list => [...new Set(list.flatMap(u => [u.event?.agentId, u.agent?.id, u.delta?.agentId, u.task?.agentId].filter(Boolean)))];
  check('完整:即時更新包含 B', ids(seenF).includes(B), JSON.stringify(ids(seenF)));
  check('操作:即時更新只有範圍內的節點', ids(seenO).includes(A) && !ids(seenO).includes(B), JSON.stringify(ids(seenO)));
  const hist = (await rpc(F, 'history', A)).body.result;
  const mine = hist.find(e => e.type === 'message' && e.role === 'user' && e.text === '操作裝置送出的指令');
  check('指令進到節點,附件只留上傳的', !!mine && JSON.stringify(mine.images ?? mine.attachments ?? []).includes('win.ini') === false, JSON.stringify(mine));
  check('對話註明是哪支裝置送的', hist.some(e => e.type === 'note' && e.text.includes('「操作裝置」') && e.text.includes('操作權限')), JSON.stringify(hist.filter(e => e.type === 'note').map(e => e.text).slice(-2)));
  // 假資料節點收到指令後會要求授權;操作角色可以回應
  let pending = null;
  for (let i = 0; i < 60 && !pending; i++) { pending = (await get(O, '/api/state')).body.agents.find(a => a.id === A)?.pendingApproval; if (!pending) await wait(300); }
  if (pending) check('操作:回應授權', (await post(O, '/api/approve', { id: A, requestId: pending.requestId, decision: 'allow' })).status === 200);
  else console.log('[access] 略過 操作:回應授權(這次節點沒有要求授權)');
  check('操作:排隊與取消', (await post(O, '/api/enqueue', { id: A, text: '排隊的指令' })).status === 200);

  // ---------- 操作紀錄
  const log = (await rpc(F, 'remoteAudit')).body.result;
  const has = (device, action, ok, agentId) => log.some(e => e.device === device && e.action === action && e.ok === ok && (agentId === undefined || e.agentId === agentId));
  check('紀錄:配對', has('操作裝置', 'pair', true) && log.find(e => e.device === '操作裝置' && e.action === 'pair').detail.includes('操作'));
  check('紀錄:操作裝置送出', has('操作裝置', 'send', true, A) && log.find(e => e.device === '操作裝置' && e.action === 'send' && e.ok).detail === '操作裝置送出的指令');
  check('紀錄:節點名稱', log.find(e => e.device === '操作裝置' && e.action === 'send' && e.ok).agentName === all.agents.find(a => a.id === A).name);
  check('紀錄:範圍外被拒', has('操作裝置', 'send', false, B));
  check('紀錄:唯讀被拒', has('唯讀裝置', 'send', false, A) && has('唯讀裝置', 'approval', false, A));
  check('紀錄:管理功能被拒', has('操作裝置', 'create', false) && has('操作裝置', 'remoteNewCode', false) && has('唯讀裝置', 'settings', false));
  check('紀錄:讀取不記', !log.some(e => ['history', 'snapshot', 'state', 'remoteStatus', 'stream'].includes(e.action) && e.ok));
  check('紀錄:完整裝置的動作也記', has('完整裝置', 'send', true, B) && has('完整裝置', 'remotePairAccess', true));

  // ---------- 修改權限、節點終止、撤銷
  const devs = (await rpc(F, 'remoteStatus')).body.result.devices;
  const idOf = name => devs.find(d => d.name === name).id;
  await rpc(F, 'remoteSetDevice', idOf('唯讀裝置'), { role: 'operator', agents: [A, B] });
  check('改成操作後可以送到 B', (await post(V, '/api/send', { id: B, text: '權限改了之後' })).status === 200);
  await rpc(F, 'remove', B);
  await wait(500);
  const after = (await rpc(F, 'remoteStatus')).body.result.devices.find(d => d.name === '唯讀裝置');
  check('節點終止後從範圍移除', JSON.stringify(after.agents) === JSON.stringify([A]), JSON.stringify(after.agents));
  await rpc(F, 'remoteRevoke', idOf('操作裝置'));
  check('撤銷後立刻失效', (await get(O, '/api/state')).status === 401);
  const log2 = (await rpc(F, 'remoteAudit')).body.result;
  check('紀錄:改權限與撤銷', log2.some(e => e.action === 'setAccess' && e.device === '唯讀裝置' && e.role === 'desktop') && log2.some(e => e.action === 'revoke' && e.device === '操作裝置'));

  console.log(`[access] ${bad ? `有 ${bad} 項不符` : '全部通過'}`);
  await rpc(F, 'send', A, `瀏覽器檢查完成(${bad ? '有不符' : '全部通過'})`);
} catch (err) {
  console.log('[access] 失敗', err.stack ?? err.message);
}
