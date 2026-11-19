// 驗收:任務面板自動填入任務、狀態與執行者。會啟動三家真正的 CLI。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const agent = async id => (await snap()).agents.find(a => a.id === id);
  const tasksOf = async id => (await snap()).tasks.filter(t => t.agentId === id);
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 200000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); }
    throw new Error(`等不到:${what}`);
  };
  const fmt = t => `[${t.status}] ${t.agentName}${t.model ? `/${t.model}` : ''} 「${t.title.slice(0, 24)}…」 步驟 ${t.steps.filter(s => s.status === 'done').length}/${t.steps.length} 子代理 ${JSON.stringify(t.subs.map(s => `${s.name}:${s.status}`))}${t.note ? ` 備註:${t.note}` : ''}`;
  const panel = () => [...document.querySelectorAll('.tasks .task')].map(el => `${el.querySelector('.task-status').textContent}|${el.querySelector('.task-who').textContent.trim()}`);

  try {
    const cwd = window.__TEST_CWD__;
    const cl = await window.nexus.createAgent({ name: 'Claude-T', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    const cx = await window.nexus.createAgent({ name: 'Codex-T', character: '', model: '', backend: 'codex', cwd, permissionMode: 'ask' });
    const ag = await window.nexus.createAgent({ name: 'Agy-T', character: '', model: 'gemini-3.8-flash-low', backend: 'antigravity', cwd, permissionMode: 'ask' });
    await until('三個節點待命', async () => (await snap()).agents.every(a => a.state === 'idle'), 60000);
    log('一開始的任務數', (await snap()).tasks.length, '| 面板顯示', document.querySelector('.tasks .empty')?.textContent);

    // 三個節點同時各接一個任務
    await window.nexus.send(cl.id, '請啟動兩個子代理平行工作:第一個列出目前資料夾的檔案名稱,第二個讀取 notes.txt 的內容。等兩個都回來後,用一句話總結。');
    await window.nexus.send(cx.id, '請先用你的計畫工具(update_plan)列出三個步驟,然後依序建立 s1.txt、s2.txt、s3.txt,內容都是 ok,每完成一步就更新計畫。');
    await window.nexus.send(ag.id, '請寫一篇至少三千字的文章介紹太陽系的八大行星,每個行星都要詳細說明。');
    await wait(1500);
    log('送出後面板', JSON.stringify(panel()));

    let shotRunning = false, sawAwaiting = false, interrupted = false;
    const t0 = Date.now();
    await until('Claude 與 Codex 完成', async () => {
      const s = await snap();
      for (const a of s.agents) {
        if (!a.pendingApproval) continue;
        if (!sawAwaiting) { sawAwaiting = true; log('待授權時的任務狀態', s.tasks.find(t => t.agentId === a.id && t.endedAt === null)?.status, '| 面板', JSON.stringify(panel())); await shot('1-awaiting'); }
        await window.nexus.respondApproval(a.id, a.pendingApproval.requestId, 'allow');
      }
      if (!shotRunning && s.tasks.some(t => t.subs.some(x => x.status === 'running'))) { shotRunning = true; await shot('2-running-subs'); }
      // 讓 Antigravity 跑幾秒後中斷它
      if (!interrupted && Date.now() - t0 > 7000) { interrupted = true; await window.nexus.interrupt(ag.id); }
      const c = s.agents.find(a => a.id === cl.id), x = s.agents.find(a => a.id === cx.id);
      return DONE.includes(c.state) && DONE.includes(x.state);
    }, 260000);
    await until('Agy 結束', async () => DONE.includes((await agent(ag.id)).state), 60000);
    await wait(1500);
    for (const t of (await snap()).tasks) log('任務', fmt(t));
    log('面板最終顯示', JSON.stringify(panel()), '| 標題列', document.querySelector('.tasks-count').textContent);
    await shot('3-finished');

    // 點任務會開啟該節點的對話視窗
    document.querySelector('.tasks .task').click();
    await wait(600);
    log('點任務後開啟的對話視窗', document.querySelector('.dlg-id b')?.textContent);

    // 第二個任務:同一個節點再下一句,面板應該多一筆
    await window.nexus.send(cl.id, '只回覆兩個字:OK');
    await wait(800);
    await until('Claude 第二個任務完成', async () => DONE.includes((await agent(cl.id)).state), 60000);
    await wait(800);
    log('Claude-T 的任務數', (await tasksOf(cl.id)).length, (await tasksOf(cl.id)).map(t => t.status).join(','));
    await shot('4-second-task');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
