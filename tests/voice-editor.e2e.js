// 驗收:對話視窗「設定」裡的角色卡與聲音區塊(假資料模式,由 tests/voice-editor.sh 啟動,不需要語音服務)。
// - 版面:設定、轉移工作區、角色卡、聲音全部展開時,不會疊到下面的對話紀錄(在自己的區塊裡捲動)。
// - 聲音區塊跟著播報語言:中文編輯 voice.wav 那一組,英文編輯 voice.en.wav 那一組,兩組互不影響。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  let bad = 0;
  const ok = (cond, what, extra = '') => { if (!cond) bad++; log(cond ? '通過' : '不符', what + (cond || !extra ? '' : ` → ${String(extra).slice(0, 300)}`)); };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (what, fn, timeout = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(150); } throw new Error(`等不到:${what}`); };
  const wav = (sec, rate = 16000) => {
    const n = Math.round(sec * rate);
    const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin(i / 8) * 8000, true);
    return buf;
  };
  const C = 'VoiceChar';
  const voiceText = () => document.querySelector('.voice-edit')?.textContent ?? '';
  try {
    await window.nexus.setAutopilot(false);
    await window.nexus.setPersona(C, '測試用的角色卡。');
    // 兩組聲音:中文 3 秒、英文 4 秒
    await window.nexus.voiceProfileSave(C, { wav: wav(3), promptText: '中文的錄音內容' });
    await window.nexus.voiceProfileSave(C, { wav: wav(4), promptText: 'English transcript' }, 'en');
    const zh = await window.nexus.voiceProfile(C), en = await window.nexus.voiceProfile(C, 'en');
    ok(zh.promptText === '中文的錄音內容' && Math.round(zh.ms / 1000) === 3 && en.promptText === 'English transcript' && Math.round(en.ms / 1000) === 4, '中文與英文的聲音各自存讀', JSON.stringify({ zh, en }));

    const a = await window.nexus.createAgent({ name: '聲音測試', character: C, model: '', backend: 'claude', cwd: window.__TEST_CWD__, permissionMode: 'ask' });
    await until('節點待命', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id)?.state === 'idle');
    window.__nexusSelect('聲音測試');
    await wait(600);
    [...document.querySelectorAll('.dialog button')].find(b => b.textContent === '設定')?.click();
    await wait(600);
    // 角色卡與聲音都展開
    for (const b of [...document.querySelectorAll('.dlg-panels .persona-edit button')].filter(x => /檢視\/編輯|撰寫|設定/.test(x.textContent))) b.click();
    await wait(600);
    ok(voiceText().includes(`聲音 · ${C}`) && voiceText().includes('有參考錄音(3.0 秒)'), '中文播報時編輯中文的聲音', voiceText());
    const panels = document.querySelector('.dlg-panels'), stream = document.querySelector('.dialog .dlg-stream');
    const pr = panels?.getBoundingClientRect(), sr = stream?.getBoundingClientRect();
    ok(!!pr && !!sr && pr.bottom <= sr.top + 1, '設定區塊沒有疊到對話紀錄', JSON.stringify({ panelsBottom: pr?.bottom, streamTop: sr?.top }));
    ok(!!panels && (panels.scrollHeight <= panels.clientHeight + 1 || getComputedStyle(panels).overflowY === 'auto'), '設定區塊太高時在自己的區塊裡捲動');
    // 聲音區塊內最後一個欄位(語氣指令)在設定區塊的可見範圍或捲動範圍內,不會被裁掉
    const styleInput = [...document.querySelectorAll('.voice-edit input')].pop();
    ok(!!styleInput && styleInput.getBoundingClientRect().height > 10, '語氣指令欄位完整顯示');
    document.title = 'SHOT:voice-editor-zh';
    await wait(900);

    // 切成英文播報:聲音區塊改成英文的一組
    await window.nexus.speechSet({ lang: 'en' });
    await until('聲音區塊切成英文', async () => voiceText().includes('聲音(英文播報)'), 8000);
    ok(voiceText().includes('有參考錄音(4.0 秒)') && voiceText().includes('voice.en.wav'), '英文播報時編輯英文的聲音', voiceText());
    ok((document.querySelector('.voice-edit textarea')?.value ?? '') === 'English transcript', '英文的逐字稿', document.querySelector('.voice-edit textarea')?.value);
    const auto = [...document.querySelectorAll('.voice-edit button')].find(b => b.textContent === '自動辨識內容');
    ok(!!auto && auto.disabled, '英文時自動辨識停用(語音辨識只聽中文)');
    { const pn = document.querySelector('.dlg-panels'); if (pn) pn.scrollTop = pn.scrollHeight; }
    await wait(300);
    document.title = 'SHOT:voice-editor-en';
    await wait(900);
    // 念法表:存讀,並在「語音」面板顯示
    const pz = await window.nexus.speechSet({ pronounce: [{ name: '聲音測試', zh: '聲音測驗', en: 'Voice Test' }, { name: '', zh: 'x', en: 'y' }] });
    ok(pz.settings.pronounce.length === 1 && pz.settings.pronounce[0].en === 'Voice Test', '念法表存讀(空名稱丟掉)', JSON.stringify(pz.settings.pronounce));
    // 「語音」面板的角色清單:中文、英文兩組都列出來,目前的播報語言(英文)排前面並標示
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '語音')?.click();
    const pronRow = await until('念法表', async () => document.querySelector('.pron-row'), 8000).catch(() => null);
    ok(!!pronRow && [...pronRow.querySelectorAll('input')].map(i => i.value).join('|') === '聲音測試|聲音測驗|Voice Test', '語音面板顯示念法表', pronRow && [...pronRow.querySelectorAll('input')].map(i => i.value).join('|'));
    pronRow?.scrollIntoView();
    await wait(300);
    document.title = 'SHOT:voice-pronounce';
    await wait(900);
    const row = await until('語音面板的角色清單', async () => [...document.querySelectorAll('.voice-char')].find(r => r.textContent.includes(C) && r.querySelector('.voice-set')), 8000).catch(() => null);
    const sets = row ? [...row.querySelectorAll('.voice-set em')].map(e => e.textContent) : [];
    ok(sets.length === 2 && sets[0].startsWith('英文(播報中):有聲音') && sets[1].startsWith('中文:有聲音'), '語音面板列出中英兩組,播報中的語言在前', JSON.stringify(sets));
    { const vp = document.querySelector('.remote.voice'); const list = vp?.querySelector('.voice-chars'); if (list) list.scrollIntoView(); }
    await wait(300);
    document.title = 'SHOT:voice-panel-en';
    await wait(900);
    // 移除英文的聲音不影響中文
    await window.nexus.voiceProfileSave(C, { wav: null }, 'en');
    ok(!(await window.nexus.voiceProfile(C, 'en')).hasVoice && (await window.nexus.voiceProfile(C)).hasVoice, '移除英文聲音不影響中文');
    await window.nexus.speechSet({ lang: 'zh' });
    log(bad ? `有 ${bad} 項不符` : '全部通過');
  } catch (err) {
    log('失敗', err.stack ?? err.message);
  }
  await wait(300);
  document.title = 'QUIT';
})();
