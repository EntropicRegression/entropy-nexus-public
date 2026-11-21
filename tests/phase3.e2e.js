// 階段 3 驗收腳本:Claude 與 Codex 節點並存,操作方式一致(見 README 的 NEXUS_TEST_SCRIPT)。
// 會啟動真正的 Claude Code 與 Codex,因此會用到一點訂閱額度。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const until = async (what, fn, timeout = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(300); }
    throw new Error(`等不到:${what}`);
  };
  const agent = async id => (await window.nexus.getSnapshot()).agents.find(a => a.id === id);
  const stateIs = (id, ...states) => async () => { const a = await agent(id); return a && states.includes(a.state) ? a : null; };
  const button = label => [...document.querySelectorAll('.dialog button')].find(b => b.textContent.trim() === label);
  const type = text => {
    const ta = document.querySelector('.dlg-input textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const say = async text => { type(text); await wait(200); button('送出').click(); };
  const openDialog = async name => { window.__nexusSelect(name); await wait(600); };
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;
  const DONE = ['idle', 'error', 'lost'];

  try {
    const cwd = window.__TEST_CWD__;
    const caps = (await window.nexus.getSnapshot()).capabilities;
    log('capabilities', JSON.stringify(caps.map(c => [c.backend, c.available, c.simulated, c.version, c.note])));

    // 1. 同一面板上 Claude 與 Codex 節點並存
    const cl = await window.nexus.createAgent({ name: 'Claude-1', backend: 'claude', cwd, permissionMode: 'ask' });
    const cx = await window.nexus.createAgent({ name: 'Codex-1', backend: 'codex', cwd, permissionMode: 'ask' });
    await until('兩個節點待命', async () => (await stateIs(cl.id, 'idle')()) && (await stateIs(cx.id, 'idle')()));
    log('Claude 與 Codex 節點都已待命;Codex session', (await agent(cx.id)).sessionId);

    // 2. 在對話視窗對 Codex 下指令,同時讓 Claude 也工作
    await openDialog('Codex-1');
    await say('請在目前資料夾建立 codex.txt,內容是「階段 3 驗收」。完成後只回覆「完成」。');
    await window.nexus.send(cl.id, '請用 Write 工具在目前資料夾建立 claude.txt,內容是「階段 3 驗收」。完成後只回覆「完成」。');
    await wait(1500);
    log('同時執行中', (await window.nexus.getSnapshot()).agents.map(a => `${a.name}=${a.state}`).join(' '));

    // 3. 兩邊的授權請求都用同一組按鈕處理
    let codexApprovals = 0, shotTaken = false;
    await until('兩個節點完成', async () => {
      const c = await agent(cl.id);
      if (c.pendingApproval) { log('Claude 要求授權', c.pendingApproval.tool, c.pendingApproval.summary); await window.nexus.respondApproval(cl.id, c.pendingApproval.requestId, 'allow'); }
      if (document.querySelector('.dlg-approval')) {
        const x = await agent(cx.id);
        log('Codex 要求授權', x.pendingApproval?.tool, x.pendingApproval?.summary, '| 按鈕:', [...document.querySelectorAll('.dlg-approval button')].map(b => b.textContent).join(' / '));
        if (!shotTaken) { shotTaken = true; await shot('1-codex-approval'); }
        button('允許').click();
        codexApprovals++;
        await wait(600);
      }
      const x = await agent(cx.id);
      return DONE.includes(c.state) && DONE.includes(x.state);
    });
    await wait(1500);
    log('完成後狀態', (await window.nexus.getSnapshot()).agents.map(a => `${a.name}=${a.state}${a.detail ? `(${a.detail})` : ''}`).join(' '), '| Codex 核准次數', codexApprovals);
    log('Codex 回覆', JSON.stringify(await lastReply(cx.id)));
    await shot('2-codex-done');

    // 4. Codex 中斷
    await say('請寫一篇至少三千字的文章介紹太陽系的八大行星,每個行星都要詳細說明。');
    await until('Codex 開始執行', stateIs(cx.id, 'planning', 'working'));
    await wait(2500);
    button('中斷').click();
    const afterInt = await until('Codex 中斷後待命', stateIs(cx.id, ...DONE), 40000);
    log('Codex 中斷後狀態', afterInt.state, afterInt.detail);

    // 5. Codex 休眠後喚醒並續接
    button('休眠').click();
    await until('Codex 休眠', stateIs(cx.id, 'sleeping'), 20000);
    await wait(500);
    button('喚醒').click();
    const woke = await until('Codex 喚醒', stateIs(cx.id, ...DONE), 40000);
    log('Codex 喚醒後狀態', woke.state, woke.detail);
    await say('你剛才建立的檔案叫什麼名字?只回答檔名。');
    await until('Codex 回答中', stateIs(cx.id, 'planning', 'working'), 20000);
    await until('Codex 回答完', stateIs(cx.id, ...DONE));
    await wait(1200);
    log('Codex 續接後的回覆', JSON.stringify(await lastReply(cx.id)));
    await shot('3-codex-resumed');

    // 6. Codex 拒絕
    await say('請執行指令 git init,然後回報結果。');
    const denied = await until('Codex 的授權請求或完成', async () => document.querySelector('.dlg-approval') || (await stateIs(cx.id, ...DONE)()), 90000);
    if (denied instanceof Element) {
      button('拒絕').click();
      await until('Codex 拒絕後完成', stateIs(cx.id, ...DONE), 90000);
      log('Codex 拒絕後狀態', (await agent(cx.id)).state, '| 回覆', JSON.stringify(await lastReply(cx.id)));
    } else {
      log('Codex 沒有要求授權就完成了', JSON.stringify(await lastReply(cx.id)));
    }
    await openDialog('Claude-1');
    await wait(800);
    await shot('4-claude-side');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
