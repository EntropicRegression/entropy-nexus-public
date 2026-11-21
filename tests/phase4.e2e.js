// 階段 4 驗收腳本:三家節點並存;做不到的功能在畫面上有標示(見 README 的 NEXUS_TEST_SCRIPT)。
// 會啟動真正的 Claude Code、Codex 與 Antigravity,因此會用到一點訂閱額度。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const until = async (what, fn, timeout = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(300); }
    throw new Error(`等不到:${what}`);
  };
  const agents = async () => (await window.nexus.getSnapshot()).agents;
  const agent = async id => (await agents()).find(a => a.id === id);
  const stateIs = (id, ...states) => async () => { const a = await agent(id); return a && states.includes(a.state) ? a : null; };
  const button = label => [...document.querySelectorAll('.dialog button')].find(b => b.textContent.trim() === label);
  const type = text => {
    const ta = document.querySelector('.dlg-input textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const say = async text => { type(text); await wait(200); button('送出').click(); };
  const openDialog = async name => { window.__nexusSelect(name); await wait(600); };
  const history = id => window.nexus.getHistory(id);
  const lastReply = async id => (await history(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;
  const DONE = ['idle', 'error', 'lost'];
  const summary = async () => (await agents()).map(a => `${a.name}=${a.state}${a.detail ? `(${a.detail})` : ''}`).join(' ');

  try {
    const cwd = window.__TEST_CWD__;
    const caps = (await window.nexus.getSnapshot()).capabilities;
    for (const c of caps) log('capability', c.backend, 'available', c.available, 'simulated', c.simulated, 'approvals', c.approvals, '|', c.note);

    // 1. 三家節點並存
    const cl = await window.nexus.createAgent({ name: 'Claude-1', backend: 'claude', cwd, permissionMode: 'ask' });
    const cx = await window.nexus.createAgent({ name: 'Codex-1', backend: 'codex', cwd, permissionMode: 'ask' });
    const ag = await window.nexus.createAgent({ name: 'Agy-1', backend: 'antigravity', cwd, permissionMode: 'ask' });
    await until('三個節點待命', async () => (await agents()).every(a => a.state === 'idle'));
    log('三個節點都已待命', await summary(), '| Agy session', (await agent(ag.id)).sessionId);

    // 2. 三個同時工作;Antigravity 在對話視窗下指令
    await openDialog('Agy-1');
    log('Agy 對話視窗的標示', [...document.querySelectorAll('.dialog .tag-auto')].map(e => e.textContent).join(',') || '(無)');
    await say('請在目前資料夾建立 agy.txt,內容是「階段 4 驗收」。完成後只回覆「完成」。');
    await window.nexus.send(cl.id, '請用 Write 工具在目前資料夾建立 claude.txt,內容是「階段 4 驗收」。完成後只回覆「完成」。');
    await window.nexus.send(cx.id, '請在目前資料夾建立 codex.txt,內容是「階段 4 驗收」。完成後只回覆「完成」。');
    await wait(2000);
    log('同時執行中', await summary());
    await shot('1-three-running');
    await until('三個節點完成', async () => {
      for (const a of await agents()) {
        if (a.pendingApproval) { log(a.name, '要求授權', a.pendingApproval.tool, a.pendingApproval.summary); await window.nexus.respondApproval(a.id, a.pendingApproval.requestId, 'allow'); }
      }
      return (await agents()).every(a => DONE.includes(a.state));
    }, 200000);
    await wait(1500);
    log('完成後狀態', await summary());
    log('Agy 回覆', JSON.stringify(await lastReply(ag.id)));
    log('Agy 工具活動', JSON.stringify((await history(ag.id)).filter(e => e.type === 'tool').map(e => `${e.phase}:${e.name}:${e.summary}${e.failed ? ':失敗' : ''}`)));
    await shot('2-agy-done');

    // 3. Antigravity 自動拒絕工作目錄外的動作,畫面上要看得到
    await say('請在目前資料夾的上一層建立 outside.txt,內容是 x。若被拒絕,只回覆「被拒絕」。');
    await until('Agy 開始', stateIs(ag.id, 'planning', 'working'), 30000);
    await until('Agy 結束', stateIs(ag.id, ...DONE));
    await wait(1200);
    log('Agy 被拒絕後狀態', (await agent(ag.id)).state, '| 錯誤訊息', JSON.stringify((await history(ag.id)).filter(e => e.type === 'error').map(e => e.message.slice(0, 80))), '| 回覆', JSON.stringify(await lastReply(ag.id)));
    await shot('3-agy-denied');

    // 4. Antigravity 中斷(結束行程後續接)
    // 被自動拒絕後 agy 會直接結束那一回合,下一句話常被當成上一題的延續;先用一句話把對話帶回正軌
    await say('了解。請只回覆 OK。');
    await until('Agy 回應中', stateIs(ag.id, 'planning', 'working'), 30000);
    await until('Agy 回應完', stateIs(ag.id, ...DONE));
    await wait(800);
    await say('請寫一篇至少三千字的文章介紹太陽系的八大行星,每個行星都要詳細說明。');
    await until('Agy 開始執行', stateIs(ag.id, 'planning', 'working'), 30000);
    await wait(3000);
    if (button('中斷')) {
      button('中斷').click();
      const afterInt = await until('Agy 中斷後待命', stateIs(ag.id, ...DONE), 40000);
      log('Agy 中斷後狀態', afterInt.state, afterInt.detail, '| 最後回覆', JSON.stringify(await lastReply(ag.id)));
    } else {
      log('Agy 在 3 秒內就結束了,這次沒有測到中斷');
      await until('Agy 結束', stateIs(ag.id, ...DONE));
    }

    // 5. Antigravity 休眠後喚醒並續接
    button('休眠').click();
    await until('Agy 休眠', stateIs(ag.id, 'sleeping'), 20000);
    await wait(500);
    button('喚醒').click();
    const woke = await until('Agy 喚醒', stateIs(ag.id, ...DONE), 40000);
    log('Agy 喚醒後狀態', woke.state, woke.detail);
    await say('你一開始建立的檔案叫什麼名字?只回答檔名。');
    await until('Agy 回答中', stateIs(ag.id, 'planning', 'working'), 30000);
    await until('Agy 回答完', stateIs(ag.id, ...DONE));
    await wait(1200);
    log('Agy 續接後的回覆', JSON.stringify(await lastReply(ag.id)));
    await shot('4-agy-resumed');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
