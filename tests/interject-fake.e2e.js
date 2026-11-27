// 驗收:回合中插話與輸入框暫存(假資料模式,由 tests/interject-fake.sh 啟動,不消耗額度)。
// - 支援插話的後台(Claude Code):執行中送出不排隊、直接送進回合;對話視窗有「插話」按鈕;狀態不會被改回「思考中」。
// - 不支援的後台(Antigravity):執行中送出改成排隊並說明,回合完成後自動送出;對話視窗沒有「插話」按鈕。
// - 輸入框暫存:打到一半切到別的節點,切回來時文字還在;送出後清掉。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  let n = 0;
  const input = async a => { document.title = `INPUT:${++n}|${JSON.stringify(a)}`; await wait(140); };
  const center = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  const click = async el => { await input({ type: 'click', ...center(el) }); await wait(250); };
  const snap = () => window.nexus.getSnapshot();
  const ag = async id => (await snap()).agents.find(x => x.id === id);
  const until = async (what, fn, timeout = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(150); } throw new Error(`等不到:${what}`); };
  const $ = s => document.querySelector(s);
  const buttons = () => [...document.querySelectorAll('.dlg-input button')].map(b => b.textContent.trim());
  const openDialog = async name => { window.__nexusSelect(name); await wait(500); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${String(detail).slice(0, 300)}` : ''}`); };
  try {
    await window.nexus.setAutopilot(false);
    const cwd = window.__TEST_CWD__;
    const c = await window.nexus.createAgent({ name: '插話-claude', character: '', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
    const g = await window.nexus.createAgent({ name: '插話-agy', character: '', model: '', backend: 'antigravity', cwd, permissionMode: 'auto' });
    await until('兩個節點待命', async () => (await ag(c.id))?.state === 'idle' && (await ag(g.id))?.state === 'idle');

    // 1. 支援插話(權限用 auto,假資料回合不會停在待授權;待授權時不插話)
    await window.nexus.send(c.id, '請慢慢想一下');
    await until('claude 開始執行', async () => ['planning', 'working'].includes((await ag(c.id))?.state));
    await openDialog('插話-claude');
    expect('支援的後台執行中有「插話」按鈕', buttons().includes('插話'), buttons().join(','));
    const beforeC = await ag(c.id);
    await window.nexus.send(c.id, '(插話)補充一句');
    const afterC = await ag(c.id);
    expect('插話不排隊', afterC.queued.length === 0, JSON.stringify(afterC.queued));
    const usersC = (await window.nexus.getHistory(c.id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
    expect('插話寫進對話紀錄', usersC.includes('(插話)補充一句'), usersC.join(' | '));
    expect('插話後狀態沒有被改回思考中', afterC.state === beforeC.state || afterC.state === 'idle' || beforeC.state === 'planning', `${beforeC.state}/${beforeC.detail} → ${afterC.state}/${afterC.detail}`);
    await until('claude 回合結束', async () => (await ag(c.id))?.state === 'idle', 60000);

    // 2. 不支援插話:改成排隊並說明,回合完成後自動送出
    await window.nexus.send(g.id, '請慢慢想一下');
    await until('agy 開始執行', async () => ['planning', 'working'].includes((await ag(g.id))?.state));
    await openDialog('插話-agy');
    expect('不支援的後台執行中沒有「插話」按鈕', !buttons().includes('插話') && buttons().includes('排隊'), buttons().join(','));
    await window.nexus.send(g.id, '(插話)會被排隊');
    const afterG = await ag(g.id);
    expect('不支援插話的後台改成排隊', afterG.queued.length === 1 && afterG.queued[0].text === '(插話)會被排隊', JSON.stringify(afterG.queued));
    const notesG = (await window.nexus.getHistory(g.id)).filter(e => e.type === 'note').map(e => e.text);
    expect('有說明為什麼排隊', notesG.some(t => /不支援回合中插話/.test(t)), notesG.join(' | '));
    await until('排隊的指令在回合完成後送出', async () => { const a = await ag(g.id); return a.queued.length === 0 && a.state === 'idle' && (await snap()).tasks.filter(t => t.agentId === g.id && t.endedAt !== null).length === 2; }, 60000);
    expect('排隊的指令成為第二個任務', true);

    // 3. 輸入框暫存:在 claude 的對話打到一半,切到 agy 再切回來
    await openDialog('插話-claude');
    const ta = () => $('.dlg-input textarea');
    await click(ta());
    await input({ type: 'text', text: '打到一半的草稿' });
    await wait(300);
    expect('輸入框有打進去的文字', ta()?.value === '打到一半的草稿', ta()?.value);
    await openDialog('插話-agy');
    expect('切到別的節點時是那個節點自己的輸入框(空白)', ta()?.value === '', ta()?.value);
    await openDialog('插話-claude');
    expect('切回來時草稿還在', ta()?.value === '打到一半的草稿', ta()?.value);
    expect('草稿存在本機(重開後也在)', localStorage.getItem(`nexus.draft.${c.id}`) === '打到一半的草稿');
    await input({ type: 'key', key: 'Enter' });
    await until('草稿送出後清掉', async () => ta()?.value === '' && !localStorage.getItem(`nexus.draft.${c.id}`), 5000).catch(() => null);
    expect('送出後輸入框與本機暫存都清掉', ta()?.value === '' && !localStorage.getItem(`nexus.draft.${c.id}`), `${ta()?.value} / ${localStorage.getItem(`nexus.draft.${c.id}`)}`);
    const usersC2 = (await window.nexus.getHistory(c.id)).filter(e => e.type === 'message' && e.role === 'user').map(e => e.text);
    expect('草稿照常送出', usersC2.includes('打到一半的草稿'), usersC2.join(' | '));

    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
