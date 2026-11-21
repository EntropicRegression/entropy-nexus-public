// 缺口 8a 多模態輸入的驗收(假資料模式,由 tests/attachments.sh 啟動):
// 貼上截圖 → 出現縮圖 → 移除 → 拖放 PDF、圖片與文字檔 → 送出 → 檢查轉接器收到的附件與 note;
// 最後開啟手機遠端並回報配對碼,由 tests/attachments-remote.mjs 從外部測上傳,等它送出「收工」才結束。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  const until = async (what, fn, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(150); }
    throw new Error(`等不到:${what}`);
  };
  const dir = window.__TEST_CWD__;
  const png = `${dir}\\sample.png`, pdf = `${dir}\\sample.pdf`, txt = `${dir}\\notes.txt`;
  const chips = () => [...document.querySelectorAll('.dlg-files .file-chip')];
  const paste = files => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    document.querySelector('.dlg-input textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  };
  try {
    await window.nexus.setAutopilot(false);
    const snap = await until('假資料節點待命', async () => { const s = await window.nexus.getSnapshot(); return s.agents.length >= 6 && s.agents.every(a => a.state === 'idle') ? s : null; });
    log('能力宣告', JSON.stringify(snap.capabilities.map(c => [c.backend, c.attachments])));
    const atlas = snap.agents.find(a => a.name === 'Atlas');
    window.__nexusSelect('Atlas');
    await until('對話視窗', () => document.querySelector('.dlg-input textarea'));

    // 1. 從剪貼簿貼上一張截圖(沒有路徑的圖片)
    const canvas = Object.assign(document.createElement('canvas'), { width: 160, height: 100 });
    const g = canvas.getContext('2d');
    g.fillStyle = '#ff4d5e'; g.fillRect(0, 0, 160, 100); g.fillStyle = '#3fd8e6'; g.fillRect(20, 20, 120, 60);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    paste([new File([blob], 'image.png', { type: 'image/png' })]);
    const thumb = await until('貼上後出現縮圖', () => document.querySelector('.dlg-files .file-thumb[src^="data:image"]'));
    const pasted = chips()[0].title.split(' · ').pop();
    log('貼上:附件', chips().length, '個 | 暫存檔', pasted, '| 縮圖', thumb.src.slice(0, 30), `${thumb.naturalWidth}x${thumb.naturalHeight}`, '| 標籤', JSON.stringify(chips()[0].textContent));
    await shot('1-pasted');

    // 2. 個別移除
    chips()[0].querySelector('button').click();
    await until('附件被移除', () => chips().length === 0);
    log('移除後附件數', chips().length);
    await shot('2-removed');

    // 3. 縮圖只限登記過的路徑
    log('未登記路徑的縮圖', JSON.stringify(await window.nexus.attachmentPreview(png)), '| 系統檔', JSON.stringify(await window.nexus.attachmentPreview('C:\\Windows\\System32\\SecurityAndMaintenance.png')), '| 已登記的暫存檔', (await window.nexus.attachmentPreview(pasted))?.slice(0, 22));

    // 4. 拖放真實檔案:PDF、圖片、文字檔(檔案由主行程經 DevTools 協定放進檔案欄位,File 物件帶有真正的路徑)
    const input = Object.assign(document.createElement('input'), { type: 'file', multiple: true, id: 'test-files' });
    input.style.display = 'none';
    document.body.appendChild(input);
    const changed = new Promise(r => input.addEventListener('change', r, { once: true }));
    document.title = 'FILES:' + JSON.stringify([pdf, png, txt]);
    await changed;
    const dt = new DataTransfer();
    for (const f of input.files) dt.items.add(f);
    document.querySelector('section.dialog').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    await until('三個附件與圖片縮圖', () => chips().length === 3 && document.querySelector('.dlg-files .file-thumb[src^="data:image"]'));
    log('拖放後的附件', JSON.stringify(chips().map(c => c.textContent)));
    log('拖放後圖片縮圖', (await window.nexus.attachmentPreview(png))?.slice(0, 22));
    document.querySelector('.dlg-input textarea').focus();
    await shot('3-attached');

    // 5. 送出,檢查轉接器收到的附件與 note
    [...document.querySelectorAll('.dlg-input button')].find(b => b.textContent === '送出').click();
    const h = await until('轉接器回報附件', async () => { const h = await window.nexus.getHistory(atlas.id); return h.some(e => e.type === 'note' && e.text.includes('模擬後台')) ? h : null; });
    log('送出後的附件標籤數', chips().length);
    log('使用者訊息', JSON.stringify(h.filter(e => e.type === 'message' && e.role === 'user').slice(-1)[0]?.text));
    for (const e of h.filter(e => e.type === 'note')) log('note', JSON.stringify(e.text));
    await wait(600);
    await shot('4-sent');

    // 6. 貼上沒有路徑的非圖片檔、超過上限的圖片,以及直接呼叫存檔 API 傳非圖片
    paste([new File(['hello'], 'clip.txt', { type: 'text/plain' })]);
    await wait(300);
    log('貼上沒有路徑的文字檔', JSON.stringify(document.querySelector('.dlg-main > .line.err')?.textContent));
    paste([new File([new Uint8Array(11 * 1024 * 1024)], 'huge.png', { type: 'image/png' })]);
    await until('太大的圖片被擋下', () => document.querySelector('.dlg-main > .line.err')?.textContent.includes('MB'));
    log('貼上 11 MB 的圖片', JSON.stringify(document.querySelector('.dlg-main > .line.err')?.textContent), '| 附件數', chips().length);
    await window.nexus.savePastedImage('text/html', new ArrayBuffer(4)).then(p => log('存檔 API 收了非圖片(不應該)', p), e => log('存檔 API 拒絕非圖片', JSON.stringify(String(e.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))));
    await shot('5-errors');

    // 語音輸入可行性:Electron 內建的 Web Speech 辨識要連 Google 的服務,通常不能用,這裡實測一次
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) log('語音辨識:沒有 SpeechRecognition');
    else {
      const r = new SR();
      r.lang = 'zh-TW';
      const outcome = await new Promise(res => {
        const t = setTimeout(() => res('8 秒內沒有結果或錯誤'), 8000);
        r.onerror = e => { clearTimeout(t); res(`錯誤 ${e.error}${e.message ? ' ' + e.message : ''}`); };
        r.onresult = () => { clearTimeout(t); res('有辨識結果'); };
        r.onend = () => { clearTimeout(t); res('結束(沒有結果)'); };
        try { r.start(); } catch (e) { clearTimeout(t); res(`start 失敗 ${e.message}`); }
      });
      try { r.abort(); } catch { /* 已結束 */ }
      log('語音辨識:', outcome);
    }

    // 7. 手機遠端:回報配對碼與連接埠,等外部腳本送出「收工」
    await window.nexus.remoteSet({ enabled: true });
    await wait(1200);
    const st = await window.nexus.remoteStatus();
    log('REMOTE', st.port, JSON.stringify(st.listening));
    log('CODE', st.pairCode);
    await until('外部腳本送出收工', async () => {
      for (const a of (await window.nexus.getSnapshot()).agents) if ((await window.nexus.getHistory(a.id)).some(e => e.type === 'message' && e.role === 'user' && e.text === '收工')) return true;
      return false;
    }, 120000);
    const vega = (await window.nexus.getSnapshot()).agents.find(a => a.name === 'Vega');
    window.__nexusSelect('Vega');
    await wait(800);
    await shot('6-remote-sent');
    await window.nexus.remoteSet({ enabled: false });
    log('全部步驟完成', vega ? '' : '(找不到 Vega)');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(400);
  document.title = 'QUIT';
})();
