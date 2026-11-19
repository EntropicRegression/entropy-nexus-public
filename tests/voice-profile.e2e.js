// 角色的聲音(和角色卡整合)的驗收,在主控台畫面裡執行(假資料模式,不需要語音服務)。
// 檢查:沒有聲音時的狀態、儲存錄音與錄音內容、語氣、讀回與播放原音、拒絕太短或非 16-bit 的錄音、移除;
// 並打開新增節點面板,截圖確認角色卡底下的「聲音」區塊。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const errOf = async p => { try { await p; return ''; } catch (e) { return String(e?.message ?? e); } };
  // 產生一段 WAV(正弦波);bits 可以是 16 或 24
  const wav = (sec, bits = 16, rate = 16000) => {
    const n = Math.round(sec * rate), bps = bits / 8;
    const buf = new ArrayBuffer(44 + n * bps), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * bps, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * bps, true); v.setUint16(32, bps, true); v.setUint16(34, bits, true); str(36, 'data'); v.setUint32(40, n * bps, true);
    if (bits === 16) for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true);
    return buf;
  };
  const C = 'VoiceChar';
  try {
    await window.nexus.setAutopilot(false);
    await window.nexus.setPersona(C, '測試用的角色卡。');
    const p0 = await window.nexus.voiceProfile(C);
    ok(p0 && !p0.hasVoice && p0.promptText === '' && p0.style === '', '一開始沒有聲音', JSON.stringify(p0));

    ok((await errOf(window.nexus.voiceProfileSave(C, { wav: wav(1) }))).includes('太短'), '少於 2 秒的錄音被拒絕');
    ok((await errOf(window.nexus.voiceProfileSave(C, { wav: wav(3, 24) }))).includes('16-bit'), '非 16-bit 的錄音被拒絕');
    ok((await errOf(window.nexus.voiceProfileSave(C, { wav: new ArrayBuffer(100) }))).includes('WAV'), '不是 WAV 的內容被拒絕');
    ok((await errOf(window.nexus.voiceProfileSave(C, { wav: wav(31) }))).includes('太長'), '超過 30 秒的錄音被拒絕');

    const p1 = await window.nexus.voiceProfileSave(C, { wav: wav(3.2), promptText: '今天天氣很好,我們一起出去走走吧。', style: '用活潑、甜美的語氣說' });
    ok(p1.hasVoice && Math.abs(p1.ms - 3200) < 50 && p1.promptText.startsWith('今天天氣很好') && p1.style === '用活潑、甜美的語氣說', '儲存錄音、錄音內容與語氣', JSON.stringify(p1));
    const audio = await window.nexus.voiceProfileAudio(C);
    ok(audio instanceof ArrayBuffer && audio.byteLength === 44 + 3.2 * 16000 * 2, '讀回參考錄音(播放原音用)', audio?.byteLength);
    const chars = await window.nexus.voiceCharacters();
    ok(chars.some(c => c.character === C && c.hasVoice && c.style === '用活潑、甜美的語氣說'), '語音面板的角色清單同步顯示', JSON.stringify(chars));

    const p2 = await window.nexus.voiceProfileSave(C, { style: '' });
    ok(p2.hasVoice && p2.style === '' && p2.promptText !== '', '只清掉語氣,錄音與內容不動', JSON.stringify(p2));

    // 畫面:新增節點面板選這個角色,角色卡底下有「聲音」區塊
    document.querySelector('.add-row .add')?.click();
    await wait(600);
    const sel = [...document.querySelectorAll('.addform select')][0];
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, C); sel.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(800);
    const ve = document.querySelector('.voice-edit');
    ok(!!ve && ve.textContent.includes(`聲音 · ${C}`) && ve.textContent.includes('有參考錄音(3.2 秒)'), '角色卡底下顯示聲音區塊與錄音長度', ve?.textContent);
    [...ve.querySelectorAll('button')].find(b => b.textContent === '檢視/編輯')?.click();
    await wait(500);
    const btns = [...document.querySelectorAll('.voice-edit button')].map(b => `${b.textContent}${b.disabled ? '(停用)' : ''}`);
    ok(btns.some(b => b.startsWith('重新錄音')) && btns.some(b => b.startsWith('選擇 WAV 檔')) && btns.some(b => b === '播放原音') && btns.some(b => b === '試聽(停用)'), '聲音區塊的按鈕(沒有語音合成時試聽停用)', JSON.stringify(btns));
    document.title = 'SHOT:voice-editor';
    await wait(800);

    const p3 = await window.nexus.voiceProfileSave(C, { wav: null });
    ok(!p3.hasVoice && p3.promptText === '' && (await window.nexus.voiceProfileAudio(C)) === null, '移除聲音:錄音與錄音內容一起刪掉', JSON.stringify(p3));
    ok((await errOf(window.nexus.voiceProfile('..'))) !== '', '不合法的角色名稱被拒絕');
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(300);
  document.title = 'QUIT';
})();
