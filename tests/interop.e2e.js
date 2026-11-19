// 節點互相呼叫的驗收(假資料模式,主控台這一側):建立三個節點 Alpha(自動)、Beta、Gamma(每次詢問),
// 印出它們的 id,之後由 tests/interop-client.mjs 當成各節點的 CLI 連到主控台的工具服務。
// 這裡負責回應授權:節點互相呼叫的授權依摘要決定(含「請拒絕」的拒絕,其餘允許);假資料節點自己的授權一律允許,讓回合跑得完。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, permissionMode) => window.nexus.createAgent({ name, character: '', model: '', backend, cwd, permissionMode });
    const A = await mk('Alpha', 'claude', 'auto'), B = await mk('Beta', 'codex', 'ask'), C = await mk('Gamma', 'antigravity', 'ask');
    await wait(2500);
    log('READY', A.id, B.id, C.id);
    const seen = [];
    const t0 = Date.now();
    let done = false;
    while (!done && Date.now() - t0 < 200000) {
      const snap = await window.nexus.getSnapshot();
      for (const a of snap.agents) {
        const p = a.pendingApproval;
        if (!p) continue;
        if (p.tool === '呼叫節點') {
          const deny = p.summary.includes('請拒絕');
          seen.push(`${a.name}:${deny ? '拒絕' : '允許'}:${a.state}`);
          await window.nexus.respondApproval(a.id, p.requestId, deny ? 'deny' : 'allow');
        } else await window.nexus.respondApproval(a.id, p.requestId, 'allow');
      }
      done = (await window.nexus.getHistory(A.id)).some(e => e.type === 'message' && e.role === 'user' && e.text.includes('互叫檢查完成'));
      await wait(300);
    }
    log('主控台回應的互叫授權', JSON.stringify(seen));
    const hb = await window.nexus.getHistory(B.id);
    log(hb.some(e => e.type === 'message' && e.role === 'user' && e.text.startsWith('(主控台:這則指令來自節點「Alpha」(Claude Code)') && e.text.includes('請幫我看一下這段設計。')) ? '通過' : '不符', '被呼叫的節點註明是誰呼叫的');
    log(seen.some(s => s.startsWith('Beta:允許:awaiting')) && seen.some(s => s.startsWith('Beta:拒絕')) ? '通過' : '不符', '每次詢問的節點要經過授權,且顯示在待授權');
    log(!seen.some(s => s.startsWith('Alpha:')) ? '通過' : '不符', '自動模式的節點不問');
    log(done ? '主控台端結束' : '等不到用戶端回報');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
