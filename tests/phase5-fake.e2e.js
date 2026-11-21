// 階段 5:同時執行上限與失聯偵測。用假資料轉接器執行(NEXUS_FAKE=1、NEXUS_STALL_MS=900),不消耗訂閱額度。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const agents = async () => (await window.nexus.getSnapshot()).agents;
  const until = async (what, fn, timeout = 60000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  try {
    await window.nexus.setAutopilot(false);
    const list = await until('假資料節點待命', async () => { const a = await agents(); return a.length >= 3 && a.every(x => x.state === 'idle') ? a : null; });
    log('節點', list.map(a => a.name).join(' '));

    // 同時執行上限
    await window.nexus.setMaxActive(1);
    await window.nexus.send(list[0].id, '第一句');
    await wait(300);
    await window.nexus.send(list[1].id, '第二句,應該排隊');
    await wait(500);
    // 達上限的指令不再報錯,改成排進佇列並以說明告知
    const h1 = await window.nexus.getHistory(list[1].id);
    const queuedNote = h1.filter(e => e.type === 'note').slice(-1)[0];
    const second = (await agents()).find(a => a.id === list[1].id);
    log('上限 1:第二個節點狀態', second.state, '| 排隊中', JSON.stringify(second.queued.map(q => q.text)), '| 說明', JSON.stringify(queuedNote?.text), '| 錯誤數', h1.filter(e => e.type === 'error').length, '| 指令是否已送出', h1.some(e => e.type === 'message' && e.role === 'user'));
    window.__nexusSelect(list[1].name);
    await wait(600);
    await shot('1-limit-queued');
    // 調高上限後有名額,排隊的指令自動送出
    await window.nexus.setMaxActive(4);
    await wait(500);
    const after = (await agents()).find(a => a.id === list[1].id);
    log('上限 4:第二個節點狀態', after.state, '| 排隊中', after.queued.length, '| 畫面上的上限欄位', document.querySelector('.limit input').value);

    // 失聯偵測:NEXUS_STALL_MS 設得很短,執行中只要一段時間沒有事件就會被標成失聯
    const lost = await until('出現失聯狀態', async () => {
      for (const a of await agents()) {
        const h = await window.nexus.getHistory(a.id);
        const e = h.find(x => x.type === 'state' && x.state === 'lost');
        if (e) return { name: a.name, detail: e.detail, msg: h.filter(x => x.type === 'error').slice(-1)[0]?.message };
      }
      return null;
    }, 40000);
    log('失聯偵測', lost.name, lost.detail, '|', JSON.stringify(lost.msg));
    await shot('2-watchdog');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(400);
  document.title = 'QUIT';
})();
