// 階段 2 驗收腳本:在應用程式的畫面裡執行(見 README 的 NEXUS_TEST_SCRIPT)。
// 會啟動兩個真正的 Claude Code 節點,因此會用到一點訂閱額度。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const until = async (what, fn, timeout = 120000) => {
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
  const openDialog = async name => { window.__nexusSelect(name); await wait(600); };

  try {
    const cwd = window.__TEST_CWD__;
    const caps = (await window.nexus.getSnapshot()).capabilities;
    log('capabilities', JSON.stringify(caps.map(c => [c.backend, c.available, c.simulated, c.version])));

    // 1. 兩個 Claude 節點同時執行
    const alpha = await window.nexus.createAgent({ name: 'Alpha', backend: 'claude', cwd, permissionMode: 'ask' });
    const beta = await window.nexus.createAgent({ name: 'Beta', backend: 'claude', cwd, permissionMode: 'ask' });
    await until('兩個節點待命', async () => (await stateIs(alpha.id, 'idle')()) && (await stateIs(beta.id, 'idle')()));
    log('兩個節點已啟動並待命');

    // 2. 在對話視窗對 Alpha 下指令;同時用 API 對 Beta 下指令
    await openDialog('Alpha');
    type('請用 Write 工具在目前資料夾建立 alpha.txt,內容是「階段 2 驗收」。完成後只回覆「完成」。');
    await wait(200);
    button('送出').click();
    await window.nexus.send(beta.id, '請用 Bash 執行 git --version,然後只回覆版本號。');
    await wait(1200);
    const both = (await window.nexus.getSnapshot()).agents.map(a => `${a.name}=${a.state}`).join(' ');
    log('同時執行中', both);

    // 3. Alpha 的寫檔請求出現在對話視窗,按「允許」
    await until('Alpha 的授權選項', () => document.querySelector('.dlg-approval'));
    log('授權選項按鈕', [...document.querySelectorAll('.dlg-approval button')].map(b => b.textContent).join(' | '));
    await shot('1-approval');
    button('允許').click();

    // Beta 若也要求授權(執行指令),一併允許
    await until('兩個節點完成', async () => {
      const b = await agent(beta.id);
      if (b.pendingApproval) { log('Beta 要求授權', b.pendingApproval.tool, b.pendingApproval.summary); await window.nexus.respondApproval(beta.id, b.pendingApproval.requestId, 'allow'); }
      const a = await agent(alpha.id);
      return a.state === 'idle' && b.state === 'idle';
    });
    await wait(1500);
    await shot('2-alpha-done');
    await openDialog('Beta');
    await wait(800);
    await shot('3-beta-done');

    // 4. 中斷:對 Alpha 下一個長任務,幾秒後按「中斷」
    await openDialog('Alpha');
    type('請寫一篇至少三千字的文章介紹太陽系的八大行星,每個行星都要詳細說明。');
    await wait(200);
    button('送出').click();
    await until('Alpha 開始執行', stateIs(alpha.id, 'planning', 'working'));
    await wait(1200);
    button('中斷').click();
    const afterInt = await until('Alpha 中斷後待命', stateIs(alpha.id, 'idle', 'error', 'lost'), 30000);
    log('中斷後狀態', afterInt.state, afterInt.detail);

    // 5. 休眠後喚醒(續接 session),確認它還記得
    button('休眠').click();
    await until('Alpha 休眠', stateIs(alpha.id, 'sleeping'), 20000);
    await wait(500);
    button('喚醒').click();
    const woke = await until('Alpha 喚醒', stateIs(alpha.id, 'idle', 'lost', 'error'), 30000);
    log('喚醒後狀態', woke.state, woke.detail, 'session', woke.sessionId);
    type('你剛才建立的檔案叫什麼名字?只回答檔名。');
    await wait(200);
    button('送出').click();
    await until('Alpha 回答', stateIs(alpha.id, 'planning', 'working'), 20000);
    await until('Alpha 回答完', stateIs(alpha.id, 'idle', 'error', 'lost'));
    await wait(1500);
    const hist = await window.nexus.getHistory(alpha.id);
    log('續接後的回覆', JSON.stringify(hist.filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text));
    await shot('4-resumed');

    // 6. 拒絕:再要求寫一個檔,按「拒絕」
    type('請用 Write 工具建立 denied.txt,內容是 x。');
    await wait(200);
    button('送出').click();
    await until('第二次授權選項', () => document.querySelector('.dlg-approval'));
    button('拒絕').click();
    await until('拒絕後完成', stateIs(alpha.id, 'idle', 'error', 'lost'));
    log('拒絕後狀態', (await agent(alpha.id)).state);
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
