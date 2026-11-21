// 瀏覽器版完整介面的驗收(瀏覽器這一側):另開一個沒有 preload 的 Electron 視窗當成另一台電腦的瀏覽器,
// 連到主控台的遠端服務,配對後檢查載入的是和桌面相同的介面,並逐項試過瀏覽器版改寫的功能。
// 由 tests/web-full.sh 啟動。參數:連接埠 配對碼 節點id 節點數 截圖資料夾 暫存資料夾
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const [port, code, agentId, agentCount, shots, tmp] = process.argv.slice(-6);
app.setPath('userData', join(tmp, 'browser-profile'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
const base = `http://127.0.0.1:${port}`;
let bad = 0;
const log = (...a) => console.log('[browser]', ...a);
const check = (what, ok, extra = '') => { if (!ok) bad++; log(ok ? '通過' : '不符', what, extra); };

app.whenReady().then(async () => {
  const w = new BrowserWindow({ width: 1440, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
  const js = src => w.webContents.executeJavaScript(src, true);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => writeFileSync(join(shots, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  const errors = [];
  w.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message.slice(0, 200)); });
  try {
    // 首頁依瀏覽器種類決定給哪一種頁面
    const page = async (path, ua) => (await fetch(base + path, { headers: { 'User-Agent': ua } })).text();
    const PC = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36';
    const PHONE = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36';
    check('電腦的瀏覽器拿到完整介面', (await page('/', PC)).includes('/web-shim.js'));
    check('手機的瀏覽器拿到手機版', (await page('/', PHONE)).includes('pairbtn'));
    check('/m 指定手機版', (await page('/m', PC)).includes('pairbtn'));
    check('/full 指定完整介面', (await page('/full', PHONE)).includes('/web-shim.js'));
    // 沒配對時一律拒絕
    const rpc = (headers, body) => fetch(`${base}/api/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    check('未配對不能呼叫', (await rpc({}, { method: 'snapshot', args: [] })).status === 401);
    check('未配對不能列資料夾', (await fetch(`${base}/api/dirs`)).status === 401);
    check('靜態檔案不能跳出 assets', (await fetch(`${base}/assets/..%2Findex.html`)).status === 404);

    await w.loadURL(`${base}/?pair=${code}`);
    await wait(800);
    await shot('web-0-gate');
    await js(`document.querySelector('form button').click()`);
    await wait(5000);
    const token = await js(`localStorage.getItem('nexus.token')`);
    check('配對', Boolean(token));
    check('只帶 cookie 不能呼叫', (await rpc({ Cookie: `nexus_token=${token}` }, { method: 'snapshot', args: [] })).status === 401);
    check('不存在的方法', (await rpc({ Authorization: `Bearer ${token}` }, { method: 'constructor', args: [] })).status === 404);

    const ui = await js(`({ topbar: !!document.querySelector('.topbar'), canvas: !!document.querySelector('canvas'), web: typeof window.nexus.uploadFile, title: document.title, text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 160) })`);
    check('載入桌面介面', ui.topbar && ui.canvas && ui.web === 'function', JSON.stringify(ui));
    const snap = await js(`window.nexus.getSnapshot().then(s => ({ agents: s.agents.length, caps: s.capabilities.length, observed: Array.isArray(s.observed) }))`);
    check('節點數與桌面相同', snap.agents === Number(agentCount) && snap.observed, JSON.stringify(snap));
    await wait(1500);
    await shot('web-1-board');

    // 打開節點的對話視窗,經介面送出指令,確認串流把更新帶回來
    await js(`window.__seen = []; window.nexus.onUpdate(u => { if (u.event) window.__seen.push(u.event.type); }); 0`);
    await js(`window.nexus.send(${JSON.stringify(agentId)}, '從瀏覽器送出的指令')`);
    await wait(3500);
    const seen = await js(`window.__seen`);
    check('串流收到更新', seen.includes('message'), JSON.stringify([...new Set(seen)]));
    const hist = await js(`window.nexus.getHistory(${JSON.stringify(agentId)}).then(h => h.filter(e => e.type === 'message').map(e => e.role + ':' + e.text.slice(0, 20)))`);
    check('指令進到節點', hist.some(x => x.startsWith('user:從瀏覽器送出的指令')), JSON.stringify(hist.slice(-3)));

    // 附件:上傳(取代選檔與拖放)、縮圖、貼上的圖片
    const up = await js(`(async () => {
      const c = document.createElement('canvas'); c.width = 32; c.height = 32; c.getContext('2d').fillRect(4, 4, 20, 20);
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      const p1 = await window.nexus.uploadFile(new File([blob], '測試 圖片.png', { type: 'image/png' }));
      const preview = await window.nexus.attachmentPreview(p1);
      const p2 = await window.nexus.savePastedImage('image/png', await blob.arrayBuffer());
      const p3 = await window.nexus.uploadFile(new File(['hello'], '..\\\\..\\\\evil.tx t', { type: 'text/plain' }));
      return { p1, preview: String(preview).slice(0, 22), p2, p3, path: window.nexus.pathForFile(new File(['x'], 'x.txt')) };
    })()`);
    const inUploads = p => /[\\/]uploads[\\/][^\\/]+$/.test(p);
    check('上傳檔案', inUploads(up.p1) && up.p1.endsWith('.png') && up.preview.startsWith('data:image/png'), JSON.stringify(up));
    check('貼上的圖片', inUploads(up.p2) && up.p2.endsWith('.png'));
    check('檔名不能跳出暫存資料夾', inUploads(up.p3), up.p3);

    // 圖片:讀檔限制和桌面相同(只帶 cookie 也能讀,因為 <img> 不能帶標頭)
    const img = async (id, p, headers) => (await fetch(`${base}/api/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(p)}`, { headers })).status;
    check('工作目錄外的圖片讀不到', (await img(agentId, 'C:\\Windows\\Web\\Screen\\img100.png', { Cookie: `nexus_token=${token}` })) === 404);
    check('只帶 cookie 可以讀工作目錄裡的圖片', (await img(agentId, up.p1, { Cookie: `nexus_token=${token}` })) === 200);
    check('讀圖沒有通行碼', (await img(agentId, 'x.png', {})) === 401);
    check('立繪找不到', (await fetch(`${base}/api/portrait?c=nobody&mood=neutral`, { headers: { Cookie: `nexus_token=${token}` } })).status === 404);

    // 選資料夾:頁面內的資料夾清單
    await js(`window.__dir = 'pending'; window.nexus.pickDirectory().then(d => { window.__dir = d; }); 0`);
    await wait(1200);
    const drives = await js(`[...document.querySelectorAll('body > div:last-child div[title]')].map(e => e.title)`);
    check('列出磁碟機', drives.length > 0, JSON.stringify(drives));
    await js(`document.querySelector('body > div:last-child div[title]').click()`);
    await wait(1200);
    await shot('web-3-folders');
    await js(`[...document.querySelectorAll('body > div:last-child button')].find(b => b.textContent === '選這個資料夾').click()`);
    await wait(300);
    check('選到資料夾', (await js(`window.__dir`)) === drives[0], String(await js(`window.__dir`)));

    // 打開對話視窗截圖
    await js(`window.nexus.getSnapshot().then(s => window.__nexusSelect(s.agents.find(a => !a.parentId).id)); 0`);
    await wait(1500);
    const dlg = await js(`({ open: !!document.querySelector('.dlg-portrait'), input: !!document.querySelector('textarea') })`);
    check('對話視窗打開', dlg.open && dlg.input, JSON.stringify(dlg));
    await shot('web-2-dialog'); await wait(600); await shot('web-2-dialog-b');

    check('畫面沒有錯誤訊息', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
    log(bad ? `有 ${bad} 項不符` : '瀏覽器端全部通過');
    await js(`window.nexus.send(${JSON.stringify(agentId)}, '瀏覽器檢查完成(${bad ? '有不符' : '全部通過'})')`);
    await wait(500);
  } catch (err) {
    log('失敗', err.message);
    log('錯誤訊息', JSON.stringify(errors.slice(0, 5)));
  }
  app.quit();
});
