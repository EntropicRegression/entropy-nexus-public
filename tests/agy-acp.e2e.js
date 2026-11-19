// Antigravity 走 ACP 的整合驗收(真正的 agy,NEXUS_AGY_ACP=1;會花兩個回合的額度):
// 能力回報、額度查詢(agy -p /usage)、權限詢問與允許、中斷、休眠後續接。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(300); } throw new Error(`等不到:${what}`); };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const history = id => window.nexus.getHistory(id);
  const check = (name, ok, extra = '') => log(ok ? '通過' : '失敗', name, extra);
  try {
    await wait(3000);
    const cap = (await snap()).capabilities.find(c => c.backend === 'antigravity');
    check('能力:approvals 為 true 且說明提到 ACP', cap?.approvals === true && /ACP/.test(cap?.note ?? ''), JSON.stringify(cap));
    const agent = await window.nexus.createAgent({ name: 'Agy-ACP', character: '', model: 'gemini-3.8-flash-low', backend: 'antigravity', cwd: window.__TEST_CWD__, permissionMode: 'ask' });
    const id = agent.id;
    await until('待命', async () => (await agentOf(id))?.state === 'idle', 60000);
    check('新對話取得 session id', Boolean((await agentOf(id)).sessionId), (await agentOf(id)).sessionId);
    const u = await until('額度', async () => (await snap()).usage.find(x => x.backend === 'antigravity' && x.windows.length), 40000).catch(() => null);
    check('額度查詢(agy -p /usage)仍有結果', Boolean(u), u ? `${u.windows.length} 個額度視窗` : '');

    await window.nexus.send(id, 'Use the terminal to run exactly: mkdir nexus_e2e . Reply one word.');
    const pending = await until('授權請求', async () => (await agentOf(id))?.pendingApproval, 120000);
    check('跳出授權請求,狀態為 awaiting', (await agentOf(id)).state === 'awaiting', `${pending.tool} · ${pending.summary}`);
    await window.nexus.respondApproval(id, pending.requestId, 'allow');
    await until('回合結束', async () => (await agentOf(id))?.state === 'idle', 120000);
    const ev = await history(id);
    const toolEnd = ev.filter(e => e.type === 'tool' && e.phase === 'end').pop();
    check('允許後工具成功', toolEnd && !toolEnd.failed, toolEnd?.summary);
    check('有 agent 回覆', ev.some(e => e.type === 'message' && e.role === 'agent'));

    await window.nexus.send(id, 'Write a 500 word story about a lighthouse. No tools.');
    await until('開始生成', async () => ['planning', 'working'].includes((await agentOf(id))?.state), 30000);
    await wait(6000);
    await window.nexus.interrupt(id);
    await until('中斷完成', async () => (await history(id)).some(e => e.type === 'message' && e.text === '(已中斷)'), 60000);
    check('中斷', (await agentOf(id)).state === 'idle');

    const sid = (await agentOf(id)).sessionId;
    await window.nexus.sleep(id);
    await until('休眠', async () => (await agentOf(id))?.state === 'sleeping', 20000);
    await window.nexus.wake(id);
    await until('續接', async () => (await history(id)).some(e => e.type === 'state' && e.detail === '已續接'), 60000);
    check('休眠後續接同一個 session', (await agentOf(id)).sessionId === sid, sid);
    await window.nexus.removeAgent(id);
  } catch (err) { log('失敗', err.message); }
  document.title = 'QUIT';
})();
