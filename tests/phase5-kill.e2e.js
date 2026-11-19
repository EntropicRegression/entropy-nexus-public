// 階段 5:強制關閉測試的前半段。啟動三家各一個節點並讓它們都在執行中,印出 READY 後就停在那裡,
// 由外部強制結束主控台,再檢查有沒有殘留的 CLI 子行程。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const agents = async () => (await window.nexus.getSnapshot()).agents;
  const until = async (what, fn, timeout = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await fn()) return; await wait(300); }
    throw new Error(`等不到:${what}`);
  };
  try {
    const cwd = window.__TEST_CWD__;
    for (const [name, backend] of [['K-Claude', 'claude'], ['K-Codex', 'codex'], ['K-Agy', 'antigravity']]) {
      await window.nexus.createAgent({ name, backend, cwd, permissionMode: 'ask' });
    }
    await until('三個節點待命', async () => (await agents()).every(a => a.state === 'idle'));
    for (const a of await agents()) await window.nexus.send(a.id, '請寫一篇至少五千字的文章介紹世界各大洋,要非常詳細。');
    await until('三個節點都在執行', async () => (await agents()).every(a => a.state === 'planning' || a.state === 'working'));
    await wait(2500);
    log('READY', (await agents()).map(a => `${a.name}=${a.state}`).join(' '));
  } catch (err) {
    log('失敗', err.message);
    document.title = 'QUIT';
  }
})();
