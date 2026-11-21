// README 截圖(假資料模式,由 tests/readme-shots.sh 啟動):排出一個有代表性的畫面再截圖。
//   board:兩個節點執行中、一個等你回答、一則排隊中的指令、幾個完成的任務;儀表有額度與花費
//   dialog:打開一個節點的對話視窗,顯示有排版的回覆與程式碼區塊
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(1200); };
  const snap = () => window.nexus.getSnapshot();
  const agent = async id => (await snap()).agents.find(a => a.id === id);
  const until = async (fn, ms = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(150); } return null; };
  const idle = id => until(async () => (await agent(id))?.state === 'idle');
  // 主面板的節點都移到定位(動畫停下)
  const settled = () => until(() => window.__nexusBoard?.settled?.(), 8000);
  const now = Math.round(Date.now() / 1000);
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const mk = (name, backend, permissionMode = 'auto') => window.nexus.createAgent({ name, character: '', model: '', backend, cwd, permissionMode });
    const nova = await mk('Nova', 'antigravity', 'ask');
    const vega = await mk('Vega', 'claude');
    const orion = await mk('Orion', 'codex');
    const atlas = await mk('Atlas', 'claude');
    const lyra = await mk('Lyra', 'codex');
    const echo = await mk('Echo', 'antigravity');
    await wait(2500);

    // 各後台的額度:每家讀兩次,第二次比較高,儀表就會顯示今天用了多少
    const usage = async (id, five, week, tokens, usd) => {
      await window.nexus.send(id, `〔測試用量:${JSON.stringify({ windows: [{ label: '5 小時', used: five, resetsAt: now + 3 * 3600 }, { label: '每週', used: week, resetsAt: now + 4 * 86400 }], spent: { tokens, usd } })}〕`);
      await idle(id);
    };
    await usage(vega.id, 0.30, 0.22, 0, 0); await usage(vega.id, 0.46, 0.31, 18000, 0.09);
    await usage(orion.id, 0.15, 0.10, 0, 0); await usage(orion.id, 0.28, 0.16, 12000, 0.04);
    await usage(nova.id, 0.20, 0.12, 0, 0); await usage(nova.id, 0.35, 0.19, 9000, 0.02);
    await window.nexus.clearFinishedTasks();

    // 已完成的任務(有花費)
    await window.nexus.send(lyra.id, '替登入頁補上單元測試');
    await window.nexus.send(echo.id, '整理 API 文件裡的範例');
    await window.nexus.send(atlas.id, '請示範一段程式碼,說明怎麼把清單依日期排序');
    await Promise.all([idle(lyra.id), idle(echo.id), idle(atlas.id)]);
    await wait(800);

    // 進行中:兩個執行、一個提問、一則排隊
    await window.nexus.send(vega.id, '重構設定檔的讀取流程');
    await window.nexus.send(orion.id, '找出所有 TODO 並分類');
    await window.nexus.send(nova.id, '提問:結帳頁要用哪種主題色?');
    await wait(300);
    await window.nexus.enqueue(vega.id, '完成後更新變更紀錄');
    // 狀態要穩定:截圖前後都確認,而且等主面板的移動動畫跑完;不符合就再等下一個時機
    const wanted = async () => {
      const s = await snap();
      const st = id => s.agents.find(a => a.id === id)?.state;
      return st(vega.id) === 'working' && st(orion.id) === 'working' && st(nova.id) === 'awaiting';
    };
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      if (!(await wanted())) { await wait(250); continue; }
      await wait(600);
      await settled();
      if (!(await wanted()) || !window.__nexusBoard.settled()) continue;
      document.title = 'SHOT:board';
      await wait(500);
      ok = await wanted();
      if (!ok) { // 拍到一半狀態變了:讓已經停下的節點再跑一輪
        for (const [a, t] of [[vega, '重構設定檔的讀取流程'], [orion, '找出所有 TODO 並分類']]) if ((await agent(a.id)).state === 'idle') await window.nexus.send(a.id, t);
      }
    }
    log(ok ? '通過 主畫面截圖時狀態穩定' : '不符 拍不到穩定的主畫面');
    await wait(800);

    // 對話視窗:Atlas 的回覆有排版與程式碼區塊
    await Promise.all([idle(vega.id), idle(orion.id)]);
    await wait(1500);
    window.__nexusSelect('Atlas');
    await wait(1500);
    log(await settled() ? '通過 對話視窗打開後節點已就定位' : '不符 節點一直沒有就定位');
    const d = document.querySelector('.dialog');
    const r = d?.getBoundingClientRect();
    log(d && r.height > 200 && d.textContent.includes('function') ? '通過 對話視窗顯示程式碼區塊' : `不符 對話視窗 ${d ? `${Math.round(r.width)}x${Math.round(r.height)} ${d.textContent.slice(0, 60)}` : '不存在'}`);
    await shot('dialog');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
