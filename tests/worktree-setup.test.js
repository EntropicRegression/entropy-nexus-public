// 缺口 1:獨立工作區的環境初始化。直接呼叫 src/main/worktree.ts 的函式測檔案系統行為,不啟動 Electron、不碰正式資料。
// 用法:在 app 資料夾執行 node --experimental-strip-types tests/worktree-setup.test.js
// 會在系統暫存區建立兩個測試版本庫(有/沒有 .worktreeinclude),建立工作區、檢查複製與連結,再移除工作區並確認原版本庫的 node_modules 還在。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// worktree.ts 只用到可直接拿掉的型別語法,用 Node 的 --experimental-strip-types 直接載入
const wt = require('../src/main/worktree.ts');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-wtsetup-'));
wt.initWorktrees(path.join(base, 'data'));

let failures = 0;
const check = (what, ok, extra = '') => { console.log(`[test] ${ok ? '通過' : '失敗'} ${what}${extra ? ` | ${extra}` : ''}`); if (!ok) failures++; };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

function makeRepo(name, files, ignore) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'tester'); git(root, 'config', 'user.email', 'tester@example.com');
  write(root, '.gitignore', ignore);
  write(root, 'README.md', 'hi\n');
  write(root, 'app/index.js', 'console.log(1)\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  return root;
}

