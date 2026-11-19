// 瀏覽器版完整介面的驗收(假資料模式,主控台這一側):開啟遠端、印出配對碼與一個節點,桌面畫面截圖當對照,
// 之後由 tests/web-full-browser.cjs 當成另一台電腦的瀏覽器連進來檢查。瀏覽器那邊送出「瀏覽器檢查完成」後結束。見 tests/web-full.sh。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    await window.nexus.setAutopilot(false);
    await wait(2500);
    await window.nexus.remoteSet({ enabled: true });
    await wait(1200);
    const st = await window.nexus.remoteStatus();
    const snap = await window.nexus.getSnapshot();
    const a = snap.agents.find(x => !x.parentId);
    document.title = 'SHOT:desktop'; await wait(900); document.title = 'SHOT:desktop-b'; await wait(900);
    log('PAIR', st.pairCode, a.id, st.port, snap.agents.length);
    const t0 = Date.now();
    let done = false;
    while (!done && Date.now() - t0 < 150000) {
      const h = await window.nexus.getHistory(a.id);
      done = h.some(e => e.type === 'message' && e.role === 'user' && e.text.startsWith('瀏覽器檢查完成'));
      await wait(700);
    }
    log(done ? '瀏覽器已回報' : '等不到瀏覽器回報');
    log('已配對的裝置', JSON.stringify((await window.nexus.remoteStatus()).devices.map(d => d.name)));
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
