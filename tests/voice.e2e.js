// 語音模式(Phase 1)的驗收,在主控台畫面裡執行。由 tests/voice.sh 在前面接上 VOICE_CMD 與 WAV_B64 兩個常數:
//   VOICE_CMD  啟動語音服務的指令;WAV_B64  一段 16 kHz 單聲道的中文語音(Windows 內建語音合成產生)。
// 檢查:預設關閉、啟用後服務啟動並載入模型、辨識結果、錯誤處理、麥克風權限只給音訊、停用後狀態回到關閉。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const errOf = async p => { try { await p; return ''; } catch (e) { return String(e?.message ?? e); } };
  try {
    const s0 = await window.nexus.voiceStatus();
    ok(!s0.enabled && s0.state === 'off', '預設沒有啟用', JSON.stringify(s0));
    ok(s0.defaultCommand.includes('server.py'), '開發模式找得到預設的啟動指令', s0.defaultCommand);
    ok((await errOf(window.nexus.voiceTranscribe(new ArrayBuffer(1000)))).includes('沒有在執行'), '沒有啟用時不能辨識');

    // 啟動失敗:指令錯誤時狀態變成異常,並留下輸出
    let s = await window.nexus.voiceSet({ enabled: true, command: 'nexus-no-such-command-xyz' });
    for (let i = 0; i < 40 && s.state !== 'error'; i++) { await wait(250); s = await window.nexus.voiceStatus(); }
    ok(s.state === 'error' && /已結束|無法啟動/.test(s.detail), '啟動指令錯誤時狀態是異常', JSON.stringify(s));

    // 正確的指令:推送的狀態會依序經過啟動、載入,最後可以使用
    const seen = [];
    const off = window.nexus.onVoice(v => { if (seen[seen.length - 1] !== v.state) seen.push(v.state); });
    s = await window.nexus.voiceSet({ command: VOICE_CMD });
    const t0 = Date.now();
    while (s.state !== 'ready' && s.state !== 'error' && Date.now() - t0 < 180000) { await wait(500); s = await window.nexus.voiceStatus(); }
    off();
    log('狀態變化', seen.join(' → '), `${Math.round((Date.now() - t0) / 1000)} 秒`, s.device);
    ok(s.state === 'ready', '服務啟動並載入模型', JSON.stringify(s).slice(0, 400));
    ok(seen.includes('starting') && seen.includes('ready'), '畫面收到狀態推送', seen.join());
    ok(s.log.some(l => l.includes('聆聽 127.0.0.1')), '設定面板拿得到服務的輸出(UTF-8 沒有亂碼)', s.log.join(' / '));

    // 辨識
    const bin = Uint8Array.from(atob(WAV_B64), c => c.charCodeAt(0));
    const t1 = Date.now();
    const out = await window.nexus.voiceTranscribe(bin.buffer);
    log('辨識結果', JSON.stringify(out), `來回 ${Date.now() - t1} ms`);
    ok(out.text.includes('會議') && out.text.includes('檢查'), '中文語音轉成文字', out.text);
    ok(!/[会议检结]/.test(out.text), '輸出是繁體字', out.text);
    ok(out.audioMs > 3000, '回報錄音長度', out.audioMs);

    // 錯誤處理
    ok((await errOf(window.nexus.voiceTranscribe(new ArrayBuffer(20)))).includes('太短'), '太短的錄音回錯誤');
    ok((await errOf(window.nexus.voiceTranscribe(new ArrayBuffer(5 * 1024 * 1024)))).includes('太長'), '太長的錄音回錯誤');
    const junk = new Uint8Array(2000); junk.set([82, 73, 70, 70]);
    ok((await errOf(window.nexus.voiceTranscribe(junk.buffer))) !== '', '不是 WAV 的內容回錯誤');

    // 麥克風權限:攝影機一律拒絕;音訊不會被權限擋下(這台電腦沒有麥克風時會是 NotFoundError)
    const video = await navigator.mediaDevices.getUserMedia({ video: true }).then(st => { st.getTracks().forEach(t => t.stop()); return 'granted'; }, e => e.name);
    ok(video === 'NotAllowedError', '攝影機權限被拒絕', video);
    const audio = await navigator.mediaDevices.getUserMedia({ audio: true }).then(st => { st.getTracks().forEach(t => t.stop()); return 'granted'; }, e => e.name);
    // 只有這台電腦真的沒有錄音裝置時,才接受「找不到」
    const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput').length;
    ok(audio === 'granted' || (audio === 'NotFoundError' && mics === 0), '麥克風可以開啟', `${audio}(錄音裝置 ${mics} 個)`);

    // 設定會保存;停用後狀態回到關閉
    s = await window.nexus.voiceSet({ enabled: false });
    ok(s.state === 'off' && !s.enabled && s.command === VOICE_CMD, '停用後狀態是關閉,啟動指令保留', JSON.stringify(s));
    ok((await errOf(window.nexus.voiceTranscribe(bin.buffer))).includes('沒有在執行'), '停用後不能辨識');

    // 再啟用一次,讓 voice.sh 檢查主控台結束時有沒有把服務一起結束
    s = await window.nexus.voiceSet({ enabled: true });
    for (let i = 0; i < 40 && s.state === 'starting'; i++) { await wait(250); s = await window.nexus.voiceStatus(); }
    ok(s.state === 'starting' || s.state === 'warming' || s.state === 'ready', '重新啟用', s.state);
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
