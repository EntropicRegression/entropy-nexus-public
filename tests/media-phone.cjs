// 缺口 8b 的手機端檢查:另開一個 Electron 視窗當成手機,配對後檢查 /api/file 的正反兩面,並截圖對話裡的圖片。
// 由 tests/media.sh 在主控台印出 PAIR 之後啟動。參數:連接埠 配對碼 節點id 媒體圖片路徑(已編碼) 工作目錄 外部資料夾 截圖資料夾 暫存資料夾
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [port, code, agentId, mediaPath, cwd, outside, shots, tmp] = process.argv.slice(-8);
app.setPath('userData', join(tmp, 'phone-profile'));
const log = (...a) => console.log('[phone]', ...a);
const base = `http://127.0.0.1:${port}`;

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 400, height: 820, show: false, webPreferences: { backgroundThrottling: false } });
  const js = src => w.webContents.executeJavaScript(src, true);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try {
    // 沒配對就讀圖要被拒絕
    log('未配對讀圖', await (await fetch(`${base}/api/file?id=${agentId}&path=pics%2Fsample.png`)).status);
    await w.loadURL(`${base}/m?pair=${code}`);
    await js(`document.getElementById('pairbtn').click()`);
    await wait(1500);
    const token = await js(`localStorage.getItem('nexus.token')`);
    log('配對', token ? '成功' : '失敗');
    const get = async (id, p) => { const r = await fetch(`${base}/api/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`, { headers: { Authorization: `Bearer ${token}` } }); return `${r.status} ${r.headers.get('content-type') ?? ''}`; };
    const cases = [
      ['允許', '相對路徑', agentId, 'pics/sample.png'],
      ['允許', '絕對路徑', agentId, `${cwd}\\pics\\sample.png`],
      ['允許', '媒體資料夾', agentId, decodeURIComponent(mediaPath)],
      ['拒絕', '工作目錄外', agentId, `${outside}\\secret.png`],
      ['拒絕', '.. 跳脫', agentId, '../outside/secret.png'],
      ['拒絕', 'junction 跳脫', agentId, 'jlink/secret.png'],
      ['拒絕', '符號連結跳脫', agentId, 'link.png'],
      ['拒絕', 'UNC', agentId, '\\\\127.0.0.1\\c$\\x.png'],
      ['拒絕', '非圖片', agentId, 'notes.txt'],
      ['拒絕', '不存在的節點', 'nope', 'pics/sample.png'],
      ['拒絕', '不存在的節點讀媒體資料夾', 'nope', decodeURIComponent(mediaPath)],
    ];
    let bad = 0;
    for (const [want, label, id, p] of cases) {
      const r = await get(id, p);
      const ok = want === '允許' ? r.startsWith('200 image/') : r.startsWith('404');
      if (!ok) bad++;
      log(`${ok ? '通過' : '不符'}:${want} ${label} → ${r}`);
    }
    // 打開節點,確認對話裡的圖片顯示出來
    await js(`document.querySelector('.card[data-id="${agentId}"]').click()`);
    await wait(2500);
    const info = await js(`(() => { const l = document.getElementById('log'); const imgs = [...l.querySelectorAll('.rimg img')]; return { shown: imgs.filter(i => i.naturalWidth > 0).length, fails: [...l.querySelectorAll('.rimg.fail')].map(e => e.textContent), links: [...l.querySelectorAll('a.rlink')].length }; })()`);
    log('手機對話的圖片', JSON.stringify({ ...info, fails: info.fails.map(f => f.replace(cwd, '<cwd>').replace(outside, '<外部>')) }));
    if (info.shown < 4 || info.fails.length !== 1 || info.links !== 1) bad++;
    const pos = await js(`(() => { const l = document.getElementById('log'); const first = l.querySelector('.rimg img'); if (!first) return 'no img'; l.scrollTop += first.getBoundingClientRect().top - l.getBoundingClientRect().top - 60; return l.scrollTop + '/' + l.scrollHeight; })()`);
    await wait(500);
    log('捲動位置', pos, '→', await js(`document.getElementById('log').scrollTop`));
    // 隱藏視窗只捲動時不會產生新畫面,所以先開放大檢視截圖、關掉後再截對話(開關放大會讓畫面重畫)
    await js(`document.querySelector('#log .rimg img').click()`);
    await wait(400);
    writeFileSync(join(shots, 'phone-2-lightbox.png'), (await w.webContents.capturePage()).toPNG());
    await js(`document.getElementById('lightbox').click()`);
    await wait(600);
    writeFileSync(join(shots, 'phone-1-images.png'), (await w.webContents.capturePage()).toPNG());
    log(bad ? `有 ${bad} 項不符` : '手機端全部通過');
    // 通知主控台的測試腳本可以結束了
    await fetch(`${base}/api/send`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: agentId, text: `手機檢查完成(${bad ? '有不符' : '全部通過'})` }) });
  } catch (err) {
    log('失敗', err.message);
  }
  app.quit();
});
