// 實機走查:用真正的滑鼠與鍵盤輸入事件(經瀏覽器的輸入管線)把主要操作走一遍。
// 以假資料模式執行(NEXUS_FAKE=1、NEXUS_TEST_NOTIFY=1),不消耗訂閱額度。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let n = 0;
  const input = async a => { document.title = `INPUT:${++n}|${JSON.stringify(a)}`; await wait(140); };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const center = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const click = async el => { if (!el) throw new Error('找不到要點的元素'); el.scrollIntoView?.({ block: 'nearest' }); await wait(60); await input({ type: 'click', ...center(el) }); await wait(220); };
  const typeText = async text => { await input({ type: 'text', text }); await wait(200); };
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 40000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  const $ = s => document.querySelector(s);
  const btn = (scope, label) => [...document.querySelectorAll(`${scope} button`)].find(b => b.textContent.trim() === label);
  const results = [];
  const check = (name, ok, extra = '') => { results.push([name, ok]); log(ok ? '通過' : '失敗', name, extra); };

  try {
    await window.nexus.setAutopilot(false);
    await until('假資料節點待命', async () => { const s = await snap(); return s.agents.length >= 6 && s.agents.every(a => a.state === 'idle'); });
    const home = (await snap()).agents[0].cwd;

    // 1. 新增節點:點按鈕、鍵盤輸入名稱與資料夾,出現同資料夾警告
    await click($('.add:not(.old)'));
    check('點「新增節點」開啟表單', Boolean($('.addform')));
    await click($('.addform input'));
    await typeText('走查一號');
    const cwdInput = $('.addform .pick input');
    await click(cwdInput);
    await typeText(home);
    await wait(300);
    check('鍵盤輸入名稱與資料夾', $('.addform input').value === '走查一號' && cwdInput.value === home, `名稱=${$('.addform input').value}`);
    check('同資料夾警告出現', Boolean($('.form-warn')), $('.form-warn')?.textContent?.slice(0, 30));
    await shot('1-add-warning');
    await click(btn('.addform', '新增'));
    const mine = await until('新節點出現', async () => (await snap()).agents.find(a => a.name === '走查一號'));
    await until('新節點待命', async () => (await snap()).agents.find(a => a.id === mine.id).state === 'idle');
    check('新增節點成功', true);

    // 2. 在主面板上直接點節點,開啟對話視窗
    const canvas = $('.board canvas').getBoundingClientRect();
    await wait(900);
    const pos = window.__nexusBoard.positions().find(p => p.id === mine.id);
    await input({ type: 'click', x: Math.round(canvas.left + pos.x), y: Math.round(canvas.top + pos.y) });
    await wait(500);
    check('點主面板上的節點開啟對話視窗', $('.dlg-id b')?.textContent === '走查一號', $('.dlg-id b')?.textContent);

    // 3. 鍵盤輸入指令、Enter 送出;節點提問,點選項作答;回覆即時串流
    await click($('.dlg-input textarea'));
    await typeText('請提問');
    await input({ type: 'key', key: 'Enter' });
    await until('提問出現', () => $('.dlg-question'), 15000);
    check('Enter 送出指令且出現提問作答區', true, $('.q-text')?.textContent);
    await shot('2-question');
    await click([...document.querySelectorAll('.q-options button')].find(b => b.textContent === '藍色'));
    check('點選項後被選取', Boolean($('.q-options button.on')));
    let sawLive = false;
    const watcher = setInterval(() => { if ($('.msg.live')) sawLive = true; }, 30);
    await click(btn('.dlg-question', '送出回答'));
    await until('回答後完成', async () => (await snap()).agents.find(a => a.id === mine.id).state === 'idle', 20000);
    clearInterval(watcher);
    await wait(400);
    const lastMsg = [...document.querySelectorAll('.dlg-stream .msg.agent p')].pop()?.textContent;
    check('回答送達', /藍色/.test(lastMsg ?? ''), lastMsg);
    check('回覆以串流方式逐步出現', sawLive);

    // 4. 授權:一直送指令直到出現授權請求,點「允許」
    let approved = false;
    for (let i = 0; i < 12 && !approved; i++) {
      await click($('.dlg-input textarea'));
      await typeText('測試指令');
      await click(btn('.dlg-input', '送出'));
      await until('回合有結果', async () => { const a = (await snap()).agents.find(x => x.id === mine.id); return a.pendingApproval || a.state === 'idle' || a.state === 'error'; }, 30000);
      if ($('.dlg-approval')) { await shot('3-approval'); await click(btn('.dlg-approval', '允許')); approved = true; await until('允許後繼續', async () => !(await snap()).agents.find(x => x.id === mine.id).pendingApproval, 10000); }
    }
    check('點「允許」核准授權請求', approved);
    // 同一回合可能再要求授權;後續的直接允許,讓回合走完
    await until('回到待命或出錯', async () => { const x = (await snap()).agents.find(a => a.id === mine.id); if (x.pendingApproval) await window.nexus.respondApproval(x.id, x.pendingApproval.requestId, 'allow'); return ['idle', 'error'].includes(x.state); }, 60000);

    // 5. 提示音與系統通知
    const chimes = window.__nexusChimes;
    check('提示音有送進音訊裝置', Boolean(chimes && chimes.count > 0 && chimes.state === 'running'), JSON.stringify(chimes));

    // 6. 關閉對話視窗,滑鼠移到節點上出現血量條
    await click($('.dlg-id .ghost[aria-label="關閉"]'));
    await wait(900);
    // 節點可能還在滑移,多試幾次:每次重新取位置再把滑鼠移過去
    for (let i = 0; i < 6 && !$('.hovercard'); i++) {
      const p2 = window.__nexusBoard.positions().find(p => p.id === mine.id);
      await input({ type: 'move', x: Math.round(canvas.left + p2.x + 2 + i), y: Math.round(canvas.top + p2.y + 2) });
      await wait(450);
    }
    check('滑鼠移到節點上出現血量條', Boolean($('.hovercard .hp')), $('.hovercard .hp-head')?.textContent);
    await shot('4-hover');
    await input({ type: 'move', x: Math.round(canvas.left + 4), y: Math.round(canvas.top + 4) });
    await wait(400);
    check('滑鼠移開後資訊卡消失', !$('.hovercard'));

    // 7. 任務面板與變更檢視入口、開啟舊 session 面板
    check('任務面板有這個節點的任務', [...document.querySelectorAll('.task')].some(t => t.textContent.includes('走查一號')));
    await click($('.add.old'));
    check('點「開啟舊 session」開啟清單', Boolean($('.oldsessions')));
    await input({ type: 'key', key: 'Escape' });
    await wait(300);
    check('按 Esc 關閉清單', !$('.oldsessions'));

    // 8. 終止節點
    window.__nexusSelect('走查一號');
    await wait(500);
    await click(btn('.dialog', '終止'));
    await wait(300);
    await click(btn('.dialog', '直接刪除'));
    await until('節點移除', async () => !(await snap()).agents.some(a => a.id === mine.id), 10000);
    check('點「終止」移除節點', true);

    log('走查結果', `${results.filter(r => r[1]).length}/${results.length} 通過`, results.filter(r => !r[1]).map(r => r[0]).join(';'));
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(600);
  document.title = 'QUIT';
})();
