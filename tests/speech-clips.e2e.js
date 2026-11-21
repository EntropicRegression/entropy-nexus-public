// 語音播報的引擎層驗收,在主控台畫面裡執行(假資料模式,由 tests/speech-clips.sh 啟動)。
// 角色 ClipVoice 的資料夾有 clips/done.wav、done-2.wav、failed.wav(外層腳本產生的短音)。
// 檢查的是「真的播放了」:__nexusSpokenVia 只在 <audio> 送出 playing 事件後才記下引擎。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const ok = (cond, what, extra = '') => log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`));
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await wait(200); } return null; };
  const via = () => window.__nexusSpokenVia ?? [];
  const spoken = () => window.__nexusSpokenLog ?? [];
  // 某個節點最近一次完成播報實際用的引擎(spokenLog 與 spokenVia 一一對應)
  const engineOf = async (prefix, after) => until(() => { const i = spoken().findIndex((t, k) => k >= after && t.startsWith(prefix)); return i >= 0 ? via()[i] ?? 'unknown' : null; }, 30000);
  try {
    localStorage.setItem('nexus.speak', '1');
    await window.nexus.setAutopilot(false);

    const info = await window.nexus.speechSettings();
    ok(JSON.stringify(info.settings.engines) === '["clips","local"]', '預設的引擎順序:固定語音 → 本機語音合成', JSON.stringify(info.settings));
    const clipsState = info.engines.find(e => e.id === 'clips');
    ok(clipsState?.ready, '固定語音引擎可以使用', JSON.stringify(info.engines));
    const set = info.clips.find(c => c.character === 'ClipVoice');
    ok(set?.counts.done === 2 && set?.counts.failed === 1 && !set?.counts.approval, '列出角色的固定語音:完成 2 條、出錯 1 條', JSON.stringify(info.clips));
    const sample = await window.nexus.speechClip('ClipVoice', 'done');
    ok(sample && sample.mime === 'audio/wav' && sample.audio.byteLength > 44, '試聽固定語音拿得到音檔', sample ? `${sample.mime} ${sample.audio.byteLength}` : 'null');
    ok(await window.nexus.speechClip('ClipVoice', 'question') === null && await window.nexus.speechClip('..', 'done') === null, '沒有錄音的事件、不正確的角色名稱回傳 null');

    const cwd = window.__TEST_CWD__;
    const voiced = await window.nexus.createAgent({ name: 'Clippy', character: 'ClipVoice', model: '', backend: 'claude', cwd, permissionMode: 'auto' });
    const plain = await window.nexus.createAgent({ name: 'Plain', character: '', model: '', backend: 'codex', cwd, permissionMode: 'auto' });
    await wait(2500);

    let mark = spoken().length;
    await window.nexus.send(voiced.id, '圖片測試\n固定語音的測試完成了。');
    const e1 = await engineOf('Clippy', mark);
    ok(e1 === 'clips', '有固定語音的角色:完成播報真的播放了固定語音', `${e1} ${JSON.stringify(via())}`);
    await wait(2500);

    mark = spoken().length;
    await window.nexus.send(plain.id, '圖片測試\n沒有角色的節點完成了。');
    const e2 = await engineOf('Plain', mark);
    ok(e2 === 'system', '沒有角色的節點:用系統語音', `${e2} ${JSON.stringify(via())}`);
    await wait(4000);

    // 關掉固定語音:同一個節點改用系統語音(本機語音合成沒有啟用)
    const after = await window.nexus.speechSet({ engines: ['local'] });
    ok(JSON.stringify(after.settings.engines) === '["local"]', '設定引擎:只留本機語音合成', JSON.stringify(after.settings));
    ok(JSON.stringify((await window.nexus.speechSet({ engines: ['local', 'nope', 'local'] })).settings.engines) === '["local"]', '設定引擎:去掉不認得的與重複的');
    mark = spoken().length;
    await window.nexus.send(voiced.id, '圖片測試\n關掉固定語音之後完成了。');
    const e3 = await engineOf('Clippy', mark);
    ok(e3 === 'system', '關掉固定語音後:改用系統語音', `${e3} ${JSON.stringify(via())}`);
    await wait(4000);

    const saved = await window.nexus.speechSettings();
    ok(JSON.stringify(saved.settings.engines) === '["local"]', '重新讀取的引擎設定和剛才設定的一致', JSON.stringify(saved.settings));
    await window.nexus.speechSet({ engines: ['clips', 'local'] });

    // 設定面板:列出兩個來源與 ClipVoice 的試聽按鈕
    [...document.querySelectorAll('.topbar button')].find(b => b.textContent === '語音').click();
    const panel = await until(() => document.querySelector('.speech-engine') && document.querySelectorAll('.speech-engine').length === 2 && [...document.querySelectorAll('.voice-char')].some(r => r.textContent.includes('ClipVoice')), 10000);
    ok(!!panel, '語音面板列出兩個聲音來源與角色的固定語音', document.querySelector('.voice')?.innerText.slice(0, 300));
    document.title = 'SHOT:speech-engines';
    await wait(1500);
    log('主控台端結束');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  document.title = 'QUIT';
})();
