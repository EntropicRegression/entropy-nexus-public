// 驗收(真正的 CLI,會花少量額度):分支對話。Claude Code 與 Codex 各跑一次:
// 建立節點 → 說暗號 → 分支 → 在新節點問暗號 → 兩個 session id 不同 → 原節點仍可繼續。最後確認「開啟舊 session」每列都有分支按鈕。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 150000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); }
    throw new Error(`等不到:${what}`);
  };
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const ask = async (id, text) => {
    await window.nexus.send(id, text);
    await until('開始', async () => !DONE.includes((await agentOf(id)).state), 40000);
    await until('完成', async () => {
      const a = await agentOf(id);
      if (a.pendingApproval) await window.nexus.respondApproval(id, a.pendingApproval.requestId, 'deny');
      return DONE.includes(a.state);
    });
    await wait(800);
    return (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text ?? '';
  };
  const clean = e => String(e.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  let pass = 0, fail = 0;
  const check = (label, ok, extra = '') => { if (ok) pass++; else fail++; log(ok ? 'PASS' : 'FAIL', label, extra); };

  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const caps = (await snap()).capabilities;
    log('能力', JSON.stringify(caps.map(c => ({ b: c.backend, available: c.available, fork: c.fork, v: c.version }))));
    check('Antigravity 宣告不支援分支', caps.find(c => c.backend === 'antigravity')?.fork === false);
    for (const [backend, model, secret] of [['claude', 'haiku', '6142'], ['codex', '', '8395']]) {
      const cap = caps.find(c => c.backend === backend);
      if (!cap?.available) { log('略過', backend, cap?.note); continue; }
      const src = await window.nexus.createAgent({ name: `${backend}-源`, character: '', model, backend, cwd, permissionMode: 'ask' });
      await until('待命', async () => (await agentOf(src.id)).state === 'idle', 60000);
      const r1 = await ask(src.id, `暗號是 ${secret}。請記住,只回覆「好」。`);
      const srcSession = (await agentOf(src.id)).sessionId;
      log(backend, '來源回覆', r1.slice(0, 40), '| session', srcSession);
      const fork = await window.nexus.forkAgent({ source: { kind: 'agent', agentId: src.id }, name: `${backend}-源-分支` });
      await until('分支待命', async () => (await agentOf(fork.id)).state === 'idle', 60000);
      const before = await agentOf(fork.id);
      log(backend, '分支啟動後', before.detail, '| session', before.sessionId);
      const r2 = await ask(fork.id, '剛才的暗號是多少?只回答數字。');
      const forkSession = (await agentOf(fork.id)).sessionId;
      log(backend, '分支回覆', r2.slice(0, 40), '| session', forkSession);
      check(`${backend} 分支記得暗號`, r2.includes(secret), r2.slice(0, 60));
      check(`${backend} 兩個 session id 不同`, Boolean(forkSession) && Boolean(srcSession) && forkSession !== srcSession, `${srcSession} / ${forkSession}`);
      const r3 = await ask(src.id, '剛才的暗號是多少?只回答數字。');
      check(`${backend} 原節點仍可繼續`, r3.includes(secret) && (await agentOf(src.id)).sessionId === srcSession, r3.slice(0, 60));
      // 分支休眠再喚醒,確認用的是自己的 session
      await window.nexus.sleep(fork.id);
      await window.nexus.wake(fork.id);
      const woke = await until('分支喚醒', async () => { const a = await agentOf(fork.id); return DONE.includes(a.state) && a; }, 60000);
      check(`${backend} 分支喚醒後用自己的 session 續接`, woke.detail === '已續接' && woke.sessionId === forkSession, `${woke.state} ${woke.detail} ${woke.sessionId}`);
    }
    // 「開啟舊 session」每列都有分支按鈕
    document.querySelector('.add.old').click();
    await until('清單載入', () => document.querySelectorAll('.os-row').length > 0, 60000);
    await wait(800);
    const rows = [...document.querySelectorAll('.os-row')];
    const forkBtns = rows.map(r => [...r.querySelectorAll('button')].find(b => b.textContent === '分支'));
    log('舊 session 列數', rows.length, '| 有分支按鈕', forkBtns.filter(Boolean).length, '| 可用', forkBtns.filter(b => b && !b.disabled).length);
    check('舊 session 每列都有分支按鈕', rows.length > 0 && forkBtns.every(Boolean));
    const first = forkBtns.find(b => b && !b.disabled);
    if (first) { first.click(); await until('分支面板', () => document.querySelector('.os-fork .fork-panel'), 5000); await shot('fork-real-oldsessions'); }
  } catch (err) {
    log('FAIL 例外', clean(err));
  }
  log(`結果 PASS=${pass} FAIL=${fail}`);
  document.title = 'QUIT';
})();