(async () => {
  // 情境 A:沒有 .worktreeinclude,預設複製 .env 類檔案
  const a = makeRepo('repo-a', {
    '.env': 'A=1\n', '.env.local': 'B=2\n', 'app/.env.development': 'C=3\n', 'notes.txt': '未追蹤但不是環境檔\n',
    'node_modules/pkg/index.js': 'module.exports = 1\n', 'app/node_modules/dep/keep.txt': 'keep\n',
    'node_modules/pkg/.env': '不該被複製(在 node_modules 裡)\n', 'dist/.env': '不該被複製(大資料夾)\n',
  }, 'node_modules/\n.env*\ndist/\n');
  const ma = await wt.createWorktree(a, 'EnvA', 'aaaaaa111111');
  const p = ma.info.path;
  console.log('[test] 摘要 A:', ma.setup);
  check('A 複製 .env', fs.readFileSync(path.join(p, '.env'), 'utf8') === 'A=1\n');
  check('A 複製 .env.local', fs.existsSync(path.join(p, '.env.local')));
  check('A 複製子資料夾的 app/.env.development', fs.existsSync(path.join(p, 'app/.env.development')));
  check('A 不複製 notes.txt', !fs.existsSync(path.join(p, 'notes.txt')));
  check('A 不複製 dist/.env', !fs.existsSync(path.join(p, 'dist/.env')));
  check('A 根目錄 node_modules 是連結', isLink(path.join(p, 'node_modules')) && fs.existsSync(path.join(p, 'node_modules/pkg/index.js')));
  check('A app/node_modules 是連結', isLink(path.join(p, 'app/node_modules')) && fs.existsSync(path.join(p, 'app/node_modules/dep/keep.txt')));
  const st = await wt.worktreeStatus(ma.info);
  check('A 工作區不因連結與複製檔被當成有修改', st.exists && !st.dirty, `git status:${JSON.stringify(git(p, 'status', '--porcelain'))}`);
  // 任務快照會用 git add -A 掃工作區;確認不會把連結或 node_modules 內容收進去
  const idx = path.join(base, 'snap-index');
  execFileSync('git', ['add', '-A', '--', '.'], { cwd: p, env: { ...process.env, GIT_INDEX_FILE: idx } });
  const listed = execFileSync('git', ['ls-files'], { cwd: p, env: { ...process.env, GIT_INDEX_FILE: idx }, encoding: 'utf8' }).trim().split('\n');
  check('A 快照只含已追蹤的檔案', listed.every(f => !f.includes('node_modules') && !f.includes('.env')), listed.join(','));
  const removed = await wt.removeWorktree(ma.info, false);
  check('A 移除工作區', removed && !fs.existsSync(p));
  check('A 移除後原版本庫 node_modules/pkg/index.js 仍在', fs.existsSync(path.join(a, 'node_modules/pkg/index.js')));
  check('A 移除後原版本庫 app/node_modules/dep/keep.txt 仍在', fs.existsSync(path.join(a, 'app/node_modules/dep/keep.txt')));

  // 情境 B:有 .worktreeinclude;node_modules 沒有被 .gitignore 忽略,連結要寫進 info/exclude
  const b = makeRepo('repo-b', {
    '.worktreeinclude': '# 註解\n.env\nconfig/*.json\n!config/skip.json\nsecrets/\n',
    '.env': 'X=1\n', '.env.local': '不在規則裡\n', 'config/a.json': '{}\n', 'config/skip.json': '{}\n', 'secrets/deep/key.pem': 'k\n',
    'node_modules/pkg/index.js': 'module.exports = 2\n',
  }, '.env*\nsecrets/\n');
  const mb = await wt.createWorktree(b, 'EnvB', 'bbbbbb222222');
  const q = mb.info.path;
  console.log('[test] 摘要 B:', mb.setup);
  check('B 依規則複製 .env', fs.existsSync(path.join(q, '.env')));
  check('B 不複製規則外的 .env.local', !fs.existsSync(path.join(q, '.env.local')));
  check('B 複製 config/a.json(未追蹤也未忽略)', fs.existsSync(path.join(q, 'config/a.json')));
  check('B 排除 !config/skip.json', !fs.existsSync(path.join(q, 'config/skip.json')));
  check('B 複製整個 secrets/ 資料夾', fs.existsSync(path.join(q, 'secrets/deep/key.pem')));
  check('B 不複製 .worktreeinclude 本身(已追蹤時才會在工作區)', !fs.existsSync(path.join(q, '.worktreeinclude')));
  check('B node_modules 是連結', isLink(path.join(q, 'node_modules')));
  const exclude = fs.readFileSync(path.resolve(q, git(q, 'rev-parse', '--git-path', 'info/exclude')), 'utf8');
  check('B 沒被忽略的連結與複製檔寫進 info/exclude', exclude.includes('/node_modules') && exclude.includes('/config/a.json'), JSON.stringify(exclude.split('\n').filter(l => l.startsWith('/'))));
  const stb = await wt.worktreeStatus(mb.info);
  check('B 工作區不被當成有修改', !stb.dirty, JSON.stringify(git(q, 'status', '--porcelain')));
  check('B 原版本庫 git status 沒有因此出錯', git(b, 'status', '--porcelain') !== undefined);
  // 強制移除也要先解除連結
  const removedB = await wt.removeWorktree(mb.info, true);
  check('B 強制移除工作區', removedB && !fs.existsSync(q));
  check('B 移除後原版本庫 node_modules/pkg/index.js 仍在', fs.existsSync(path.join(b, 'node_modules/pkg/index.js')));

  // 情境 C:路徑跳脫與 .git 防護(直接測 setupWorktree)
  const c = makeRepo('repo-c', { '.worktreeinclude': '../*\n**/.git/**\n.env\n', '.env': 'Z\n' }, '.env\n');
  const mc = await wt.createWorktree(c, 'EnvC', 'cccccc333333');
  console.log('[test] 摘要 C:', mc.setup);
  check('C 不會寫到工作區之外', !fs.existsSync(path.join(path.dirname(mc.info.path), 'README.md')));
  check('C 正常規則仍有效', fs.existsSync(path.join(mc.info.path, '.env')));
  await wt.removeWorktree(mc.info, true);

  // 情境 D:同一個節點在同一個版本庫再開一個工作區(轉移工作區)不會撞名
  const d = makeRepo('repo-d', { 'a.txt': 'a\n' }, '');
  const d1 = await wt.createWorktree(d, 'Mover', 'dddddd444444');
  const d2 = await wt.createWorktree(d, 'Mover', 'dddddd444444');
  check('D 第二個工作區的分支與資料夾都不同', d1.info.branch !== d2.info.branch && d1.info.path !== d2.info.path, `${d1.info.branch} / ${d2.info.branch}`);
  check('D 第二個分支加上 -2', d2.info.branch === `${d1.info.branch}-2` && d2.info.path === `${d1.info.path}-2`);
  check('D 兩個工作區都存在', fs.existsSync(d1.info.path) && fs.existsSync(d2.info.path));
  await wt.removeWorktree(d1.info, true);
  await wt.removeWorktree(d2.info, true);

  // 情境 E:已被移除的獨立工作區在原位置重建(接回終止過的節點)
  const e = makeRepo('repo-e', { 'a.txt': 'a\n' }, '');
  // E1:工作區有提交、資料夾被刪但分支還在 → 沿用原分支
  const e1 = await wt.createWorktree(e, 'Back', 'eeeeee555555');
  write(e1.info.path, 'done.txt', 'work\n');
  git(e1.info.path, 'add', '-A'); git(e1.info.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'work');
  wt.unlinkWorktreeLinks?.(e1.info.path);
  fs.rmSync(e1.info.path, { recursive: true, force: true });
  check('E1 可以重建', wt.canRebuildWorktree(e1.info));
  const r1 = await wt.rebuildWorktree(e1.info);
  check('E1 沿用原分支,工作成果還在', fs.existsSync(path.join(e1.info.path, 'done.txt')) && /沿用原分支/.test(r1.note), r1.note);
  check('E1 重建後不能再重建(路徑已有東西)', !wt.canRebuildWorktree(e1.info));
  let threw = '';
  try { await wt.rebuildWorktree(e1.info); } catch (err) { threw = err.message; }
  check('E1 路徑被佔用時說明原因', /已經有東西/.test(threw), threw);
  await wt.removeWorktree(e1.info, true);
  // E2:乾淨的工作區照終止規則被移除(連分支)→ 從 base 重開同名分支
  const e2 = await wt.createWorktree(e, 'Clean', 'ffffff666666');
  check('E2 乾淨的工作區照規則被移除', await wt.removeWorktree(e2.info, false));
  const r2 = await wt.rebuildWorktree(e2.info);
  check('E2 從 base 重開同名分支', fs.existsSync(path.join(e2.info.path, 'README.md')) && git(e2.info.path, 'rev-parse', '--abbrev-ref', 'HEAD') === e2.info.branch && /重開分支/.test(r2.note), `${r2.note}`);
  await wt.removeWorktree(e2.info, true);
  // 情境 F:選另一個獨立工作區當版本庫時,repoRoot 是主版本庫;基準是那個工作區目前的分支
  const f = makeRepo('repo-f', {}, '');
  const f1 = await wt.createWorktree(f, 'First', 'aaaa11112222');
  const f2 = await wt.createWorktree(f1.info.path, 'Second', 'bbbb33334444');
  // 比對實際路徑:CI 的暫存資料夾是 8.3 短名稱(RUNNER~1),git 回報的是長名稱
  const real = p => fs.realpathSync.native(p).toLowerCase();
  check('F repoRoot 是主版本庫,不是被選的工作區', real(f2.info.repoRoot) === real(f), `${f2.info.repoRoot}`);
  check('F 基準是被選工作區的分支', f2.info.base === f1.info.branch, f2.info.base);
  check('F 工作區資料夾都在主控台的工作區資料夾底下', wt.insideWorktreeHome(f1.info.path) && wt.insideWorktreeHome(f2.info.path) && !wt.insideWorktreeHome(f));
  await wt.removeWorktree(f2.info, true);
  await wt.removeWorktree(f1.info, true);
  // E3:版本庫不在了 → 不能重建
  check('E3 版本庫不在時不能重建', !wt.canRebuildWorktree({ ...e2.info, repoRoot: path.join(base, 'gone') }));

  console.log(failures ? `[test] 共 ${failures} 項失敗` : '[test] 全部通過');
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('[test] 例外', e); process.exit(1); });
