// 頭像在休眠節點上的顯示(重現「頭像偶爾畫壞」的回報)。假資料模式,由 tests/avatar.sh 以第三個參數 sleep 啟動。
// 建立四個節點(三個有頭像),讓其中幾個休眠、喚醒、再休眠,並開關對話視窗(面板會改變大小),每一步截圖。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); document.title = `SHOT:${name}-b`; await wait(900); };
  const until = async (what, fn, timeout = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, character, backend) => window.nexus.createAgent({ name, character, model: '', backend, cwd, permissionMode: 'auto' });
    const a = await mk('olaf', 'alpha', 'claude'), b = await mk('claudia', 'alpha', 'claude'), c = await mk('Hagemi', 'beta', 'antigravity'), d = await mk('mochii', 'beta', 'claude');
    await until('頭像載入', () => { const m = Object.fromEntries(window.__nexusBoard.avatars()); return m.alpha && m.beta; });
    await wait(1500);
    await shot('sleep-0-awake');
    for (const x of [a, c, d]) await window.nexus.sleep(x.id);
    await wait(2500);
    await shot('sleep-1-three-asleep');
    // 打開、關閉對話視窗:面板高度改變,節點重新排位
    [...document.querySelectorAll('.roster-list .row')].find(r => r.textContent.includes('claudia')).click();
    await wait(1500);
    await shot('sleep-2-dialog-open');
    document.querySelector('.dlg-id button[aria-label="關閉"]').click();
    await wait(1500);
    await shot('sleep-3-dialog-closed');
    await window.nexus.wake(a.id); await wait(2500);
    await window.nexus.sleep(b.id); await wait(2500);
    await shot('sleep-4-swapped');
    // 關掉再打開頭像
    const btn = () => [...document.querySelectorAll('.topbar button')].find(x => x.textContent.startsWith('頭像'));
    btn().click(); await wait(1000); btn().click(); await wait(1500);
    await shot('sleep-5-toggled');
    // 節點被移除(子代理結束、終止節點)之後,其他節點的頭像不能壞掉
    const extra = [];
    for (let i = 0; i < 3; i++) extra.push(await mk('temp' + i, i % 2 ? 'beta' : 'alpha', 'claude'));
    await wait(2000);
    await shot('sleep-6-extra-added');
    for (const x of extra) { await window.nexus.removeAgent(x.id); await wait(700); }
    await wait(1500);
    await shot('sleep-7-extra-removed');
    await window.nexus.wake(c.id); await wait(2500);
    await shot('sleep-8-after-wake');
    log('完成');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
