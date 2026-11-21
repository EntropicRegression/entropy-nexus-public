// 階段 6 驗收(真實 CLI):回答 agent 的提問、回覆即時串流、舊 session 的使用中標示。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text;
  // 計算收到的串流片段
  const deltas = {};
  window.nexus.onUpdate(u => { if (u.delta) deltas[u.delta.agentId] = (deltas[u.delta.agentId] ?? 0) + 1; });

  try {
    const cwd = window.__TEST_CWD__;
    const cl = await window.nexus.createAgent({ name: 'Claude-6', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
    const cx = await window.nexus.createAgent({ name: 'Codex-6', character: '', model: '', backend: 'codex', cwd, permissionMode: 'ask' });
    await until('兩個節點待命', async () => (await snap()).agents.every(a => a.state === 'idle'), 60000);

    // Claude:提問 → 在對話視窗作答
    window.__nexusSelect('Claude-6');
    await wait(500);
    await window.nexus.send(cl.id, '請用 AskUserQuestion 工具問我一個問題:「要用哪種顏色?」選項是紅色、藍色、綠色。我回答之後,用一句話告訴我你收到的答案。');
    await until('Claude 的提問出現在對話視窗', () => document.querySelector('.dlg-question'), 60000);
    const a1 = await agentOf(cl.id);
    log('Claude 提問', a1.state, a1.detail, '| 題目', document.querySelector('.q-text')?.textContent, '| 選項', [...document.querySelectorAll('.q-options button')].map(b => b.textContent).join('/'), '| 任務狀態', (await snap()).tasks.find(t => t.agentId === cl.id)?.status);
    await shot('1-claude-question');
    [...document.querySelectorAll('.q-options button')].find(b => b.textContent === '藍色').click();
    await wait(200);
    [...document.querySelectorAll('.dlg-question button')].find(b => b.textContent === '送出回答').click();
    await until('Claude 完成', async () => DONE.includes((await agentOf(cl.id)).state));
    await wait(800);
    log('Claude 收到的答案', JSON.stringify(await lastReply(cl.id)), '| 串流片段數', deltas[cl.id] ?? 0);

    // Claude:長一點的回覆,確認邊生成邊顯示
    let liveSeen = 0, liveMax = 0;
    const w = setInterval(() => { const el = document.querySelector('.msg.live p'); if (el) { liveSeen++; liveMax = Math.max(liveMax, el.textContent.length); } }, 50);
    await window.nexus.send(cl.id, '用大約一百五十個字介紹月球。');
    await until('Claude 開始', async () => !DONE.includes((await agentOf(cl.id)).state), 30000);
    await until('Claude 完成', async () => DONE.includes((await agentOf(cl.id)).state));
    clearInterval(w);
    await wait(600);
    const final = await lastReply(cl.id);
    log('Claude 串流:畫面上看到生成中文字的次數', liveSeen, '| 生成中最長', liveMax, '| 最終長度', final.length, '| 結束後生成中區塊已清除', !document.querySelector('.msg.live'));

    // Codex:串流,並試一次提問
    await window.nexus.send(cx.id, '用大約八十個字介紹火星。');
    await until('Codex 開始', async () => !DONE.includes((await agentOf(cx.id)).state), 30000);
    await until('Codex 完成', async () => DONE.includes((await agentOf(cx.id)).state));
    await wait(600);
    log('Codex 串流片段數', deltas[cx.id] ?? 0, '| 回覆長度', (await lastReply(cx.id))?.length);
    await window.nexus.send(cx.id, '如果你有向使用者提問的工具(request_user_input),請用它問我:「要用哪種顏色?」選項是紅色、藍色。沒有這個工具就只回覆「沒有提問工具」。');
    await until('Codex 開始', async () => !DONE.includes((await agentOf(cx.id)).state), 30000);
    let asked = false;
    await until('Codex 完成', async () => {
      const a = await agentOf(cx.id);
      if (a.pendingQuestion) { asked = true; log('Codex 提問', JSON.stringify(a.pendingQuestion.questions.map(q => [q.question, q.options.map(o => o.label)]))); await window.nexus.answerQuestion(cx.id, a.pendingQuestion.requestId, Object.fromEntries(a.pendingQuestion.questions.map(q => [q.id, ['藍色']]))); }
      if (a.pendingApproval) await window.nexus.respondApproval(cx.id, a.pendingApproval.requestId, 'allow');
      return DONE.includes(a.state);
    });
    await wait(600);
    log('Codex 是否提問', asked, '| 回覆', JSON.stringify(String(await lastReply(cx.id)).slice(0, 80)));

    // 舊 session 清單的使用中標示
    const list = await window.nexus.listOldSessions();
    const active = list.filter(s => s.maybeActive);
    log('舊 session 總數', list.length, '| 標示可能使用中', active.length, '| 例', JSON.stringify(active.slice(0, 2).map(s => `${s.backend}:${s.title.slice(0, 16)}`)));
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
