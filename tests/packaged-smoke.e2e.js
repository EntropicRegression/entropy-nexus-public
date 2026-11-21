// 打包後的冒煙測試:確認安裝版找得到三家 CLI,並能讓一個 Claude 節點完成一回合。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(300); }
    throw new Error(`等不到:${what}`);
  };
  try {
    const snap = await window.nexus.getSnapshot();
    for (const c of snap.capabilities) log('capability', c.backend, 'available', c.available, 'simulated', c.simulated, '|', c.note.slice(0, 60));
    log('立繪資料夾', snap.portraitsDir);
    const a = await window.nexus.createAgent({ name: 'Smoke', character: '', model: 'haiku', backend: 'claude', cwd: window.__TEST_CWD__, permissionMode: 'ask' });
    const state = async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id);
    await until('待命', async () => (await state()).state === 'idle');
    window.__nexusSelect('Smoke');
    await wait(500);
    await window.nexus.send(a.id, '只回覆兩個字:OK');
    await wait(800);
    await until('完成', async () => ['idle', 'error', 'lost'].includes((await state()).state));
    await wait(1200);
    const h = await window.nexus.getHistory(a.id);
    log('狀態', (await state()).state, '| 回覆', JSON.stringify(h.filter(e => e.type === 'message' && e.role === 'agent').slice(-1)[0]?.text));
    // 終端機模式用到原生模組,確認打包後載得起來
    await window.nexus.openTerminal(a.id, 100, 28);
    await until('終端機有輸出', async () => (await window.nexus.termAttach(a.id)).length > 40, 30000);
    log('打包後終端機模式可用,輸出長度', (await window.nexus.termAttach(a.id)).length);
    await window.nexus.closeTerminal(a.id);
    await until('回到對話模式', async () => (await state()).state === 'idle', 40000);
    document.title = 'SHOT:packaged';
    await wait(900);
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
