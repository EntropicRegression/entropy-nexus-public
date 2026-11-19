// 手機遠端的驗收(假資料模式):在主控台內開啟遠端、回報配對碼,之後由外部用 HTTP 測試(見 tests/remote.sh)。
// 外部對任一節點送出「撤銷測試」這句指令時,這裡會撤銷所有裝置,用來驗證撤銷後立刻失效。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    await window.nexus.setAutopilot(false);
    await wait(2500);
    await window.nexus.remoteSet({ enabled: true });
    await wait(1200);
    let st = await window.nexus.remoteStatus();
    log('REMOTE', JSON.stringify({ enabled: st.enabled, lan: st.lan, port: st.port, tailscaleIp: st.tailscaleIp, listening: st.listening, hasQr: Boolean(st.qr), url: st.url }));
    // 桌面面板的畫面
    [...document.querySelectorAll('.topbar button')].find(b => b.textContent === '手機').click();
    await wait(1200);
    log('面板內容', document.querySelector('.remote')?.textContent.replace(/\s+/g, ' ').slice(0, 150));
    document.title = 'SHOT:1-panel'; await wait(900); document.title = 'SHOT:1-panel-b'; await wait(900);
    let code = '', revoked = false;
    const t0 = Date.now();
    while (Date.now() - t0 < Number(window.__TEST_CWD__ ? 560000 : 170000)) {
      st = await window.nexus.remoteStatus();
      if (st.pairCode !== code) { code = st.pairCode; log('CODE', code); }
      const snap = await window.nexus.getSnapshot();
      if (!revoked) {
        for (const a of snap.agents) {
          const h = await window.nexus.getHistory(a.id);
          if (h.some(e => e.type === 'message' && e.role === 'user' && e.text === '撤銷測試')) {
            log('撤銷前的裝置', JSON.stringify(st.devices.map(d => d.name)));
            for (const d of st.devices) await window.nexus.remoteRevoke(d.id);
            revoked = true;
            log('REVOKED', (await window.nexus.remoteStatus()).devices.length);
          }
        }
      }
      if (snap.agents.some(a => a.name === 'QUIT-NOW')) break;
      await wait(700);
    }
    await window.nexus.remoteSet({ enabled: false });
    await wait(800);
    log('關閉後聆聽的位址', JSON.stringify((await window.nexus.remoteStatus()).listening));
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
