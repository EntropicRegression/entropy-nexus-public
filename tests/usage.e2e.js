// 驗收:游標停在節點上時以血量條顯示剩餘用量。
// 假資料模式(NEXUS_FAKE=1)直接用現有節點;否則建立 Claude、Codex、Antigravity 各一個節點並各跑一回合。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const snap = () => window.nexus.getSnapshot();
  const DONE = ['idle', 'error', 'lost'];
  const until = async (what, fn, timeout = 120000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(250); }
    throw new Error(`等不到:${what}`);
  };
  const card = () => document.querySelector('.hovercard');
  const readCard = () => card() ? `${card().querySelector('.hc-head b').textContent}:` + ([...card().querySelectorAll('.hp')].map(h => `${h.querySelector('.hp-head span').textContent}=${h.querySelector('.hp-head b').textContent}[${h.className.replace('hp ', '')},亮 ${h.querySelectorAll('.hp-bar i.on').length}/20]${h.querySelector('.hp-note') ? `(${h.querySelector('.hp-note').textContent})` : ''}`).join(' ') || card().querySelector('.hc-none')?.textContent) : '(沒有資訊卡)';
  // 在主面板上移動游標,直到停在名稱相符的節點上
  const hoverNode = async name => {
    const canvas = document.querySelector('.board canvas');
    const r = canvas.getBoundingClientRect();
    const move = (x, y) => canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    for (let y = r.top + 70; y < r.bottom - 20; y += 22) {
      for (let x = r.left + 40; x < r.right - 20; x += 22) {
        move(x, y);
        await wait(12);
        if (card()?.querySelector('.hc-head b')?.textContent === name) return true;
      }
    }
    return false;
  };
  const hoverRow = name => { const row = [...document.querySelectorAll('.row')].find(x => x.textContent.includes(name)); row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); return Boolean(row); };
  const leaveRow = name => [...document.querySelectorAll('.row')].find(x => x.textContent.includes(name))?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));

  try {
    let s = await snap();
    const fake = s.capabilities.every(c => c.simulated);
    if (!fake) {
      const cwd = window.__TEST_CWD__;
      const cl = await window.nexus.createAgent({ name: 'Claude-U', character: '', model: 'haiku', backend: 'claude', cwd, permissionMode: 'ask' });
      const cx = await window.nexus.createAgent({ name: 'Codex-U', character: '', model: '', backend: 'codex', cwd, permissionMode: 'ask' });
      const ag = await window.nexus.createAgent({ name: 'Agy-U', character: '', model: 'gemini-3.8-flash-low', backend: 'antigravity', cwd, permissionMode: 'ask' });
      await until('三個節點待命', async () => (await snap()).agents.every(a => a.state === 'idle'), 60000);
      log('回合前的額度資料', JSON.stringify((await snap()).usage.map(u => [u.backend, u.windows.length, u.unsupported])));
      for (const a of [cl, cx, ag]) await window.nexus.send(a.id, '只回覆兩個字:OK');
      await wait(1500);
      await until('三個節點完成', async () => (await snap()).agents.every(a => DONE.includes(a.state)), 120000);
      await wait(1500);
    } else {
      await window.nexus.setAutopilot(true);
      await until('假資料有用量', async () => (await snap()).usage.some(u => u.windows.length) && (await snap()).agents.some(a => a.context), 60000);
      await window.nexus.setAutopilot(false);
      await wait(600);
    }
    s = await snap();
    for (const u of s.usage) log('額度', u.backend, u.unsupported ? '不提供' : JSON.stringify(u.windows.map(w => `${w.label} 已用 ${Math.round(w.used * 100)}%`)));
    for (const a of s.agents) log('記憶空間', a.name, a.context ? `${a.context.used}/${a.context.max}` : '無資料');

    // 游標停在主面板的節點上
    const names = s.agents.filter(a => !a.parentId).map(a => a.name);
    let i = 0;
    for (const name of names.slice(0, 3)) {
      const ok = await hoverNode(name);
      await wait(300);
      log('懸浮在面板節點', name, ok ? readCard() : '找不到節點');
      if (ok) await shot(`hover-${++i}`);
    }
    // 游標離開後資訊卡消失
    document.querySelector('.board canvas').dispatchEvent(new PointerEvent('pointermove', { clientX: 4, clientY: 60, bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true }));
    await wait(300);
    log('游標離開後', card() ? '資訊卡還在' : '資訊卡消失');
    // 節點清單也有同樣的資訊卡
    hoverRow(names[0]);
    await wait(300);
    log('懸浮在節點清單', readCard());
    await shot('hover-roster');
    leaveRow(names[0]);
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(400);
  document.title = 'QUIT';
})();
