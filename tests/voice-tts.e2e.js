// 語音模式 Phase 3(節點自己的聲音)的驗收,在主控台畫面裡執行(假資料節點 + 真正的語音服務與 CosyVoice)。
// tests/voice-tts.sh 會在前面接上 VOICE_CMD 與 TTS_DIR 兩個常數,並先在測試資料夾的角色 TestVoice 放好 voice.wav。
// 檢查:語音合成載入、角色清單標示有聲音、試聽、有聲音的角色播報用合成語音、沒有聲音的節點仍用系統語音。朗讀會真的從喇叭念出來。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(300); } return null; };
  try {
    localStorage.setItem('nexus.speak', '1');
    await window.nexus.setAutopilot(false);
    let s = await window.nexus.voiceSet({ enabled: true, command: VOICE_CMD, ttsDir: TTS_DIR });
    const t0 = Date.now();
    s = await until(async () => { const v = await window.nexus.voiceStatus(); return v.state === 'error' || v.tts.state === 'ready' || v.tts.state === 'error' ? v : null; }, 240000);
    log('載入', `${Math.round((Date.now() - t0) / 1000)} 秒`, s?.device, JSON.stringify(s?.tts));
    if (!(s?.state === 'ready' && s.tts.state === 'ready')) { const v = await window.nexus.voiceStatus(); log('語音服務狀態', v.state, JSON.stringify(v.tts), v.detail, '|', v.log.slice(-8).join(' / ')); }
    ok(s?.state === 'ready' && s.tts.state === 'ready', '語音辨識與語音合成都載入了', JSON.stringify(s).slice(0, 400));

    const chars = await window.nexus.voiceCharacters();
    ok(chars.some(c => c.character === 'TestVoice' && c.hasVoice), '角色清單標示 TestVoice 有聲音(只有 voice.wav 的角色也會列出)', JSON.stringify(chars));

    const tp = Date.now();
    const sample = await window.nexus.voiceTts({ character: 'TestVoice' }, '你好,這是試聽。');
    ok(sample instanceof ArrayBuffer && sample.byteLength > 10000, '試聽:用角色的聲音合成出 WAV', `${sample?.byteLength} bytes`);
    log('試聽合成', `${Date.now() - tp} ms`);
    // 合成語音要能在畫面裡真的播放(畫面的安全政策要允許 blob: 音訊)
    const played = await new Promise(resolve => {
      const url = URL.createObjectURL(new Blob([sample], { type: 'audio/wav' }));
      const a = new Audio(url); a.volume = 0.2;
      a.onplaying = () => { a.pause(); URL.revokeObjectURL(url); resolve('playing'); };
      a.onerror = () => resolve(`error ${a.error?.code}`);
      a.play().catch(e => resolve(`rejected ${e?.message ?? e}`));
      setTimeout(() => resolve('timeout'), 8000);
    });
    ok(played === 'playing', '合成語音可以在畫面裡播放(安全政策允許 blob: 音訊)', played);
    // 內容要念對:用語音辨識聽一次合成結果(繁體字沒轉簡體時,「測試」會被念成「收息」之類)
    const said = (await window.nexus.voiceTranscribe(await window.nexus.voiceTts({ character: 'TestVoice' }, '測試完成了,三個測試全部通過。'))).text;
    ok(/[測测]試|[測测]试/.test(said) && /通[過过]/.test(said), '合成的內容念得正確(用語音辨識檢查)', said);
    ok((await window.nexus.voiceTts({ character: 'NoSuchVoice' }, '你好')) === null, '沒有 voice.wav 的角色回傳 null(改用系統語音)');

    const cwd = window.__TEST_CWD__;
    const voiced = await window.nexus.createAgent({ name: 'Voiced', character: 'TestVoice', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
    const plain = await window.nexus.createAgent({ name: 'Plain', character: '', model: '', backend: 'codex', cwd, permissionMode: 'auto' });
    await wait(2500);
    const via = () => window.__nexusSpokenVia ?? [];
    const spoken = () => window.__nexusSpokenLog ?? [];

    await window.nexus.send(voiced.id, '圖片測試\n語音合成的測試完成了。');
    const v1 = await until(() => { const i = spoken().findIndex(t => t.startsWith('Voiced:')); return i >= 0 ? via()[i] ?? 'unknown' : null; }, 60000);
    ok(v1 === 'tts', '有聲音的節點:完成播報用合成語音', `${v1} ${JSON.stringify(spoken())} ${JSON.stringify(via())}`);
    await wait(8000);

    await window.nexus.send(plain.id, '圖片測試\n沒有聲音的節點完成了。');
    const v2 = await until(() => { const i = spoken().findIndex(t => t.startsWith('Plain:')); return i >= 0 ? via()[i] ?? 'unknown' : null; }, 60000);
    ok(v2 === 'system', '沒有聲音的節點:仍用系統語音', `${v2} ${JSON.stringify(spoken())} ${JSON.stringify(via())}`);
    await wait(4000);

    await window.nexus.voiceSet({ enabled: false });
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
