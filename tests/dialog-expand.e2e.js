// 對話視窗向上展開到滿、輸入框展開成多行編輯。假資料模式,由 tests/dialog-expand.sh 啟動。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); document.title = `SHOT:${name}-b`; await wait(900); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${detail}` : ''}`); };
  const key = (el, init) => el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const setText = (ta, v) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, v); ta.dispatchEvent(new Event('input', { bubbles: true })); };
  try {
    await window.nexus.setAutopilot(false);
    await wait(2500);
    log('起始狀態', JSON.stringify({ stored: localStorage.getItem('nexus.dlgFull'), dialogOpen: !!document.querySelector('.dialog'), origin: location.origin }));
    localStorage.removeItem('nexus.dlgFull');
    const a = (await window.nexus.getSnapshot()).agents.find(x => !x.parentId);
    const open = async () => { [...document.querySelectorAll('.roster-list .row')].find(r => r.textContent.includes(a.name)).click(); await wait(900); };
    await open();
    const stage = document.querySelector('.stage').getBoundingClientRect();
    const dlg = () => document.querySelector('.dialog').getBoundingClientRect();
    const h0 = dlg().height;
    expect('預設佔下半部', h0 < stage.height * 0.7, `${Math.round(h0)}/${Math.round(stage.height)}`);

    // 展開到滿
    document.querySelector('.dlg-full').click(); await wait(1200);
    expect('展開後佔滿面板', dlg().height > stage.height - 40 && dlg().top - stage.top <= 20, `高 ${Math.round(dlg().height)}/${Math.round(stage.height)},上緣 ${Math.round(dlg().top)}/${Math.round(stage.top)}`);
    expect('按鈕變成還原', document.querySelector('.dlg-full').textContent.includes('還原'));
    await shot('expand-1-full');
    // 設定會記住:關掉再開、換節點都維持展開
    document.querySelector('.dlg-id button[aria-label="關閉"]').click(); await wait(400);
    await open();
    expect('重新打開仍是展開', document.querySelector('.dialog').classList.contains('full'));
    // 快捷鍵 Alt+F 還原
    key(window, { key: 'f', altKey: true }); await wait(400);
    expect('Alt+F 還原', !document.querySelector('.dialog').classList.contains('full') && Math.abs(dlg().height - h0) < 4, String(Math.round(dlg().height)));

    // 輸入框展開
    const ta = () => document.querySelector('.dlg-input textarea');
    const t0 = ta().getBoundingClientRect().height;
    document.querySelector('.dlg-tall').click(); await wait(400);
    const t1 = ta().getBoundingClientRect().height;
    expect('輸入框展開', t1 > t0 * 3 && t1 > 120, `${Math.round(t0)} → ${Math.round(t1)}`);
    expect('對話內容仍看得到', document.querySelector('.dlg-stream').getBoundingClientRect().height > 40, String(Math.round(document.querySelector('.dlg-stream').getBoundingClientRect().height)));
    setText(ta(), '第一行\n第二行'); await wait(200);
    const before = (await window.nexus.getHistory(a.id)).filter(e => e.type === 'message' && e.role === 'user').length;
    key(ta(), { key: 'Enter' }); await wait(700);
    expect('展開時 Enter 不送出', (await window.nexus.getHistory(a.id)).filter(e => e.type === 'message' && e.role === 'user').length === before && ta().value === '第一行\n第二行');
    await shot('expand-2-input');
    key(window, { key: 'f', altKey: true }); await wait(500);
    const t2 = ta().getBoundingClientRect().height;
    expect('視窗展開時輸入框更高', t2 > t1 * 1.4, `${Math.round(t1)} → ${Math.round(t2)}`);
    await shot('expand-3-both');
    key(ta(), { key: 'Enter', ctrlKey: true }); await wait(900);
    const msgs = (await window.nexus.getHistory(a.id)).filter(e => e.type === 'message' && e.role === 'user');
    expect('Ctrl+Enter 送出多行指令', msgs.length === before + 1 && msgs[msgs.length - 1].text === '第一行\n第二行', JSON.stringify(msgs.slice(-1).map(m => m.text)));
    expect('送出後輸入框收回', !document.querySelector('.dlg-input').classList.contains('tall') && ta().value === '');
    // Alt+E 展開與收回;收回後 Enter 照常送出
    key(window, { key: 'e', altKey: true }); await wait(300);
    expect('Alt+E 展開輸入框', document.querySelector('.dlg-input').classList.contains('tall'));
    key(window, { key: 'e', altKey: true }); await wait(300);
    expect('Alt+E 收回輸入框', !document.querySelector('.dlg-input').classList.contains('tall'));
    localStorage.removeItem('nexus.dlgFull');
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
