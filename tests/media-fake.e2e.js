// 缺口 8b:多模態輸出(對話裡的圖片、受限的讀檔協定、朗讀回覆)。用假資料轉接器執行,不消耗額度。
// 由 tests/media.sh 啟動:__TEST_CWD__ 是暫存的工作目錄,__TEST_IMAGE__ 是工作目錄旁邊的「外部」資料夾。
(async () => {
  const log = (...a) => console.log('[test]', ...a);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { document.title = `SHOT:${name}`; await wait(900); };
  let inputs = 0;
  const input = async a => { document.title = `INPUT:${++inputs}|${JSON.stringify(a)}`; await wait(300); };
  const until = async (what, fn, timeout = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = await fn(); if (v) return v; await wait(200); }
    throw new Error(`等不到:${what}`);
  };
  const cwd = window.__TEST_CWD__, outside = window.__TEST_IMAGE__;
  const sep = '\\';
  const url = (id, p) => `nexus-file://img/${encodeURIComponent(id)}?path=${encodeURIComponent(p)}`;
  const probe = async (id, p) => { try { const r = await fetch(url(id, p)); return `${r.status} ${r.headers.get('content-type') ?? ''}`.trim(); } catch (e) { return `fetch 失敗 ${e.message}`; } };
  let failures = 0;
  const expect = (label, ok, detail) => { if (!ok) failures++; log(`${ok ? '通過' : '不符'}:${label}${detail ? ` → ${detail}` : ''}`); };
  try {
    await window.nexus.setAutopilot(false);
    const a = await window.nexus.createAgent({ name: 'Pixel', character: '', model: '', backend: 'claude', cwd, permissionMode: 'ask' });
    await until('節點待命', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle'));

    // ---------- 協定的正反兩面存取
    const lower = cwd[0].toLowerCase() + cwd.slice(1);
    const allow = [
      ['相對路徑', 'pics/sample.png'],
      ['相對路徑(反斜線)', 'pics\\sample.png'],
      ['絕對路徑', `${cwd}${sep}pics${sep}sample.png`],
      ['磁碟代號小寫', `${lower}${sep}pics${sep}sample.png`],
      ['整段大寫', `${cwd}${sep}pics${sep}sample.png`.toUpperCase()],
      ['file:// 網址', `file:///${cwd.replace(/\\/g, '/')}/pics/sample.png`],
      ['工作目錄內的 .. 但沒有跳出', 'pics/../pics/two.png'],
    ];
    const deny = [
      ['工作目錄外的絕對路徑', `${outside}${sep}secret.png`],
      ['.. 跳脫', '../outside/secret.png'],
      ['多層 .. 跳脫', 'pics/../../outside/secret.png'],
      ['junction 跳脫', 'jlink/secret.png'],
      ['符號連結跳脫', 'link.png'],
      ['UNC 路徑', '\\\\127.0.0.1\\c$\\x.png'],
      ['正斜線 UNC', '//127.0.0.1/c$/x.png'],
      ['裝置路徑', `\\\\?\\${cwd}${sep}pics${sep}sample.png`],
      ['系統資料夾的圖片', 'C:\\Windows\\Web\\Wallpaper\\Windows\\img0.jpg'],
      ['非圖片副檔名', 'notes.txt'],
      ['SVG(不支援)', 'pics/logo.svg'],
      ['不存在的檔案', 'pics/missing.png'],
      ['空字串', ''],
    ];
    for (const [label, p] of allow) { const r = await probe(a.id, p); expect(`允許 ${label}`, r.startsWith('200 image/png'), r); }
    for (const [label, p] of deny) { const r = await probe(a.id, p); expect(`拒絕 ${label}`, r.startsWith('404'), r); }
    { const r = await probe('no-such-agent', 'pics/sample.png'); expect('拒絕 不存在的節點', r.startsWith('404'), r); }
    { const r = await fetch(url(a.id, 'pics/sample.png')); expect('回應標頭', r.headers.get('x-content-type-options') === 'nosniff' && /default-src 'none'/.test(r.headers.get('content-security-policy') ?? ''), `${r.headers.get('x-content-type-options')} | ${r.headers.get('content-security-policy')}`); }

    // ---------- 回覆裡的圖片與工具結果圖片事件
    [...document.querySelectorAll('.row')].find(r => r.textContent.includes('Pixel')).click();
    await wait(500);
    const reply = [
      'Markdown 圖片語法:![範例圖](pics/sample.png)',
      '',
      '裸路徑(單獨一行):',
      `${cwd}${sep}pics${sep}sample.png`,
      '',
      '行內程式碼:`pics/two.png` 也會附上預覽。',
      '',
      '工作目錄外(應被拒絕):',
      `${outside}${sep}secret.png`,
      '',
      '.. 跳脫(應被拒絕):![跳脫](../outside/secret.png)',
      '',
      'junction 跳脫(應被拒絕):',
      'jlink/secret.png',
      '',
      '符號連結跳脫(應被拒絕):',
      'link.png',
      '',
      '遠端圖片(預設不載入):![遠端](https://example.com/a.png)',
    ].join('\n');
    // 串流中途截圖一次,確認半截的語法不會出錯
    await window.nexus.send(a.id, `圖片測試\n${reply}`);
    await until('開始串流', () => document.querySelector('.msg.agent.live'), 10000);
    await wait(150);
    const liveErr = document.querySelector('.dlg-stream') ? '' : '對話區不見了';
    expect('串流中畫面正常', !liveErr, liveErr || `目前片段 ${document.querySelector('.msg.agent.live')?.textContent.length ?? 0} 字`);
    await until('回合結束', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle') && !document.querySelector('.msg.agent.live'), 20000);
    await until('圖片載入完成', () => [...document.querySelectorAll('.dlg-stream img.md-img')].every(i => i.complete) && document.querySelectorAll('.dlg-stream img.md-img').length >= 4, 10000).catch(() => null);
    await wait(500);
    const imgs = [...document.querySelectorAll('.dlg-stream img.md-img')];
    const loaded = imgs.filter(i => i.naturalWidth > 0).map(i => decodeURIComponent(new URL(i.src).searchParams.get('path') ?? i.src).replace(cwd, '<cwd>').replace(/^.*[\\/]media[\\/]/, '<媒體資料夾>/'));
    const fails = [...document.querySelectorAll('.dlg-stream .md-img-fail')].map(e => e.textContent.replace(cwd, '<cwd>').replace(outside, '<外部>'));
    const remote = [...document.querySelectorAll('.dlg-stream .md-img-remote')].map(e => e.textContent);
    log('顯示出來的圖片', loaded.length, JSON.stringify(loaded));
    log('退回文字的路徑', fails.length, JSON.stringify(fails));
    log('遠端圖片按鈕', JSON.stringify(remote));
    expect('顯示 4 張圖(Markdown、裸路徑、行內程式碼、工具結果)', loaded.length === 4);
    // 被拒絕的裸路徑本來就以文字出現在段落裡,預覽直接不顯示;![]() 語法讀不到時退回路徑文字
    expect('跳脫路徑都沒有顯示圖片', imgs.length === 4 && fails.length === 1 && fails[0] === '../outside/secret.png', `img 元素 ${imgs.length} 個`);
    expect('遠端圖片沒有自動載入', remote.length === 1 && !imgs.some(i => i.src.startsWith('http')));
    const h = await window.nexus.getHistory(a.id);
    const ev = h.find(e => e.type === 'image');
    expect('圖片事件只帶路徑', !!ev && !JSON.stringify(ev).includes('base64') && JSON.stringify(ev).length < 400, ev && JSON.stringify({ ...ev, path: ev.path.replace(/^.*[\\/]media[\\/]/, '<媒體資料夾>/') }));
    const toolEnd = h.find(e => e.type === 'tool' && e.phase === 'end' && e.name === 'Screenshot');
    expect('工具結果紀錄沒有 base64', !!toolEnd && !/iVBOR/.test(toolEnd.detail ?? ''), toolEnd?.detail);
    { const r = await probe(a.id, ev.path); expect('允許 媒體資料夾裡的圖片', r.startsWith('200 image/png'), r); }
    log('事件紀錄最後一行', document.querySelector('.log-line:last-child')?.textContent);
    document.querySelector('.dlg-stream img.md-img').scrollIntoView({ block: 'start' });
    await wait(300);
    await shot('1-images-top');
    imgs[imgs.length - 1].scrollIntoView({ block: 'center' });
    await wait(300);
    await shot('1b-images-middle');
    document.querySelector('.dlg-stream').scrollTop = 1e6;
    await wait(300);
    await shot('2-images-bottom');

    // 點遠端圖片按鈕才載入(example.com 沒有這張圖,載入失敗會退回文字)
    document.querySelector('.md-img-remote').click();
    await wait(200);
    expect('按下後才建立遠端圖片', [...document.querySelectorAll('.dlg-stream img.md-img')].some(i => i.src.startsWith('https://example.com')) || [...document.querySelectorAll('.md-img-fail')].some(e => e.textContent.startsWith('https://')));

    // 放大檢視:點圖片開啟,Esc 只關放大、不關對話視窗
    imgs.find(i => i.naturalWidth > 0).click();
    await wait(300);
    expect('點圖片放大', !!document.querySelector('.md-lightbox img'));
    await shot('3-lightbox');
    await input({ type: 'key', key: 'Escape' });
    await wait(300);
    expect('Esc 關掉放大但對話視窗還在', !document.querySelector('.md-lightbox') && !!document.querySelector('.dialog'));

    // ---------- 朗讀回覆
    const voices = speechSynthesis.getVoices().map(v => `${v.name}(${v.lang})`);
    log('可用語音', voices.length, voices.slice(0, 6).join('、'));
    const toggle = () => [...document.querySelectorAll('button.mute')].find(b => b.textContent.startsWith('朗讀'));
    expect('朗讀預設關閉', toggle()?.textContent === '朗讀 關');
    toggle().click();
    await wait(100);
    expect('朗讀設定記住', localStorage.getItem('nexus.speak') === '1' && toggle().textContent === '朗讀 開');
    await window.nexus.send(a.id, '給我一段程式碼');
    await until('程式碼回合結束', async () => (await window.nexus.getSnapshot()).agents.find(x => x.id === a.id && x.state === 'idle') && window.__nexusSpoken, 20000);
    const spoken = window.__nexusSpoken;
    log('送去朗讀的文字', JSON.stringify(spoken));
    expect('朗讀略過程式碼區塊', !!spoken && !spoken.text.includes('function hello') && spoken.text.includes('程式碼略過') && spoken.text.includes('粗體'));
    const stopBtn = await until('出現停止朗讀', () => [...document.querySelectorAll('button.mute')].find(b => b.textContent === '停止朗讀'), 5000).catch(() => null);
    expect('朗讀中顯示停止鈕', !!stopBtn, speechSynthesis.speaking ? '正在朗讀' : '沒有在朗讀');
    await shot('4-speaking');
    stopBtn?.click();
    await wait(400);
    expect('停止朗讀', !speechSynthesis.speaking && ![...document.querySelectorAll('button.mute')].some(b => b.textContent === '停止朗讀'));
    toggle().click();
    expect('關閉朗讀', localStorage.getItem('nexus.speak') === '0');

    // ---------- 手機:開啟遠端,交給 tests/media-phone.cjs 配對並檢查,它最後會送一句「手機檢查完成」
    await window.nexus.remoteSet({ enabled: true });
    await wait(800);
    const st = await window.nexus.remoteStatus();
    log(`PAIR ${st.pairCode} ${a.id} ${st.port} ${encodeURIComponent(ev.path)}`);
    await until('手機檢查完成', async () => (await window.nexus.getHistory(a.id)).some(e => e.type === 'message' && e.role === 'user' && e.text.startsWith('手機檢查完成')), 90000)
      .then(() => log('手機端已回報完成'))
      .catch(e => { failures++; log('不符:', e.message); });
    await window.nexus.remoteSet({ enabled: false });
    log(failures ? `有 ${failures} 項不符` : '全部步驟完成');
  } catch (err) {
    log('失敗', err.message);
    await shot('9-failed');
  }
  await wait(400);
  document.title = 'QUIT';
})();
