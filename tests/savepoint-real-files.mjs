// session 存點真實驗證(S4)的檔案操作,由 tests/savepoint-real.sh 呼叫。只動「這次建立的測試節點」自己的對話檔:
//   delete <測試資料夾> <節點ID> <備份資料夾>:依這個節點最新存點的說明檔,先把列出的原始檔備份,再刪掉(模擬工具清掉對話)
//   cleanup <測試資料夾> <後台> <sessionId> <備份資料夾>:驗證結束後,先備份再刪掉測試節點在工具資料夾裡的對話檔
// 每個檔案都再檢查一次:位置裡一定有這段對話的 id、在那家允許的資料夾底下;不符就整個停下,不刪任何東西。輸出不含本機路徑。
import { copyFileSync, mkdirSync, readdirSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(String.raw`export async function resolve(s,c,n){if(/^\.\.?\//.test(s)&&!/\.\w+$/.test(s)){try{return await n(s+'.ts',c)}catch{}}return n(s,c)}`), import.meta.url);
const sp = await import('../src/main/session-savepoint.ts');

const [mode, profile, a, b, c] = process.argv.slice(2);
const roots = sp.defaultSessionRoots();
const PREFIX = { claude: ['projects/'], codex: ['sessions/', 'archived_sessions/'], agy: ['conversations/', 'brain/'] };
const fail = msg => { console.log(`[files] 停下:${msg}`); process.exit(2); };

function backupAndDelete(files, sessionId, backup) {
  for (const f of files) {
    if (!f.rel.toLowerCase().includes(sessionId.toLowerCase()) || !PREFIX[f.root]?.some(p => f.rel.startsWith(p)) || f.rel.split('/').includes('..')) fail(`不允許的位置 ${f.root}:${f.rel}`);
  }
  for (const f of files) {
    const src = join(roots[f.root], ...f.rel.split('/'));
    const dst = join(backup, f.root, ...f.rel.split('/'));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  for (const f of files) {
    unlinkSync(join(roots[f.root], ...f.rel.split('/')));
    console.log(`[files] 已備份並刪除 ${f.root}:${f.rel.replace(/^projects\/[^/]+\//, 'projects/<測試專案>/')}`);
  }
}

/** 刪掉後留下的空資料夾(名稱裡有這段對話 id 的,以及 Claude 測試專案的資料夾若已經空了)。 */
function removeEmptyDirs(files, sessionId) {
  const dirs = new Set();
  for (const f of files) {
    const parts = f.rel.split('/');
    for (let i = parts.length - 1; i > 1; i--) dirs.add(`${f.root}:${parts.slice(0, i).join('/')}`);
    if (f.root === 'claude') dirs.add(`claude:${parts.slice(0, 2).join('/')}`);
  }
  for (const d of [...dirs].sort((x, y) => y.length - x.length)) {
    const [root, rel] = d.split(/:(.*)/s);
    const isOurs = rel.toLowerCase().includes(sessionId.toLowerCase()) || (root === 'claude' && /^projects\/[^/]+$/.test(rel));
    const abs = join(roots[root], ...rel.split('/'));
    // Claude 會在專案資料夾自動建一個空的 memory 子資料夾:是空的才一起移除
    if (isOurs && root === 'claude' && /^projects\/[^/]+$/.test(rel)) { try { rmdirSync(join(abs, 'memory')); } catch { /* 不存在或不是空的 */ } }
    try { if (isOurs && readdirSync(abs).length === 0) { rmdirSync(abs); console.log(`[files] 移除空資料夾 ${root}:${rel.replace(/^projects\/[^/]+/, 'projects/<測試專案>')}`); } } catch { /* 不存在或不是空的 */ }
  }
}

if (mode === 'delete') {
  const vault = join(profile, 'memory-vault');
  const [latest] = sp.listSavepoints(vault, a);
  const m = latest && sp.readSavepoint(vault, latest);
  if (!m) fail('找不到這個節點的存點');
  const files = m.檔案.map(f => ({ root: f.根目錄, rel: f.位置 }));
  backupAndDelete(files, m.sessionId, b);
  console.log(`[files] 主檔還在:${sp.sessionMainExists(m.後台ID, m.sessionId, roots)}`);
} else if (mode === 'cleanup') {
  const files = sp.locateSessionFiles(a, b, roots);
  if (!files.length) { console.log('[files] 沒有要清的對話檔'); process.exit(0); }
  backupAndDelete(files, b, c);
  removeEmptyDirs(files, b);
  // Antigravity 的 brain/<id>/ 底下還有它自己建的空資料夾:整棵都沒有檔案才移除
  if (a === 'antigravity') {
    const brain = join(roots.agy, 'brain', b);
    const walk = d => { let files = 0; for (const e of readdirSync(d, { withFileTypes: true })) { if (e.isSymbolicLink()) return Infinity; files += e.isDirectory() ? walk(join(d, e.name)) : 1; } return files; };
    try { if (walk(brain) === 0) { rmSync(brain, { recursive: true }); console.log('[files] 移除空的 brain/<測試對話> 資料夾'); } } catch { /* 不存在 */ }
  }
  console.log(`[files] 主檔還在:${sp.sessionMainExists(a, b, roots)}`);
} else fail('用法不對');
