// 驗收:指定模型,以及節點呼叫子代理時自動出現子節點。會啟動三家真正的 CLI。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const agents = async () => (await window.nexus.getSnapshot()).agents;
  const agent = async id => (await agents()).find(a => a.id === id);
  const kids = async id => (await agents()).filter(a => a.parentId === id);
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); }
    throw new Error(`等不到:${what}`);
  };
  const openDialog = async name => { const found = window.__nexusSelect(name); if (found) await wait(600); return found; };
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;

  // 讓一個節點呼叫子代理,邊跑邊觀察子節點;有授權請求一律允許
  const runWithSubs = async (node, prompt, label) => {
    await window.nexus.send(node.id, prompt);
    await until(`${label} 開始`, async () => !DONE.includes((await agent(node.id)).state), 30000);
    let maxKids = 0, names = new Set(), shotDone = false, sawChildEvents = 0;
    await until(`${label} 完成`, async () => {
      const a = await agent(node.id);
      if (a.pendingApproval) await window.nexus.respondApproval(node.id, a.pendingApproval.requestId, 'allow');
      const k = await kids(node.id);
      maxKids = Math.max(maxKids, k.length);
      for (const c of k) { names.add(c.name); sawChildEvents = Math.max(sawChildEvents, (await window.nexus.getHistory(c.id)).length); }
      if (k.length && !shotDone && k.some(c => c.state === 'working' || c.state === 'planning')) {
        shotDone = true;
        await openDialog(k[0].name);
        await shot(`${label}-subs`);
      }
      return DONE.includes(a.state);
    }, 240000);
    const h = await window.nexus.getHistory(node.id);
    log(label, '最終狀態', (await agent(node.id)).state, '| 同時最多子節點', maxKids, '| 子節點名稱', JSON.stringify([...names]), '| 子節點事件數', sawChildEvents,
      '| 父節點的子代理事件', h.filter(e => e.type === 'subagent').map(e => e.phase).join(','), '| 工具', JSON.stringify([...new Set(h.filter(e => e.type === 'tool' && e.phase === 'start').map(e => e.name))]));
    log(label, '回覆', JSON.stringify(String(await lastReply(node.id)).slice(0, 120)));
    return maxKids;
  };

  try {
    const cwd = window.__TEST_CWD__;
    window.__ONLY_AGY__ = cwd.includes('only-agy');
    const snap = await window.nexus.getSnapshot();
    for (const c of snap.capabilities) log('模型清單', c.backend, JSON.stringify(c.models.slice(0, 8)), c.models.length > 8 ? `…共 ${c.models.length}` : '');
    const codexModel = snap.capabilities.find(c => c.backend === 'codex').models[0] ?? '';
    const cl = await window.nexus.createAgent({ name: 'Lead-Claude', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    const cx = await window.nexus.createAgent({ name: 'Lead-Codex', character: '', model: codexModel, backend: 'codex', cwd, permissionMode: 'ask' });
    const ag = await window.nexus.createAgent({ name: 'Lead-Agy', character: '', model: 'gemini-3.8-flash-low', backend: 'antigravity', cwd, permissionMode: 'ask' });
    await until('三個節點待命', async () => (await agents()).every(a => a.state === 'idle'), 60000);
    log('節點的模型', (await agents()).map(a => `${a.name}=${a.model || '預設'}`).join(' '));
    log('MODELS_READY');
    await wait(2500);

    const task = '請啟動兩個子代理(sub agent)平行工作:第一個列出目前資料夾的檔案名稱,第二個讀取 notes.txt 的內容。等兩個都回來後,用一句話總結。';
    if (!window.__ONLY_AGY__) {
      await runWithSubs(cl, task, 'claude');
      await until('Claude 的子節點自動移除', async () => (await kids(cl.id)).length === 0, 30000);
      log('claude 子節點已自動移除,節點總數', (await agents()).length);
      await openDialog('Lead-Claude');
      await shot('claude-after');
      await runWithSubs(cx, task, 'codex');
    }
    await runWithSubs(ag, '請用 invoke_subagent 工具啟動一個子代理,讓它列出目前資料夾的檔案名稱,然後把結果告訴我。', 'agy');
    await wait(1000);
    await shot('all-after');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
