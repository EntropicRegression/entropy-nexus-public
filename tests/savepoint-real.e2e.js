// session 存點的真實驗證(里程碑 S4,真正的 CLI,會用到一點額度)。由 tests/savepoint-real.sh 啟動,分兩個階段:
// A:建立測試節點 → 讓它記住一個暗號 → 終止(只存統計)並建立存點。
// (兩個階段之間由 savepoint-real-files.mjs 備份並刪掉這個測試節點的原始對話檔)
// B:從「開啟舊 session」接回 → 第一次應該要求確認還原 → 同意後還原並續接 → 問暗號,答得出來就代表接回原本的對話 → 再終止。
// window.__TEST_IMAGE__ 是「階段,後台,模型,暗號」。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 180000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(500); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 400)}` : ''}`); };
  const settled = id => async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === id && ['idle', 'error', 'lost'].includes(x.state));
  const lastReply = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).pop() ?? '';
  try {
    const [phase, backend, model = '', code] = String(window.__TEST_IMAGE__).split(',');
    const cwd = window.__TEST_CWD__;
    if (phase === 'A') {
      const a = await window.nexus.createAgent({ name: `存點測試-${backend}`, character: '', model, backend, cwd, permissionMode: 'ask' });
      await until('節點待命', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle'), 90000);
      await window.nexus.send(a.id, `這是一個測試。請記住這個暗號:${code}。不需要使用任何工具,只要回覆「記住了」。`);
      await wait(3000);
      await until('第一回合結束', settled(a.id), 240000);
      const s = (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id);
      expect('第一回合正常結束', s.state === 'idle', `${s.state} ${s.detail} ${await lastReply(a.id)}`);
      expect('有 sessionId', !!s.sessionId, s.sessionId);
      const r = await window.nexus.removeAgentArchived(a.id, 'stats', false);
      expect('終止時建立了存點', /已建立對話存點/.test(r.note), r.note);
      log('RESULT', JSON.stringify({ nodeId: a.id, sessionId: s.sessionId, note: r.note }));
    } else {
      const list = await window.nexus.listOldSessions();
      const s = list.find(x => x.source === 'nexus' && x.name === `存點測試-${backend}`);
      expect('「開啟舊 session」列得出測試節點', !!s, JSON.stringify(list.filter(x => x.source === 'nexus').map(x => x.name)));
      const input = { backend: s.backend, sessionId: s.sessionId, cwd: s.cwd, agentId: s.agentId, name: s.name, character: s.character, model: s.model };
      let asked = '';
      try { await window.nexus.openOldSession(input); } catch (e) { asked = String(e.message ?? e); }
      expect('原檔不在時先要求確認還原(沒有自動還原)', asked.includes('NEXUS_NEEDS_RESTORE:'), asked);
      const a = await window.nexus.openOldSession({ ...input, restoreFromSavepoint: true });
      await until('接回後待命', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle'), 120000);
      await window.nexus.send(a.id, '剛才請你記住的暗號是什麼?請只回覆暗號本身。不需要使用任何工具。');
      await wait(3000);
      await until('續接回合結束', settled(a.id), 240000);
      const reply = await lastReply(a.id);
      const st = (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id);
      expect('續接成功:答得出原本對話裡的暗號', reply.includes(code), `${st.state} ${reply}`);
      const errs = (await window.nexus.getHistory(a.id)).filter(e => e.type === 'error').map(e => String(e.message).slice(0, 160));
      expect('沒有錯誤', errs.length === 0, JSON.stringify(errs));
      const r = await window.nexus.removeAgentArchived(a.id, 'stats', false);
      log('RESULT', JSON.stringify({ nodeId: a.id, sessionId: st.sessionId, reply: reply.slice(0, 80), note: r.note }));
    }
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
    try { const s = await window.nexus.getSnapshot(); for (const a of s.agents) { const h = await window.nexus.getHistory(a.id); log(a.name, a.state, a.detail, JSON.stringify(h.filter(e => ['error', 'message', 'note'].includes(e.type)).slice(-6).map(e => `${e.type}:${String(e.message ?? e.text).slice(0, 120)}`))); } } catch { /* 略過 */ }
  }
  document.title = 'QUIT';
})();
