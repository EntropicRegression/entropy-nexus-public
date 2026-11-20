// 權限的畫面驗收(主控台這一側,假資料模式):在「遠端」面板把下一支配對裝置設成唯讀、只看一個節點,截圖面板,
// 印出配對碼;tests/access-ui-browser.cjs 當成唯讀的瀏覽器連進來檢查畫面。裝置配對後再等一段時間就結束。見 tests/access-ui.sh。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); document.title = `SHOT:${name}-b`; await wait(900); };
  try {
    await window.nexus.setAutopilot(false);
    await wait(2500);
    await window.nexus.remoteSet({ enabled: true });
    const snap = await window.nexus.getSnapshot();
    const a = snap.agents.find(x => !x.parentId);
    [...document.querySelectorAll('.topbar button')].find(b => b.textContent === '遠端').click();
    await wait(1500);
    // 經畫面操作:選「唯讀」→「只有指定的節點」→ 勾第一個節點
    const click = async el => { el.click(); await wait(3600); };
    await click([...document.querySelectorAll('.remote-roles button')].find(b => b.textContent === '唯讀'));
    await click(document.querySelectorAll('.remote-access input[type=radio]')[1]);
    await click([...document.querySelectorAll('.remote-agents label')].find(l => l.textContent.includes(a.name)).querySelector('input'));
    const st = await window.nexus.remoteStatus();
    log(JSON.stringify(st.pairAccess) === JSON.stringify({ role: 'viewer', agents: [a.id] }) ? '通過' : '不符', '面板設定的配對權限', JSON.stringify(st.pairAccess));
    await shot('panel-pair');
    log('PAIR', st.pairCode, a.id, st.port, snap.agents.length);
    const t0 = Date.now();
    while (Date.now() - t0 < 60000 && (await window.nexus.remoteStatus()).devices.length === 0) await wait(500);
    await wait(14000);
    // 裝置清單與操作紀錄
    [...document.querySelectorAll('.remote-log-head button')][0].click();
    await wait(1500);
    const dev = document.querySelector('.remote-dev')?.textContent ?? '';
    const rows = [...document.querySelectorAll('.remote-log-row')].map(r => r.textContent);
    log(/唯讀/.test(dev) && dev.includes(a.name) ? '通過' : '不符', '裝置清單顯示角色與節點', dev.slice(0, 80));
    log(rows.some(r => r.includes('配對')) && rows.some(r => r.includes('被拒') && r.includes('送出指令')) ? '通過' : '不符', '操作紀錄顯示配對與被拒的嘗試', JSON.stringify(rows.slice(0, 4)));
    await shot('panel-log');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
