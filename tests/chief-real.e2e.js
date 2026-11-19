// 總管候選模型的比較測試(真正的 CLI,會用到額度),在獨立的測試主控台裡執行。
// 建立兩個被分派的節點,再依序把每個候選模型建成總管(每次詢問模式),各送同一組指令,
// 主控台只轉出 [test] 開頭的畫面訊息,所以結果以「[test] [result] <JSON>」印出。
// 記錄:工具呼叫、交給了誰、授權次數、回覆內容與耗時。結果以 [result] JSON 印出,由 chief-real.sh 整理成報告。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(500); } return null; };
  const snap = () => window.nexus.getSnapshot();
  const agentOf = async id => (await snap()).agents.find(a => a.id === id);
  const BUSY = ['planning', 'working', 'awaiting'];
  const CANDIDATES = [
    { label: 'Orchestrator (Neon)', backend: 'antigravity', model: 'gemini-pro-orchestrator-neon' },
    { label: 'Gemini 4 Neon (Medium)', backend: 'antigravity', model: 'gemini-4-neon-medium' },
    { label: 'Claude Sonnet', backend: 'claude', model: 'sonnet' },
    { label: 'Gemini 4 Hydrogen (Medium)(對照)', backend: 'antigravity', model: 'gemini-4-hydrogen-medium' },
  ];
  const PROMPTS = [
    { key: 'named', text: '請 Hagemi 用一句話告訴我一加一等於多少。', expect: '交給 Hagemi' },
    { key: 'status', text: '幫我看看大家現在在忙什麼。', expect: '用 list_nodes 回答,不需要分派' },
    { key: 'vague', text: '幫我把那個改一下。', expect: '先問清楚,不分派' },
    { key: 'route', text: '找一個節點幫我把「早安」翻成英文。', expect: '自己挑一個節點交辦' },
  ];
  const TURN_MS = 6 * 60 * 1000;
  // 每次詢問模式:主控台發出的「呼叫節點」與 CLI 自己的授權一律允許,並記下來
  const approvals = [];
  setInterval(async () => {
    for (const a of (await snap()).agents) {
      const p = a.pendingApproval;
      if (!p || approvals.some(x => x.requestId === p.requestId)) continue;
      approvals.push({ agentId: a.id, requestId: p.requestId, tool: p.tool, summary: p.summary, ts: Date.now() });
      void window.nexus.respondApproval(a.id, p.requestId, 'allow');
    }
  }, 400);
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, model, extra = {}) => window.nexus.createAgent({ name, character: '', model, backend, cwd, permissionMode: 'auto', ...extra });
    const caps = (await snap()).capabilities;
    log('後台', JSON.stringify(caps.map(c => [c.backend, c.available, c.version])));
    const hagemi = await mk('Hagemi', 'antigravity', 'gemini-3.8-flash-low');
    const mochii = await mk('mochii', 'claude', 'haiku');
    const targets = { [hagemi.id]: 'Hagemi', [mochii.id]: 'mochii' };
    await until(async () => (await snap()).agents.filter(a => targets[a.id]).every(a => a.state === 'idle'), 120000);
    log('被分派的節點已就緒');

    for (const cand of CANDIDATES) {
      const name = `總管-${cand.model}`;
      let chief;
      try { chief = await mk(name, cand.backend, cand.model, { permissionMode: 'ask', chief: true }); }
      catch (e) { console.log('[test] [result] ' + JSON.stringify({ candidate: cand.label, error: `建立失敗:${e.message}` })); continue; }
      const ready = await until(async () => { const a = await agentOf(chief.id); return a && (a.state === 'idle' || a.state === 'error') ? a : null; }, 180000);
      if (!ready || ready.state === 'error') { console.log('[test] [result] ' + JSON.stringify({ candidate: cand.label, error: `啟動失敗:${ready?.detail ?? '逾時'}` })); await window.nexus.removeAgent(chief.id); continue; }
      log('開始測試', cand.label);
      for (const p of PROMPTS) {
        // 等被分派的節點都閒下來,避免上一題的工作影響這一題
        await until(async () => (await snap()).agents.filter(a => targets[a.id]).every(a => !BUSY.includes(a.state)), 120000);
        const seqBefore = Math.max(0, ...(await window.nexus.getHistory(chief.id)).map(e => e.seq));
        const targetBefore = {};
        for (const id of Object.keys(targets)) targetBefore[id] = Math.max(0, ...(await window.nexus.getHistory(id)).map(e => e.seq));
        const t0 = Date.now();
        await window.nexus.send(chief.id, p.text);
        await until(async () => BUSY.includes((await agentOf(chief.id))?.state), 30000);
        const done = await until(async () => { const a = await agentOf(chief.id); return a && !BUSY.includes(a.state) ? a : null; }, TURN_MS);
        const ms = Date.now() - t0;
        const ev = (await window.nexus.getHistory(chief.id)).filter(e => e.seq > seqBefore);
        const tools = ev.filter(e => e.type === 'tool' && e.phase === 'start').map(e => `${e.name}${e.summary ? `:${String(e.summary).slice(0, 80)}` : ''}`);
        const replies = ev.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text);
        const firstReplyMs = (ev.find(e => e.type === 'message' && e.role === 'agent')?.ts ?? 0) - t0;
        const dispatched = [];
        for (const [id, tname] of Object.entries(targets)) {
          const got = (await window.nexus.getHistory(id)).filter(e => e.seq > targetBefore[id] && e.type === 'message' && e.role === 'user' && e.text.includes(`來自節點「${name}」`));
          for (const g of got) dispatched.push({ to: tname, prompt: g.text.replace(/^\(主控台:[^\n]*\n\n/, '').slice(0, 400) });
        }
        const asked = approvals.filter(x => x.agentId === chief.id && x.ts >= t0).map(x => `${x.tool}:${String(x.summary).slice(0, 60)}`);
        console.log('[test] [result] ' + JSON.stringify({
          candidate: cand.label, model: cand.model, prompt: p.key, text: p.text, expect: p.expect,
          state: done?.state ?? '逾時', ms, firstReplyMs: firstReplyMs > 0 ? firstReplyMs : null,
          tools, dispatched, approvals: asked, reply: replies.join('\n\n').slice(-1500),
        }));
        // 回合卡住(逾時):中斷再進下一題
        if (!done) { await window.nexus.interrupt(chief.id); await until(async () => !BUSY.includes((await agentOf(chief.id))?.state), 60000); }
      }
      await window.nexus.removeAgent(chief.id);
      await wait(1500);
    }
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
