// 指令排隊佇列:忙碌時排隊、依序自動送出、取消與編輯、達同時執行上限自動排隊、中斷後暫停與繼續、額度上限暫停、重開後仍保留。
// 假資料模式(NEXUS_FAKE=1、NEXUS_NO_SEED=1),不消耗訂閱額度。同一個資料夾執行兩次:第一次建立佇列後結束,第二次檢查重開後的佇列。
// 用法:bash tests/queue-fake.sh
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let n = 0;
  const input = async a => { document.title = `INPUT:${++n}|${JSON.stringify(a)}`; await wait(140); };
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const center = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const click = async el => { await input({ type: 'click', ...center(el) }); await wait(220); };
  const snap = () => window.nexus.getSnapshot();
  const ag = async id => (await snap()).agents.find(x => x.id === id);
  const until = async (what, fn, timeout = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(150); } throw new Error(`等不到:${what}`); };
  const $ = s => document.querySelector(s);
  const titles = async id => (await snap()).tasks.filter(t => t.agentId === id).sort((a, b) => a.startedAt - b.startedAt).map(t => `${t.title}=${t.status}`);
  const notes = async id => (await window.nexus.getHistory(id)).filter(e => e.type === 'note').map(e => e.text);
  const awaiting = id => until('進入待回答', async () => (await ag(id)).pendingQuestion, 20000);
  const answer = async id => { const q = (await ag(id)).pendingQuestion; await window.nexus.answerQuestion(id, q.requestId, { q1: ['紅色'] }); };
  const settled = (id, what) => until(what, async () => { const a = await ag(id); return a.state === 'idle' && a.queued.length === 0 && !(await snap()).tasks.some(t => t.agentId === id && t.endedAt === null); }, 60000);
  let fails = 0;
  const check = (name, ok, extra = '') => { if (!ok) fails++; log(ok ? '通過' : '不符', name, extra); };
  const openDialog = async name => { [...document.querySelectorAll('.row')].find(r => r.textContent.includes(name)).click(); await wait(500); };
  const closeDialog = async () => { const b = $('.dlg-id .ghost[aria-label="關閉"]'); if (b) b.click(); await wait(300); };

  try {
    await window.nexus.setAutopilot(false);
    const first = (await snap()).agents.length === 0;

    if (first) {
      const cwd = window.__TEST_CWD__;
      for (const name of ['甲', '乙', '丙']) await window.nexus.createAgent({ name, character: '', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
      const list = await until('三個節點待命', async () => { const s = await snap(); return s.agents.length === 3 && s.agents.every(a => a.state === 'idle') ? s.agents : null; });
      const [A, B, C] = ['甲', '乙', '丙'].map(nm => list.find(a => a.name === nm));
      check('新節點的佇列是空的', list.every(a => Array.isArray(a.queued) && a.queued.length === 0 && a.queuePaused === null));

      // 1. 忙碌時排入兩筆,外加一筆取消、一筆編輯
      await window.nexus.send(A.id, '請提問');
      await awaiting(A.id);
      await window.nexus.enqueue(A.id, '程式碼 排隊一');
      await window.nexus.enqueue(A.id, '這筆會被取消');
      await window.nexus.enqueue(A.id, '程式碼 排隊二(編輯前)');
      let a = await ag(A.id);
      await window.nexus.cancelQueued(A.id, a.queued[1].id);
      await window.nexus.editQueued(A.id, a.queued[2].id, '程式碼 排隊二(編輯後)');
      a = await ag(A.id);
      check('忙碌時排隊、取消與編輯', a.queued.map(q => q.text).join(' | ') === '程式碼 排隊一 | 程式碼 排隊二(編輯後)' && a.state === 'awaiting', a.queued.map(q => q.text).join(' | '));
      await openDialog('甲');
      log('對話視窗的排隊列', [...document.querySelectorAll('.queue-item')].map(e => e.textContent).join(' / '));
      log('任務面板的排隊列', [...document.querySelectorAll('.task.t-queued')].map(e => e.textContent).join(' / '));
      await shot('1-queued-while-busy');
      await answer(A.id);
      await settled(A.id, '甲的佇列跑完');
      const t1 = await titles(A.id);
      check('依序自動執行且各自成為一筆任務', t1.join(' | ') === '請提問=done | 程式碼 排隊一=done | 程式碼 排隊二(編輯後)=done', t1.join(' | '));
      const users = (await window.nexus.getHistory(A.id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
      check('對話紀錄的指令順序', users.join(' | ') === '請提問 | 程式碼 排隊一 | 程式碼 排隊二(編輯後)', users.join(' | '));
      await closeDialog();

      // 2. 達同時執行上限:被擋下的指令自動排隊,名額釋出後依排入時間先後送出
      await window.nexus.setMaxActive(1);
      await window.nexus.send(A.id, '請提問');
      await awaiting(A.id);
      await window.nexus.send(B.id, '程式碼 乙(達上限)');
      await wait(50);
      await window.nexus.send(C.id, '程式碼 丙(達上限)');
      await wait(400);
      const b2 = await ag(B.id), c2 = await ag(C.id);
      check('達上限時自動排隊', b2.state === 'idle' && c2.state === 'idle' && b2.queued.length === 1 && c2.queued.length === 1, `乙=${b2.state}/${b2.queued.length} 丙=${c2.state}/${c2.queued.length}`);
      const bn = (await notes(B.id)).pop();
      check('排隊說明', /已達同時執行上限.*指令已排隊/.test(bn ?? ''), JSON.stringify(bn));
      const bErr = (await window.nexus.getHistory(B.id)).filter(e => e.type === 'error');
      check('不再報錯', bErr.length === 0);
      await openDialog('乙');
      await shot('2-limit-queued');
      await closeDialog();
      await answer(A.id);
      const order = await until('名額釋出後有節點開始', async () => {
        const s = await snap(); const bb = s.agents.find(x => x.id === B.id), cc = s.agents.find(x => x.id === C.id);
        const busy = x => ['planning', 'working', 'awaiting'].includes(x.state);
        return busy(bb) || busy(cc) ? { b: bb.state, bq: bb.queued.length, c: cc.state, cq: cc.queued.length } : null;
      }, 20000);
      check('先排入的乙先送出,丙繼續等', order.b !== 'idle' && order.cq === 1 && order.c === 'idle', JSON.stringify(order));
      await settled(B.id, '乙跑完');
      await settled(C.id, '丙跑完');
      check('丙在乙之後送出', (await titles(C.id)).join() === '程式碼 丙(達上限)=done', (await titles(C.id)).join());
      await window.nexus.setMaxActive(4);

      // 3. 中斷後佇列暫停;用 Alt+Enter 排隊,按「繼續」後恢復
      await window.nexus.send(A.id, '請提問');
      await awaiting(A.id);
      await openDialog('甲');
      await window.nexus.enqueue(A.id, '程式碼 中斷後一');
      await click($('.dlg-input textarea'));
      await input({ type: 'text', text: '程式碼 中斷後二' });
      await input({ type: 'key', key: 'Enter', modifiers: ['alt'] });
      await wait(400);
      a = await ag(A.id);
      check('Alt+Enter 排進佇列', a.queued.map(q => q.text).join(' | ') === '程式碼 中斷後一 | 程式碼 中斷後二' && $('.dlg-input textarea').value === '', a.queued.map(q => q.text).join(' | '));
      await window.nexus.interrupt(A.id);
      await until('中斷後待命', async () => (await ag(A.id)).state === 'idle', 10000);
      await wait(1500);
      a = await ag(A.id);
      check('中斷後佇列暫停且保留內容', a.queuePaused === '回合被中斷' && a.queued.length === 2 && a.state === 'idle', `${a.queuePaused} / ${a.queued.length} / ${a.state}`);
      log('暫停說明', JSON.stringify((await notes(A.id)).pop()));
      log('暫停列', $('.queue-paused')?.textContent);
      await shot('3-paused');
      await click($('.queue-paused button'));
      await settled(A.id, '繼續後佇列跑完');
      const t3 = (await titles(A.id)).slice(-3);
      check('繼續後依序送出', t3.join(' | ') === '請提問=interrupted | 程式碼 中斷後一=done | 程式碼 中斷後二=done', t3.join(' | '));
      await closeDialog();

      // 4. 額度上限:佇列送出時被擋下,留在佇列並暫停
      for (let i = 0; i < 8 && !(await snap()).usage.find(u => u.backend === 'claude')?.windows.length; i++) {
        await window.nexus.send(B.id, '測試');
        await until('回合結束', async () => ['idle', 'error'].includes((await ag(B.id)).state) && !(await snap()).tasks.some(t => t.agentId === B.id && t.endedAt === null), 60000);
      }
      await window.nexus.setQuotaStop(1);
      await window.nexus.enqueue(B.id, '程式碼 額度上限時排隊');
      await wait(800);
      let b4 = await ag(B.id);
      check('額度上限擋下時留在佇列並暫停', b4.queued.length === 1 && /額度已達上限/.test(b4.queuePaused ?? '') && !['planning', 'working'].includes(b4.state), `${b4.queuePaused} / ${b4.queued.length} / ${b4.state}`);
      log('額度說明', JSON.stringify((await notes(B.id)).pop()));
      await window.nexus.setQuotaStop(0);
      await window.nexus.resumeQueue(B.id);
      await settled(B.id, '解除額度上限後跑完');
      check('解除後送出', (await titles(B.id)).pop() === '程式碼 額度上限時排隊=done');

      // 5. 休眠中的節點可以排隊,但不會送出;重開後還在
      await window.nexus.sleep(C.id);
      await until('丙休眠', async () => (await ag(C.id)).state === 'sleeping', 10000);
      await window.nexus.enqueue(C.id, '程式碼 重開後才送');
      await wait(1000);
      const c5 = await ag(C.id);
      check('休眠時不送出', c5.state === 'sleeping' && c5.queued.length === 1);
      log('任務面板的排隊列', [...document.querySelectorAll('.task.t-queued')].map(e => e.textContent).join(' / '));
      await shot('5-before-restart');
      log(fails ? `第一次執行有 ${fails} 項不符` : '第一次執行全部通過');
    } else {
      const s = await snap();
      const C = s.agents.find(a => a.name === '丙'), A = s.agents.find(a => a.name === '甲');
      check('重開後佇列還在,節點休眠不送出', C.state === 'sleeping' && C.queued.map(q => q.text).join() === '程式碼 重開後才送', `${C.state} / ${C.queued.map(q => q.text).join()}`);
      await wait(1500);
      check('等一下仍未送出', (await ag(C.id)).queued.length === 1);
      await window.nexus.wake(C.id);
      await settled(C.id, '喚醒後送出');
      check('喚醒待命後自動送出', (await titles(C.id)).pop() === '程式碼 重開後才送=done', (await titles(C.id)).pop());
      // 手機版:開啟遠端後由 queue-fake.sh 從外部用 HTTP 排隊、取消,這裡等結果
      const B = s.agents.find(a => a.name === '乙');
      await window.nexus.wake(B.id);
      await until('乙待命', async () => (await ag(B.id)).state === 'idle', 10000);
      await window.nexus.remoteSet({ enabled: true });
      await wait(1200);
      const st = await window.nexus.remoteStatus();
      log('REMOTE', JSON.stringify({ port: st.port, listening: st.listening }));
      log('CODE', st.pairCode, B.id);
      await until('手機排隊的指令跑完', async () => (await titles(B.id)).includes('程式碼 手機排隊一=done') && (await ag(B.id)).queued.length === 0 && (await ag(B.id)).state === 'idle', 120000);
      const tb = (await titles(B.id)).slice(-2);
      check('手機排隊依序送出、取消的那筆沒有送出', tb.join(' | ') === '請提問=done | 程式碼 手機排隊一=done', tb.join(' | '));
      await window.nexus.remoteSet({ enabled: false });
      // 終止節點時佇列一併丟棄
      await window.nexus.enqueue(A.id, '終止時丟棄');
      await window.nexus.removeAgent(A.id);
      check('終止後節點與佇列都不在', !(await snap()).agents.some(a => a.id === A.id));
      log(fails ? `第二次執行有 ${fails} 項不符` : '第二次執行全部通過');
    }
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(400);
  document.title = 'QUIT';
})();
