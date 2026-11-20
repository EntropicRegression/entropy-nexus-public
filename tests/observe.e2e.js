// 缺口 7 外部觀察:畫面這一側的腳本。由 tests/observe.run.js 啟動(假資料模式),模擬的 hook 請求由 run.js 從外部送進接收端。
// 這支腳本負責:安裝/移除 hooks、記錄外部觀察節點的變化、按「接手」、截圖。和 run.js 之間用特殊的 session id(sig-*)當訊號。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const until = async (what, fn, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(150); }
    throw new Error(`等不到:${what}`);
  };
  const clean = e => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const seen = new Map();
  const signals = new Set();
  window.nexus.onUpdate(u => {
    if (u.observed) {
      const o = u.observed;
      if (o.sessionId.startsWith('sig-')) { signals.add(o.sessionId); return; }
      const prev = seen.get(o.sessionId);
      seen.set(o.sessionId, o);
      if (!prev || prev.state !== o.state || prev.detail !== o.detail) log('obs', o.sessionId, o.state, JSON.stringify(o.detail), 'tool=' + o.tool, 'cwd=' + o.cwd, 'recent=' + JSON.stringify(o.recent.slice(-1)[0]?.text ?? ''));
    }
    if (u.observedRemovedId && !u.observedRemovedId.startsWith('sig-')) { seen.delete(u.observedRemovedId); log('obs-removed', u.observedRemovedId); }
  });
  const signal = name => until(`訊號 ${name}`, () => signals.has(name), 90000);
  // 假資料節點關掉自動運作後不會再響,提示音次數從這裡起算
  const chimesBefore = window.__nexusChimes?.count ?? 0;
  try {
    await window.nexus.setAutopilot(false);
    const own = await until('假資料節點待命', async () => { const a = (await window.nexus.getSnapshot()).agents; return a.length >= 3 && a.every(x => x.state === 'idle' && x.sessionId) ? a : null; });
    log('own', own.find(a => a.backend === 'claude').sessionId);

    let st = await window.nexus.observeStatus();
    log('status-initial', st.listening, st.port, st.installed, JSON.stringify(st.error), st.settingsPath);
    // 頂部「遠端」的面板有兩個分頁,外部觀察在第二個
    [...document.querySelectorAll('.topbar button')].find(b => b.textContent === '遠端').click();
    await wait(300);
    [...document.querySelectorAll('.hub-tabs button')].find(b => b.textContent === '外部觀察').click();
    await wait(600);
    log('panel', !!document.querySelector('.remote.hub .observe'), document.querySelector('.remote.hub .observe .primary')?.textContent);
    await shot('1-panel-before');

    // 安裝兩次:第二次不應該重複新增(由 run.js 檢查檔案內容)
    [...document.querySelectorAll('.remote.hub .observe button')].find(b => b.textContent === '安裝 hooks').click();
    st = await until('安裝完成', async () => { const s = await window.nexus.observeStatus(); return s.installed === 'current' ? s : null; }, 10000);
    log('installed', st.installed);
    await wait(1500);
    st = await window.nexus.observeInstall();
    log('installed2', st.installed);
    await wait(1500);
    await shot('2-panel-installed');
    document.querySelector('.remote.hub .remote-head button').click();

    // 模擬的 hook 事件由 run.js 送進來;等外部節點進入待授權時截圖並確認提示音有響
    await until('ext-1 待授權', () => seen.get('ext-1')?.state === 'awaiting', 60000);
    await wait(500);
    log('chime', (window.__nexusChimes?.count ?? 0) - chimesBefore, '| 外部列', document.querySelectorAll('.observed-row').length, '| 外部列有授權按鈕', !!document.querySelector('.observed-row .approve, .observed-row [data-approve]'));
    document.querySelector('.observed')?.scrollIntoView();
    await shot('3-awaiting');

    // 接手:第一次按只顯示警告,第二次才建立正式節點
    await until('ext-2 出現', () => seen.get('ext-2')?.tool === 'TakeoverMe', 60000);
    await wait(400);
    const row = () => [...document.querySelectorAll('.observed-row')].find(r => r.title.includes('ext-2'));
    row().querySelector('.observed-take').click();
    await wait(500);
    row()?.scrollIntoView();
    log('takeover-warn', JSON.stringify(row()?.querySelector('.observed-warn')?.textContent ?? ''));
    await shot('4-takeover-warn');
    row().querySelector('.observed-take').click();
    const taken = await until('接手成正式節點', async () => (await window.nexus.getSnapshot()).agents.find(a => a.sessionId === 'ext-2'), 10000);
    await wait(500);
    log('takeover', taken.name, taken.backend, taken.cwd, '| 仍在外部清單', seen.has('ext-2'), '| 快照的外部清單', JSON.stringify((await window.nexus.getSnapshot()).observed.map(o => o.sessionId)));
    await shot('5-taken');
    // 關掉對話視窗,回到面板
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    await signal('sig-uninstall');
    st = await window.nexus.observeUninstall();
    log('uninstalled', st.installed);
    await wait(1500);

    await signal('sig-broken');
    try { await window.nexus.observeInstall(); log('broken-install', '居然成功'); } catch (e) { log('broken-install', 'rejected', JSON.stringify(clean(e).slice(0, 120))); }
    st = await window.nexus.observeStatus();
    log('broken-status', st.installed, JSON.stringify(st.settingsError.slice(0, 80)));
    log('broken-done');

    await signal('sig-quit');
    await shot('6-final');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(400);
  document.title = 'QUIT';
})();
