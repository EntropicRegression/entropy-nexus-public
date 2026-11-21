// 階段 8 驗收(假資料模式,真實的滑鼠鍵盤事件):快捷鍵、回覆排版、對話視窗不擋面板、節點改名。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let n = 0;
  const input = async a => { document.title = `INPUT:${++n}|${JSON.stringify(a)}`; await wait(160); };
  const key = (k, modifiers) => input({ type: 'key', key: k, modifiers });
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); document.title = `SHOT:${name}`.replace(name, `${name}-b`); await wait(900); };
  const center = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const click = async el => { if (!el) throw new Error('找不到要點的元素'); await input({ type: 'click', ...center(el) }); await wait(240); };
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  const $ = s => document.querySelector(s);
  const results = [];
  const check = (name, ok, extra = '') => { results.push([name, ok]); log(ok ? '通過' : '失敗', name, extra); };
  try {
    await window.nexus.setAutopilot(false);
    const list = await until('假資料節點待命', async () => { const s = await snap(); return s.agents.length >= 6 && s.agents.every(a => a.state === 'idle') ? s.agents : null; });

    // 1. 對話視窗開啟時,被選取的節點仍在面板的可見範圍內
    const target = list[0];
    window.__nexusSelect(target.name);
    await wait(1400);
    const board = $('.board').getBoundingClientRect(), dlg = $('.dialog').getBoundingClientRect();
    const pos = window.__nexusBoard.positions().find(p => p.id === target.id);
    const nodeY = board.top + pos.y;
    check('對話視窗開啟時面板縮到上方', board.bottom <= dlg.top + 1, `面板底 ${Math.round(board.bottom)} 對話視窗頂 ${Math.round(dlg.top)}`);
    check('被選取的節點沒有被對話視窗蓋住', nodeY > board.top && nodeY + 20 < dlg.top, `節點 y=${Math.round(nodeY)}`);
    const all = window.__nexusBoard.positions();
    check('所有節點都在面板範圍內', all.every(p => p.y > 0 && p.y < board.height && p.x > 0 && p.x < board.width), `${all.length} 個節點`);
    await shot('1-dialog-with-board');

    // 2. 回覆排版:程式碼區塊、清單、粗體,並可複製
    await click($('.dlg-input textarea'));
    await input({ type: 'text', text: '給我程式碼' });
    await key('Enter');
    await until('回覆完成', async () => (await snap()).agents.find(a => a.id === target.id).state === 'idle' && $('.md-code'), 20000);
    await wait(400);
    check('程式碼區塊以等寬區塊顯示', $('.md-code pre')?.textContent.includes('function hello'), $('.md-code-head span')?.textContent);
    check('清單、粗體、行內程式碼、標題', Boolean($('.md ul li') && $('.md ol li') && $('.md b') && $('.md code') && $('.md-h')));
    await click($('.md-code-head button'));
    await wait(300);
    check('點「複製」', $('.md-code-head button')?.textContent === '已複製');
    await shot('2-markdown');

    // 3. 節點改名:清單、任務面板、對話視窗都更新
    await click([...document.querySelectorAll('.dlg-id button')].find(b => b.textContent === '設定'));
    const nameInput = $('.dlg-settings input');
    await click(nameInput);
    await key('A', ['control']);
    await input({ type: 'text', text: '改名後' });
    await click([...document.querySelectorAll('.dlg-settings button')].find(b => b.textContent === '儲存'));
    await wait(500);
    const s3 = await snap();
    check('改名後對話視窗、節點清單、任務面板都更新', $('.dlg-id b')?.textContent === '改名後' && [...document.querySelectorAll('.row-name')].some(e => e.textContent === '改名後') && s3.tasks.filter(t => t.agentId === target.id).every(t => t.agentName === '改名後'), `任務 ${s3.tasks.filter(t => t.agentId === target.id).length} 筆`);

    // 4. 快捷鍵:Esc 關閉、Alt+N 跳到需要你的節點、Alt+A 允許、Alt+I 中斷、F1、Ctrl+N
    await click($('.topbar .brand'));
    await key('Escape');
    await wait(300);
    check('Esc 關閉對話視窗', !$('.dialog'));
    // 讓另一個節點進入待授權
    const other = list[1];
    for (let i = 0; i < 14 && !(await snap()).agents.find(a => a.id === other.id).pendingApproval; i++) {
      await window.nexus.send(other.id, '測試');
      await until('回合有結果', async () => { const a = (await snap()).agents.find(x => x.id === other.id); return a.pendingApproval || a.state === 'idle' || a.state === 'error'; }, 30000);
    }
    await key('N', ['alt']);
    await wait(500);
    check('Alt+N 跳到需要你的節點', $('.dlg-id b')?.textContent === other.name, $('.dlg-id b')?.textContent);
    if ((await snap()).agents.find(a => a.id === other.id).pendingApproval) {
      await key('A', ['alt']);
      await until('授權被核准', async () => !(await snap()).agents.find(a => a.id === other.id).pendingApproval, 8000);
      check('Alt+A 允許', true);
    } else check('Alt+A 允許', false, '節點沒有進入待授權');
    if (['planning', 'working', 'awaiting'].includes((await snap()).agents.find(a => a.id === other.id).state)) {
      await key('I', ['alt']);
      await until('中斷', async () => ['idle', 'error'].includes((await snap()).agents.find(a => a.id === other.id).state), 8000);
      check('Alt+I 中斷', (await window.nexus.getHistory(other.id)).some(e => e.type === 'message' && /中斷/.test(e.text)));
    } else log('略過 Alt+I:回合已經結束');
    await key('F1');
    await wait(300);
    check('F1 顯示快捷鍵表', Boolean($('.keys')), `${document.querySelectorAll('.keys div').length} 項`);
    await shot('3-shortcuts');
    await key('F1');
    await key('W', ['alt']);
    await wait(300);
    check('Alt+W 關閉對話視窗', !$('.dialog'));
    await key('N', ['control']);
    await wait(300);
    check('Ctrl+N 開啟新增節點', Boolean($('.addform')));

    log('結果', `${results.filter(r => r[1]).length}/${results.length} 通過`, results.filter(r => !r[1]).map(r => r[0]).join(';'));
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
