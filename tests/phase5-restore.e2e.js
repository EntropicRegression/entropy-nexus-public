// 階段 5 驗收:關閉再開啟後節點與對話紀錄都在,而且可以續接。
// 同一份資料跑兩次:第一次(沒有節點)建立節點並對話後正常結束;第二次檢查還原並續接。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const until = async (what, fn, timeout = 120000) => {
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
  const openDialog = async name => { [...document.querySelectorAll('.row')].find(r => r.textContent.includes(name)).click(); await wait(700); };
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;
  const DONE = ['idle', 'error', 'lost'];

  try {
    const snap = await window.nexus.getSnapshot();
    log('可用角色', JSON.stringify(snap.characters), '| 同時上限', snap.maxActive);

    if (snap.agents.length === 0) {
      // ---- 第一次:建立節點、對話、正常結束
      const cwd = window.__TEST_CWD__;
      const a = await window.nexus.createAgent({ name: 'Keeper', character: snap.characters[0] ?? '', backend: 'claude', cwd, permissionMode: 'ask' });
      const b = await window.nexus.createAgent({ name: 'Codex-K', character: '', backend: 'codex', cwd, permissionMode: 'ask' });
      await until('兩個節點待命', async () => (await agents()).every(x => x.state === 'idle'));
      await openDialog('Keeper');
      await say('請記住數字 5521。只回覆「好」。');
      await window.nexus.send(b.id, '請記住數字 8840。只回覆「好」。');
      await wait(1000);
      await until('兩個節點完成', async () => (await agents()).every(x => DONE.includes(x.state)));
      await wait(1200);
      log('第一次:回覆', JSON.stringify(await lastReply(a.id)), JSON.stringify(await lastReply(b.id)));
      await window.nexus.setMaxActive(3);
      await shot('1-before-close');
      log('第一次完成,正常結束');
    } else {
      // ---- 第二次:檢查還原
      log('第二次:還原的節點', snap.agents.map(x => `${x.name}=${x.state}/${x.backend}/角色:${x.character || '預設'}/session:${x.sessionId ? '有' : '無'}`).join(' '), '| 同時上限', snap.maxActive);
      const a = snap.agents.find(x => x.name === 'Keeper');
      const b = snap.agents.find(x => x.name === 'Codex-K');
      await openDialog('Keeper');
      const shown = [...document.querySelectorAll('.dlg-stream .msg p')].map(p => p.textContent);
      log('第二次:對話視窗裡還原的訊息', JSON.stringify(shown));
      log('第二次:立繪使用圖檔', Boolean(document.querySelector('.portrait-frame img')), '| 輸入欄停用', document.querySelector('.dlg-input textarea').disabled);
      await shot('2-restored-sleeping');
      button('喚醒').click();
      await until('Keeper 喚醒', stateIs(a.id, ...DONE), 40000);
      await window.nexus.wake(b.id);
      await until('Codex-K 喚醒', stateIs(b.id, ...DONE), 40000);
      log('喚醒後', (await agents()).map(x => `${x.name}=${x.state}(${x.detail})`).join(' '));
      await say('我請你記住的數字是多少?只回答數字。');
      await window.nexus.send(b.id, '我請你記住的數字是多少?只回答數字。');
      await wait(1000);
      await until('兩個節點回答完', async () => (await agents()).every(x => DONE.includes(x.state)));
      await wait(1200);
      log('第二次:續接後的回覆 Keeper', JSON.stringify(await lastReply(a.id)), '| Codex-K', JSON.stringify(await lastReply(b.id)));
      await shot('3-resumed');
      log('第二次完成');
    }
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
