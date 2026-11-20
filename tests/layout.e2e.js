// 桌面版的版面檢查(假資料模式,由 tests/layout.sh 啟動;前面會接上 tests/layout-audit-lib.js)。
// 在幾種視窗大小下逐一打開主要的畫面(情境見 layout-audit-lib.js 的 __LAYOUT_SCENES),
// 檢查點不到的按鈕與超出區塊的節點,並截圖。
// LAYOUT_WEB=1 時改成:開啟遠端、印出配對碼,讓 tests/layout-browser.cjs 用瀏覽器檢查瀏覽器版,桌面這邊只等它回報。
// 視窗大小是畫面內容區的 CSS 像素;Windows 開了顯示縮放時,可用的 CSS 像素會變小:
//   1366×768 螢幕 125% → 約 1090×540;1920×1080 螢幕 150% → 約 1280×650。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(700); };
  const SIZES = [[1440, 900, '大螢幕'], [1100, 700, '最小視窗'], [1280, 650, '1080p-150%'], [1090, 540, '768p-125%'], [960, 540, '最小視窗-小螢幕']];
  let total = 0;
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const backends = ['claude', 'codex', 'antigravity'];
    const ids = [];
    for (let i = 0; i < 14; i++) ids.push((await window.nexus.createAgent({ name: `節點${String(i + 1).padStart(2, '0')}`, character: i === 0 ? 'Layout' : '', model: '', backend: backends[i % 3], cwd, permissionMode: 'ask' })).id);
    await window.nexus.setChief(ids[13]);
    await wait(2500);

    if (window.__LAYOUT_WEB__) {
      await window.nexus.remoteSet({ enabled: true });
      await wait(1200);
      const st = await window.nexus.remoteStatus();
      log('PAIR', st.pairCode, ids[0], st.port);
      const t0 = Date.now();
      let done = false;
      while (!done && Date.now() - t0 < 280000) {
        done = (await window.nexus.getHistory(ids[0])).some(e => e.type === 'message' && e.role === 'user' && e.text.startsWith('瀏覽器檢查完成'));
        await wait(1000);
      }
      log(done ? '瀏覽器已回報' : '等不到瀏覽器回報');
      log('主控台端結束');
      document.title = 'QUIT';
      return;
    }

    for (const [w, h, label] of SIZES) {
      const size = `${label} ${w}×${h}`;
      document.title = `SIZE:${w},${h}`;
      await wait(1800);
      log(`=== ${size}:畫面 ${innerWidth}×${innerHeight}`);
      await window.__layoutClose();
      for (const [key, title] of window.__LAYOUT_SCENES) {
        const issues = await window.__layoutScene(key);
        total += issues.length;
        log(issues.length ? '不符' : '通過', `[${size}] ${title}`, issues.length ? `${issues.length} 項` : '');
        for (const i of issues.slice(0, 12)) log('   -', i);
        if (issues.length > 12) log(`   …另外 ${issues.length - 12} 項`);
        await shot(`${label}-${key}`);
        await window.__layoutClose();
      }
    }
    log(total ? `有 ${total} 項不符` : '全部通過');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
