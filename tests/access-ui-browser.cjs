// 權限的畫面驗收(瀏覽器這一側):以唯讀、只看一個節點的裝置連進完整介面與手機版頁面,
// 檢查看不到其他節點、不能用的按鈕都隱藏,並試著送指令確認被伺服器拒絕。由 tests/access-ui.sh 啟動。
// 參數:連接埠 配對碼 節點id 截圖資料夾 暫存資料夾
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [port, code, agentId, shots, tmp] = process.argv.slice(-5);
app.setPath('userData', join(tmp, 'browser-profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const base = `http://127.0.0.1:${port}`;
let bad = 0;
const log = (...a) => console.log('[browser]', ...a);
const check = (what, ok, extra = '') => { if (!ok) bad++; log(ok ? '通過' : '不符', what, ok ? '' : extra); };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const js = src => w.webContents.executeJavaScript(src, true);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => { writeFileSync(join(shots, `${name}.png`), (await w.webContents.capturePage()).toPNG()); await wait(500); writeFileSync(join(shots, `${name}-b.png`), (await w.webContents.capturePage()).toPNG()); };
  // 畫面上看得到的(沒有被 display:none 隱藏的)按鈕文字
  const visibleButtons = sel => js(`[...document.querySelectorAll(${JSON.stringify(sel)})].filter(b => b.offsetParent !== null).map(b => b.textContent.trim())`);
  try {
    await w.loadURL(`${base}/full?pair=${code}`);
    await wait(800);
    await js(`document.querySelector('form button').click()`);
    await wait(5000);
    const info = await js(`({ role: window.nexus.access?.role, agents: window.nexus.access?.agents, cls: document.body.className, rows: [...document.querySelectorAll('.roster-list .row')].map(r => r.querySelector('.row-name').textContent) })`);
    check('完整介面知道自己是唯讀', info.role === 'viewer' && info.agents?.[0] === agentId && info.cls.includes('role-viewer'), JSON.stringify(info));
    check('節點清單只有一個節點', info.rows.length === 1, JSON.stringify(info.rows));
    const top = await visibleButtons('.topbar button, .topbar label, .roster button.add');
    check('頂部沒有設定類的按鈕', !top.some(t => /手機|外部觀察|同時上限|額度上限|新增節點|開啟舊/.test(t)), JSON.stringify(top));
    await js(`document.querySelector('.roster-list .row').click(); 0`);
    await wait(1500);
    const dlg = await visibleButtons('.dialog button, .dlg button, [class^="dlg"] button');
    check('對話視窗沒有操作按鈕', !dlg.some(t => /設定|分支|終端機|休眠|喚醒|終止|送出|排隊|中斷|附加|允許|拒絕/.test(t)), JSON.stringify(dlg));
    check('輸入框隱藏', await js(`!document.querySelector('.dlg-input') || document.querySelector('.dlg-input').offsetParent === null`));
    check('畫面外直接呼叫也被拒', await js(`window.nexus.send(${JSON.stringify(agentId)}, '唯讀不該送得出去').then(() => false, e => /唯讀/.test(e.message))`));
    check('新增節點被拒', await js(`window.nexus.createAgent({ name: 'x', character: '', model: '', backend: 'claude', cwd: 'C:\\\\', permissionMode: 'auto' }).then(() => false, () => true)`));
    await shot('viewer-full');

    // 手機版頁面(同一個通行碼)
    await w.setSize(420, 860);
    await w.loadURL(`${base}/m`);
    await wait(2500);
    const m = await js(`({ cls: document.body.className, cards: document.querySelectorAll('.card').length, add: document.getElementById('addbtn')?.offsetParent != null })`);
    check('手機版:只有一個節點、沒有新增節點', m.cls === 'role-viewer' && m.cards === 1 && m.add === false, JSON.stringify(m));
    await js(`document.querySelector('.card').click()`);
    await wait(2000);
    check('手機版:沒有輸入框', await js(`!document.getElementById('cmd') || document.getElementById('cmd').offsetParent === null`));
    await shot('viewer-mobile');
    log(bad ? `有 ${bad} 項不符` : '瀏覽器端全部通過');
  } catch (err) {
    log('失敗', err.message);
  }
  app.quit();
});
