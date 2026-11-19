// Antigravity 的附件(真正的 agy,會用到一點額度)。由 tests/agy-attach.sh 啟動,資料資料夾刻意放在家目錄底下(不在暫存區):
// agy 的無視窗模式會自動拒絕讀取工作區以外的檔案,暫存區剛好例外,放在暫存區就測不出來。
// 檢查:貼上的圖片(在主控台的附件資料夾)與工作目錄以外的檔案(會複製進附件資料夾)它都讀得到。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 120000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(400); } throw new Error(`等不到:${what}`); };
  let bad = 0;
  const expect = (label, ok, detail = '') => { if (!ok) bad++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${detail}` : ''}`); };
  try {
    const a = await window.nexus.createAgent({ name: 'Hydro', character: '', model: '', backend: 'antigravity', cwd: window.__TEST_CWD__, permissionMode: 'ask' });
    await until('節點待命', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle'), 60000);
    const c = document.createElement('canvas'); c.width = 460; c.height = 160;
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 460, 160); g.fillStyle = '#103070'; g.font = 'bold 72px Arial'; g.fillText('QZ-8830', 30, 105);
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    const pasted = await window.nexus.savePastedImage('image/png', await blob.arrayBuffer());
    const ask = async (text, files) => {
      const before = (await window.nexus.getHistory(a.id)).length;
      await window.nexus.send(a.id, text, files);
      await wait(1500);
      await until('回合結束', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && ['idle', 'error', 'lost'].includes(x.state)));
      return (await window.nexus.getHistory(a.id)).slice(before);
    };
    let h = await ask(`請看這張圖片,只回覆圖片裡寫的文字。\n\n附加的檔案:\n- ${pasted}`, [pasted]);
    const reply = h.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' ');
    expect('貼上的圖片讀得到', /QZ.?8830/.test(reply), JSON.stringify({ reply: reply.slice(0, 80), errors: h.filter(e => e.type === 'error').map(e => e.message.slice(0, 90)) }));
    expect('沒有被自動拒絕', !h.some(e => e.type === 'error' && e.message.includes('自動拒絕')));
    // 工作目錄以外的檔案(由 tests/agy-attach.sh 放在家目錄的另一個資料夾)
    const outside = window.__TEST_IMAGE__;
    h = await ask(`請讀這個文字檔,只回覆檔案裡的那串代號。\n\n附加的檔案:\n- ${outside}`, [outside]);
    const reply2 = h.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' ');
    const user = h.find(e => e.type === 'message' && e.role === 'user');
    expect('工作目錄以外的檔案讀得到', /KP-5521/.test(reply2), JSON.stringify({ reply: reply2.slice(0, 80), errors: h.filter(e => e.type === 'error').map(e => e.message.slice(0, 90)) }));
    log('對話裡的指令仍是使用者原本的文字', user ? user.text.includes(outside) : '(找不到)');
    log(bad ? `有 ${bad} 項不符` : '全部通過');
    await window.nexus.removeAgent(a.id);
  } catch (err) {
    log('失敗', err.message);
  }
  document.title = 'QUIT';
})();
