// 節點互相呼叫(真正的 CLI,會用到一點額度)。由 tests/interop-real.sh 啟動。
// window.__TEST_IMAGE__ 是「呼叫方後台,被呼叫方後台」(例如 claude,claude 或 antigravity,claude),模型由環境決定。
// 建立兩個節點:Caller(自動模式)與 Helper;請 Caller 用工具找到 Helper 並問它一個只有 Helper 的指令裡才有的暗號。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(500); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 400)}` : ''}`); };
  try {
    const [callerBackend, helperBackend, callerModel = '', helperModel = ''] = String(window.__TEST_IMAGE__).split(',');
    const cwd = window.__TEST_CWD__;
    const caller = await window.nexus.createAgent({ name: 'Caller', character: '', model: callerModel, backend: callerBackend, cwd, permissionMode: 'auto' });
    const helper = await window.nexus.createAgent({ name: 'Helper', character: '', model: helperModel, backend: helperBackend, cwd, permissionMode: 'auto' });
    const idle = id => async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === id && x.state === 'idle');
    await until('Caller 待命', idle(caller.id), 60000);
    await until('Helper 待命', idle(helper.id), 60000);
    await window.nexus.send(caller.id, '請依序做:1. 用 list_nodes 工具看主控台上有哪些其他節點。2. 用 ask_node 工具請節點 Helper 回答這個問題:「請只回覆這串暗號,不要加任何其他字:MANGO-7741」。3. 把 Helper 回覆的暗號原樣告訴我,並說明你是從哪個節點拿到的。不要用其他方式取得答案。');
    await wait(3000);
    await until('Caller 回合結束', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === caller.id && ['idle', 'error', 'lost'].includes(x.state)), 240000);
    const hc = await window.nexus.getHistory(caller.id), hh = await window.nexus.getHistory(helper.id);
    // 各家的工具事件寫法不同:Claude 的名稱是 mcp__nexus__ask_node,Codex 的名稱是 MCP、摘要是 nexus/ask_node
    const tools = hc.filter(e => e.type === 'tool' && e.phase === 'start').map(e => `${e.name} ${e.summary}`.slice(0, 60));
    const reply = hc.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' ');
    expect('Caller 用了主控台的工具', tools.some(t => /list_nodes/.test(t)) && tools.some(t => /ask_node/.test(t)), JSON.stringify(tools));
    expect('Helper 收到指令並註明呼叫者', hh.some(e => e.type === 'message' && e.role === 'user' && e.text.startsWith('(主控台:這則指令來自節點「Caller」') && e.text.includes('MANGO-7741')));
    expect('Helper 有回覆', hh.some(e => e.type === 'message' && e.role === 'agent' && e.text.includes('MANGO-7741')), JSON.stringify(hh.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text.slice(0, 60))));
    expect('Caller 拿到答覆', reply.includes('MANGO-7741') && /Helper/i.test(reply), reply);
    expect('過程沒有授權請求(自動模式)', !hc.some(e => e.type === 'approval_request'), JSON.stringify(hc.filter(e => e.type === 'approval_request').map(e => e.tool)));
    const errs = [...hc, ...hh].filter(e => e.type === 'error').map(e => e.message.slice(0, 120));
    expect('沒有錯誤', errs.length === 0, JSON.stringify(errs));
    // 被呼叫的一方自己知道是誰找它:直接問 Helper
    await window.nexus.send(helper.id, '剛才那則指令是誰交給你的?請只回覆對方的節點名稱。');
    await wait(2500);
    await until('Helper 回合結束', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === helper.id && ['idle', 'error', 'lost'].includes(x.state)), 120000);
    const who = (await window.nexus.getHistory(helper.id)).filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).pop() ?? '';
    expect('被呼叫的節點知道呼叫者的名字', /Caller/.test(who), who);
    log(bad ? `有 ${bad} 項不符` : '全部通過');
    await window.nexus.removeAgent(caller.id); await window.nexus.removeAgent(helper.id);
  } catch (err) {
    log('失敗', err.message);
    try { const s = await window.nexus.getSnapshot(); for (const a of s.agents) { const h = await window.nexus.getHistory(a.id); log(a.name, a.state, a.detail, JSON.stringify(h.filter(e => ['error', 'tool', 'message'].includes(e.type)).slice(-6).map(e => `${e.type}:${String(e.name ?? e.message ?? e.text).slice(0, 80)}`))); } } catch { /* 略過 */ }
  }
  document.title = 'QUIT';
})();
