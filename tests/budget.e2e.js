// 階段 7:額度上限與新增面板的獨立工作區選項。假資料模式(NEXUS_FAKE=1),不消耗訂閱額度。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let n = 0;
  const input = async a => { document.title = `INPUT:${++n}|${JSON.stringify(a)}`; await wait(140); };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const center = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const click = async el => { await input({ type: 'click', ...center(el) }); await wait(220); };
  const snap = () => window.nexus.getSnapshot();
  const until = async (what, fn, timeout = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); } throw new Error(`等不到:${what}`); };
  const $ = s => document.querySelector(s);
  try {
    await window.nexus.setAutopilot(false);
    const list = await until('假資料節點待命', async () => { const s = await snap(); return s.agents.length >= 6 && s.agents.every(a => a.state === 'idle') ? s.agents : null; });
    const a = list[0], b = list[1];

    // 先跑一回合,讓這家後台有額度資料與花費
    await window.nexus.send(a.id, '請提問');
    const q = await until('提問', async () => (await snap()).agents.find(x => x.id === a.id).pendingQuestion, 20000);
    await window.nexus.answerQuestion(a.id, q.requestId, { q1: ['紅色'] });
    await until('回合結束', async () => (await snap()).agents.find(x => x.id === a.id).state === 'idle', 20000);
    for (let i = 0; i < 6; i++) {
      await window.nexus.send(a.id, '測試');
      await until('回合結束', async () => { const x = (await snap()).agents.find(y => y.id === a.id); if (x.pendingApproval) await window.nexus.respondApproval(a.id, x.pendingApproval.requestId, 'allow'); return x.state === 'idle' || x.state === 'error'; }, 60000);
      if ((await snap()).usage.find(u => u.backend === a.backend)?.windows.length) break;
    }
    const s1 = await snap();
    const used = Math.round(Math.max(...s1.usage.find(u => u.backend === a.backend).windows.map(w => w.used)) * 100);
    const t = s1.tasks.filter(x => x.agentId === a.id && x.cost).pop();
    log('額度已用', `${used}%`, '| 任務花費', JSON.stringify(t?.cost), '| 節點累計', JSON.stringify(s1.agents.find(x => x.id === a.id).spent));
    log('任務面板的花費文字', [...document.querySelectorAll('.task-cost')].map(e => e.textContent)[0]);

    // 把額度上限設得比已用的低:同一家後台的節點應該被擋下
    const limit = Math.max(1, used - 5);
    const field = [...document.querySelectorAll('.limit')].find(l => l.textContent.includes('額度上限')).querySelector('input');
    await window.nexus.setQuotaStop(limit);
    await wait(400);
    log('頂部額度上限欄位', field.value);
    await window.nexus.send(b.id, '這句應該被額度上限擋下');
    await wait(700);
    const hb = await window.nexus.getHistory(b.id);
    log('被擋下的節點狀態', (await snap()).agents.find(x => x.id === b.id).state, '| 訊息', JSON.stringify(hb.filter(e => e.type === 'error').pop()?.message), '| 指令是否被記錄', hb.some(e => e.type === 'message' && e.role === 'user'), '| 是否排隊(額度上限不排隊)', (await snap()).agents.find(x => x.id === b.id).queued.length);
    [...document.querySelectorAll('.row')].find(r => r.textContent.includes(b.name)).click();
    await wait(600);
    await shot('1-quota-blocked');
    await shot('1-quota-blocked-b');
    await window.nexus.setQuotaStop(0);
    await window.nexus.send(b.id, '解除上限後再送');
    await wait(700);
    log('解除上限後', (await snap()).agents.find(x => x.id === b.id).state);
    document.querySelector('.dlg-id .ghost[aria-label="關閉"]').click();
    await wait(300);

    // 新增面板:輸入版本庫資料夾後可勾選獨立工作區;輸入非版本庫資料夾則不能勾
    await click($('.add:not(.old)'));
    const cwdInput = $('.addform .pick input');
    await click(cwdInput);
    await input({ type: 'text', text: window.__TEST_CWD__ });
    await wait(900);
    const box = $('.addform label.check input');
    log('版本庫資料夾:可勾選', !box.disabled, '| 說明', $('.addform label.check .note').textContent.slice(0, 40));
    await click(box);
    await wait(300);
    log('勾選後', box.checked, '| 說明', $('.addform label.check .note').textContent.slice(0, 60));
    await shot('2-isolate-option');
    await shot('2-isolate-option-b');
    log('全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(500);
  document.title = 'QUIT';
})();
