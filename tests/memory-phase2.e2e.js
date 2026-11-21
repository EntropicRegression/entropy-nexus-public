// 驗收:長期記憶階段 2(假資料模式,主控台這一側;由 tests/memory-phase2.sh 啟動,需要 NEXUS_FAKE=1、NEXUS_FAKE_ECHO=1)。
// 建立總管 Chief 與一般節點 Worker,印出它們的 id,之後由 tests/memory-phase2-client.mjs 扮演兩個節點的 CLI 呼叫記憶工具。
// 用戶端做完後會讓 Worker 呼叫 Chief(「記憶檢查完成」),這裡以此為結束訊號,並檢查總管收到的指令:
// 專案知識超過上限的「主控台通知」、總管守則提到 memory_search / memory_write。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, extra = {}) => window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd, permissionMode: 'auto', ...extra });
    const W = await mk('Worker');
    const C = await mk('Chief', { chief: true });
    await wait(2500);
    log('READY', C.id, W.id);
    const t0 = Date.now();
    let done = false;
    while (!done && Date.now() - t0 < 200000) {
      const snap = await window.nexus.getSnapshot();
      for (const a of snap.agents) if (a.pendingApproval) await window.nexus.respondApproval(a.id, a.pendingApproval.requestId, 'allow');
      done = (await window.nexus.getHistory(C.id)).some(e => e.type === 'message' && e.role === 'user' && e.text.includes('記憶檢查完成'));
      await wait(300);
    }
    const echoes = (await window.nexus.getHistory(C.id)).filter(e => e.type === 'note' && e.text.startsWith('[echo] ')).map(e => e.text.slice(7));
    const persona = echoes.find(t => t.startsWith('persona:')) ?? '';
    ok(persona.includes('memory_search') && persona.includes('memory_write'), '總管守則提到 memory_search 與 memory_write', persona.slice(0, 200));
    const sends = echoes.filter(t => t.startsWith('send:'));
    ok(sends.some(t => t.includes('主控台通知:專案') && t.includes('超過上限') && t.includes('重新整理')), '專案知識超過上限時,總管下一則指令前收到整理通知', sends.join('|'));
    const wp = (await window.nexus.getHistory(W.id)).filter(e => e.type === 'note' && e.text.startsWith('[echo] persona:')).map(e => e.text).join('');
    ok(!wp.includes('memory_write'), '一般節點的守則不含總管守則');
    log(done ? '主控台端結束' : '等不到用戶端回報');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
