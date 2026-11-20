// 瀏覽器版的版面檢查(瀏覽器這一側):另開一個沒有 preload 的 Electron 視窗當成另一台電腦的瀏覽器,
// 配對後在幾種視窗大小下跑和桌面版相同的情境(tests/layout-audit-lib.js),再檢查手機版頁面。
// 由 tests/layout.sh(LAYOUT_WEB=1)啟動。參數:連接埠 配對碼 節點id 截圖資料夾 暫存資料夾 共用檢查函式的路徑
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [port, code, agentId, shots, tmp, libPath] = process.argv.slice(-6);
app.setPath('userData', join(tmp, 'browser-profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const base = `http://127.0.0.1:${port}`;
const lib = readFileSync(libPath, 'utf8');
let total = 0;
const log = (...a) => console.log('[browser]', ...a);
const report = (size, title, issues) => {
  total += issues.length;
  log(issues.length ? '不符' : '通過', `[${size}] ${title}`, issues.length ? `${issues.length} 項` : '');
  for (const i of issues.slice(0, 12)) log('   -', i);
  if (issues.length > 12) log(`   …另外 ${issues.length - 12} 項`);
};

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1440, height: 900, show: false, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const js = src => w.webContents.executeJavaScript(src, true);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => writeFileSync(join(shots, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  try {
    await w.loadURL(`${base}/full?pair=${code}`);
    await wait(800);
    await js(`document.querySelector('form button').click()`);
    await wait(5000);
    if (!(await js(`!!localStorage.getItem('nexus.token')`))) throw new Error('配對失敗');
    await w.loadURL(`${base}/full`);
    await wait(4000);
    await js(lib + '\n0');

    // 完整介面(電腦的瀏覽器)
    for (const [cw, ch, label] of [[1440, 900, '大螢幕'], [1280, 650, '1080p-150%'], [1090, 540, '768p-125%'], [900, 600, '窄視窗'], [760, 560, '最窄視窗']]) {
      w.setContentSize(cw, ch);
      await wait(1800);
      const size = `瀏覽器 ${label} ${cw}×${ch}`;
      log(`=== ${size}`);
      await js('window.__layoutClose()');
      const scenes = await js('window.__LAYOUT_SCENES');
      for (const [key, title] of scenes) {
        report(size, title, await js(`window.__layoutScene(${JSON.stringify(key)})`));
        await shot(`web-${label}-${key}`);
        await js('window.__layoutClose()');
      }
    }

    // 手機版
    w.webContents.setUserAgent('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36');
    for (const [cw, ch, label] of [[390, 844, '手機'], [360, 640, '小手機'], [844, 390, '手機橫放']]) {
      w.setContentSize(cw, ch);
      await w.loadURL(`${base}/m`);
      await wait(3500);
      await js(lib + '\n0');
      const size = `手機版 ${label} ${cw}×${ch}`;
      log(`=== ${size}`);
      report(size, '節點列表', await js('window.__layoutAudit()'));
      await shot(`m-${label}-1-list`);
      // 點第一個節點打開對話
      const opened = await js(`(() => { const el = [...document.querySelectorAll('button, [role=button], .agent, li')].find(e => e.textContent.includes('節點01')); if (el) el.click(); return !!el; })()`);
      await wait(1500);
      report(size, opened ? '節點對話' : '節點對話(找不到節點01)', await js('window.__layoutAudit()'));
      await shot(`m-${label}-2-chat`);
    }
  } catch (err) {
    total++;
    log('失敗', err.stack ?? err.message);
  }
  log(total ? `有 ${total} 項不符` : '全部通過');
  // 告訴主控台檢查完成
  try {
    const token = await js(`localStorage.getItem('nexus.token')`);
    await fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ method: 'send', args: [agentId, '瀏覽器檢查完成'] }) });
  } catch { /* 主控台會逾時結束 */ }
  app.quit();
});
