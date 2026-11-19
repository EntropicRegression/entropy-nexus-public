// 手機遠端附件的外部驗收(由 tests/attachments.sh 呼叫):配對、上傳 PDF 與圖片、檔名不能跳出暫存資料夾、
// 送出時夾帶資料夾外的路徑會被濾掉,最後送「收工」讓主控台裡的腳本結束。
// 用法:node tests/attachments-remote.mjs <連接埠> <配對碼> <附件資料夾> <資料目錄>
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import vm from 'node:vm';

const [port, code, dir, dataDir] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const log = (...a) => console.log('[remote]', ...a);
const wait = ms => new Promise(r => setTimeout(r, ms));
let token = '';
const call = async (path, opts = {}) => {
  const r = await fetch(base + path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const post = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const upload = (file, type, name) => call('/api/upload', { method: 'POST', headers: { 'Content-Type': type, ...(name !== undefined ? { 'X-File-Name': encodeURIComponent(name) } : {}) }, body: readFileSync(file) });

let ok = true;
const check = (what, cond, extra = '') => { if (!cond) ok = false; log(cond ? '通過' : '失敗', what, extra); };

// 頁面本身:說明文字與腳本語法
const page = await (await fetch(base + '/m')).text();
check('頁面說明 PDF 上限', page.includes('PDF(20 MB 內)'));
check('檔案欄位收 PDF', page.includes('application/pdf'));
const script = /<script>([\s\S]*)<\/script>/.exec(page)?.[1] ?? '';
try { new vm.Script(script); check('頁面腳本語法', true); } catch (e) { check('頁面腳本語法', false, e.message); }

const paired = await fetch(base + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name: '附件測試' }) }).then(r => r.json());
token = paired.token;
check('配對', Boolean(token));

const uploads = join(dataDir, 'uploads');
const txt = await upload(join(dir, 'notes.txt'), 'text/plain', 'notes.txt');
check('拒絕文字檔', txt.status === 400, JSON.stringify(txt.body));
const p1 = await upload(join(dir, 'sample.pdf'), 'application/pdf', '..\\..\\evil ../name.pdf');
check('上傳 PDF', p1.status === 200, JSON.stringify(p1.body));
check('PDF 檔名留在暫存資料夾內', dirname(p1.body.path).toLowerCase() === uploads.toLowerCase(), basename(p1.body.path));
const p2 = await upload(join(dir, 'sample.png'), 'image/png', '照片 1.png');
check('上傳圖片', p2.status === 200, basename(p2.body?.path ?? ''));
const p3 = await upload(join(dir, 'sample.png'), 'image/png');
check('沒有檔名也能上傳', p3.status === 200, basename(p3.body?.path ?? ''));
const big = await call('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.alloc(21 * 1024 * 1024) }).catch(e => ({ status: 'conn', body: String(e.cause?.code ?? e.message) }));
check('PDF 超過 20 MB 被擋', big.status === 413 || big.status === 'conn', JSON.stringify(big));

const meta = await call('/api/meta');
check('meta 帶有附件能力', meta.body.capabilities.every(c => Array.isArray(c.attachments)), JSON.stringify(meta.body.capabilities.map(c => [c.backend, c.attachments])));

const state = await call('/api/state');
const vega = state.body.agents.find(a => a.name === 'Vega');
const orion = state.body.agents.find(a => a.name === 'Orion');
// 夾帶兩個資料夾外的路徑:用 .. 跳出去的,以及電腦上的任意檔案
const sneaky = [join(uploads, '..', 'nexus.db'), `${uploads}\\..\\nexus.db`, join(dir, 'notes.txt')];
const text = `看附件\n\n附加的檔案:\n- ${p1.body.path}\n- ${p2.body.path}`;
await post('/api/send', { id: vega.id, text, images: [p1.body.path, p2.body.path, ...sneaky] });
let notes = [];
for (let i = 0; i < 40 && !notes.length; i++) {
  await wait(250);
  notes = (await call('/api/history?id=' + encodeURIComponent(vega.id))).body.filter(e => e.type === 'note').map(e => e.text);
}
log('Vega 的 note', JSON.stringify(notes));
check('PDF 與圖片都交給轉接器', notes.some(n => n.includes('已內嵌 2 個附件') && n.includes('.pdf') && n.includes('.png')));
check('資料夾外的路徑被濾掉', !notes.some(n => n.includes('nexus.db') || n.includes('notes.txt')));

await post('/api/send', { id: orion.id, text: '收工', images: [] });
log(ok ? '全部通過' : '有項目失敗');
