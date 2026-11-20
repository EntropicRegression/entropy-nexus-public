// 節點六角形裡的 Q 版頭像。假資料模式,由 tests/avatar.sh 啟動:測試用的立繪資料夾裡有三個角色,
// 其中兩個有頭像(avatar.png、chibi_avatar.png 各一),一個沒有。檢查有頭像的畫出來、沒有的維持六角形,以及頂部開關。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); document.title = `SHOT:${name}-b`; await wait(900); };
  const until = async (what, fn, timeout = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${detail}` : ''}`); };
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    expect('有頭像的角色回傳圖片', String(await window.nexus.getAvatar('alpha')).startsWith('data:image/') && String(await window.nexus.getAvatar('beta')).startsWith('data:image/'));
    expect('沒有頭像的角色回傳 null', (await window.nexus.getAvatar('gamma')) === null);
    expect('不存在的角色與路徑回傳 null', (await window.nexus.getAvatar('nobody')) === null && (await window.nexus.getAvatar('..\alpha')) === null && (await window.nexus.getAvatar('')) === null);
    for (const [name, character, backend] of [['Alpha', 'alpha', 'claude'], ['Beta', 'beta', 'codex'], ['Gamma', 'gamma', 'antigravity'], ['Plain', '', 'claude']]) {
      await window.nexus.createAgent({ name, character, model: '', backend, cwd, permissionMode: name === 'Beta' ? 'auto' : 'ask' });
    }
    const loaded = await until('頭像載入', () => { const a = Object.fromEntries(window.__nexusBoard.avatars()); return a.alpha && a.beta && a.gamma === false ? a : null; });
    expect('面板讀到兩個頭像', loaded.alpha === true && loaded.beta === true && loaded.gamma === false, JSON.stringify(loaded));
    await wait(1200);
    await shot('avatar-1-on');
    // 讓一個節點開始執行,看執行中的光環與狀態點
    const a = (await window.nexus.getSnapshot()).agents.find(x => x.name === 'Alpha');
    await window.nexus.send(a.id, '開始');
    await wait(3500);
    await shot('avatar-2-working');
    // 關掉開關:回到原本的六角形,設定會記住
    // 頭像開關在頂部「顯示」的小面板裡
    [...document.querySelectorAll('.topbar button')].find(b => b.textContent === '顯示').click(); await wait(300);
    const btn = () => [...document.querySelectorAll('.view-pop button')].find(b => b.textContent.startsWith('頭像'));
    expect('開關預設開啟', btn().textContent === '頭像 開');
    btn().click(); await wait(1200);
    expect('關閉後記住設定', btn().textContent === '頭像 關' && localStorage.getItem('nexus.avatars') === '0');
    await shot('avatar-3-off');
    btn().click(); await wait(800);
    expect('再打開', btn().textContent === '頭像 開' && localStorage.getItem('nexus.avatars') === '1');
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
