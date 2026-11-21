// 階段 8 驗收(真實的 Claude Code):附加圖片、換模型、終端機模式。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); document.title = `SHOT:${name}-b`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); } throw new Error(`等不到:${what}`); };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;
  const ask = async (id, text, images) => {
    await window.nexus.send(id, text, images);
    await until('開始', async () => !DONE.includes((await agentOf(id)).state), 40000);
    await until('完成', async () => { const a = await agentOf(id); if (a.pendingApproval) await window.nexus.respondApproval(id, a.pendingApproval.requestId, 'allow'); return DONE.includes(a.state); });
    await wait(700);
    return lastReply(id);
  };
  const btn = label => [...document.querySelectorAll('.dlg-id button')].find(b => b.textContent.trim() === label);

  try {
    const cwd = window.__TEST_CWD__;
    const a = await window.nexus.createAgent({ name: 'Claude-8', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    await until('待命', async () => (await agentOf(a.id)).state === 'idle', 60000);
    window.__nexusSelect('Claude-8');
    await wait(600);

    // 1. 附加圖片:模型要真的看得到圖片內容
    const reply = await ask(a.id, '附上的圖片裡,大六邊形裡面有幾個實心的小六邊形?它們各是什麼顏色?用一句話回答。\n\n附加的檔案:\n- ' + window.__TEST_IMAGE__, [window.__TEST_IMAGE__]);
    log('圖片附加後的回覆', JSON.stringify(reply));
    await ask(a.id, '請記住暗號 6157。只回覆「好」。');

    // 2. 換模型:重新啟動 session,對話內容保留
    const before = (await agentOf(a.id)).sessionId;
    await window.nexus.updateAgent(a.id, { model: 'claude-haiku-5-5', name: 'Claude-8 改' });
    await until('換模型後回到待命', async () => { const x = await agentOf(a.id); return x.model === 'claude-haiku-5-5' && x.state === 'idle' && x.detail === '已續接'; }, 60000);
    log('MODEL_CHANGED');
    await wait(2500);
    const after = await agentOf(a.id);
    log('換模型後', after.name, after.model, after.state, after.detail, '| session 相同', after.sessionId === before, '| 識別列', document.querySelector('.dlg-id b')?.textContent, document.querySelector('.tag-model')?.textContent);
    log('換模型後還記得', JSON.stringify(await ask(a.id, '暗號是多少?只回答數字。')));

    // 3. 終端機模式:切過去、在原生 CLI 裡打字、切回來
    btn('終端機').click();
    await until('進入終端機模式', async () => (await agentOf(a.id)).terminal && document.querySelector('.dlg-terminal') && window.__nexusTerm, 30000);
    const text = () => window.__nexusTerm.text();
    await until('原生 CLI 的畫面出現', () => text().replace(/\s/g, '').length > 40, 40000);
    await wait(3000);
    const mid = await agentOf(a.id);
    log('終端機模式中', mid.state, mid.detail, '| 畫面字數', text().replace(/\s/g, '').length, '| 片段', JSON.stringify(text().split('\n').map(l => l.trim()).filter(Boolean).slice(0, 4).join(' / ').slice(0, 160)));
    await shot('1-terminal');
    // 新資料夾第一次用互動模式可能會問是否信任資料夾:按 Enter 接受預設
    // 預設選項是「No, exit」,要先按向下鍵選「Yes, I trust this folder」
    if (/trust|信任/i.test(text())) { await window.nexus.termWrite(a.id, '\x1b[B'); await wait(500); await window.nexus.termWrite(a.id, '\r'); await wait(4000); log('已在終端機裡選擇信任資料夾'); }
    await window.nexus.termWrite(a.id, '再記一個暗號 8833,只回覆 OK');
    await wait(600);
    await window.nexus.termWrite(a.id, '\r');
    const replied = await until('原生 CLI 回覆', () => /8833[\s\S]*OK/.test(text()) && text().split('OK').length > 2 ? true : null, 60000).catch(() => false);
    await wait(2500);
    log('在終端機裡送出指令並收到回覆', Boolean(replied), '| 尾端', JSON.stringify(text().split('\n').map(l => l.trim()).filter(Boolean).slice(-8).join(' / ').slice(-220)));
    await shot('2-terminal-reply');
    btn('回到對話').click();
    await until('回到對話模式', async () => { const x = await agentOf(a.id); return !x.terminal && x.state === 'idle'; }, 60000);
    const back = await agentOf(a.id);
    log('回到對話模式', back.state, back.detail, '| session 相同', back.sessionId === before, '| 輸入欄回來了', Boolean(document.querySelector('.dlg-input textarea')));
    log('終端機裡說的內容在對話模式還記得', JSON.stringify(await ask(a.id, '我一共請你記了哪兩個暗號?只回答兩個數字。')));
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
