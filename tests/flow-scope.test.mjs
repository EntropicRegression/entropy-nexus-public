// 驗收:協作流程的範圍合約(src/main/flow/scope.ts):allowed_paths 的 glob 比對、範圍外未說明的檔案、禁止動作的指令比對。
// 用法:在 app 資料夾執行 node tests/flow-scope.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { matchForbidden, outOfScope, protectedHits, realUserDataDir, unexplained } from '../src/main/flow/scope.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const DEFAULT = ['commit', 'push', 'dist', 'merge_pr', 'approve_pr', 'force_push', 'delete_branch'];
const ALL = [...DEFAULT, 'install', 'real_vault'];

test('outOfScope:沒設定 allowed_paths 就不限制', () => {
  assert.deepEqual(outOfScope(['a.ts', 'src/x.ts'], []), []);
});

test('outOfScope:**、*、資料夾名稱、根目錄錨定、否定規則', () => {
  const paths = ['src/renderer/App.tsx', 'src/renderer/deep/x/y.css', 'src/main/core.ts', 'docs/a.md', 'README.md', 'tests/flow-def.test.mjs', 'tests/other.js', 'src/renderer/secret.ts'];
  assert.deepEqual(outOfScope(paths, ['src/renderer/**']), ['src/main/core.ts', 'docs/a.md', 'README.md', 'tests/flow-def.test.mjs', 'tests/other.js']);
  assert.deepEqual(outOfScope(paths, ['src/renderer', '*.md']), ['src/main/core.ts', 'tests/flow-def.test.mjs', 'tests/other.js']);
  assert.deepEqual(outOfScope(paths, ['/README.md', 'tests/flow-*.test.mjs']), paths.filter(p => p !== 'README.md' && p !== 'tests/flow-def.test.mjs'));
  assert.deepEqual(outOfScope(paths, ['src/renderer/**', '!src/renderer/secret.ts']), ['src/main/core.ts', 'docs/a.md', 'README.md', 'tests/flow-def.test.mjs', 'tests/other.js', 'src/renderer/secret.ts']);
  // Windows 路徑也能比對
  assert.deepEqual(outOfScope(['src\\renderer\\App.tsx', 'src\\main\\x.ts'], ['src/renderer/**']), ['src\\main\\x.ts']);
});

test('unexplained:範圍外、沒有寫原因的檔案', () => {
  const outside = ['src/main/core.ts', 'package.json', 'docs/a.md'];
  const ex = [{ path: './src/main/core.ts', reason: '型別要跟著改' }, { path: 'package.json', reason: '  ' }, { path: 'docs\\a.md', reason: '補文件' }];
  assert.deepEqual(unexplained(outside, ex), ['package.json']);
  assert.deepEqual(unexplained(outside, []), outside);
});

test('matchForbidden:抓得到 git commit / push 的各種寫法', () => {
  const hits = [
    'git commit -m "x"',
    'git -C src/app commit -am wip',
    'git -C "C:\\my repo" commit',
    'git -c user.name=x -c user.email=y commit --amend',
    'cd repo && git commit -m x',
    'npm test; git commit',
    'C:\\Program Files\\Git\\cmd\\git.exe commit -m x',
    'git --no-pager commit',
    'GIT_DIR=x git commit',
  ];
  for (const h of hits) assert.deepEqual(matchForbidden(h, DEFAULT), ['commit'], h);
  for (const h of ['git push', 'git push origin main', 'git -C x push -u origin b', 'git fetch && git push', 'git push --follow-tags']) assert.deepEqual(matchForbidden(h, DEFAULT), ['push'], h);
  assert.deepEqual(matchForbidden('git commit -m x && git push', DEFAULT), ['commit', 'push']);
  assert.deepEqual(matchForbidden('git add -A\ngit commit -m x', DEFAULT), ['commit']);
});

test('matchForbidden:不誤判 git commit-tree 與其他看起來像的指令', () => {
  const misses = [
    'git commit-tree 4b825dc -m x',
    'git -C x commit-tree abc',
    'git log --grep=commit',
    'git show HEAD --stat',
    'git status',
    'git diff --cached',
    'echo committed',
    'npm run commitlint',
    'git pushd',
    'node scripts/git-commit-helper.js',
    'digit commit',
  ];
  for (const m of misses) assert.deepEqual(matchForbidden(m, DEFAULT), [], m);
});


test('matchForbidden:git 全域選項、指令替換、大括號、交給 shell 執行的引號內容都抓得到', () => {
  const hits = [
    'git --git-dir x/.git commit -m y',
    'git --git-dir=x/.git commit',
    'git --work-tree . commit -am x',
    'echo `git commit -m x`',
    'echo $(git commit -m x)',
    '{ git commit -m x; }',
    'echo "$(git commit -m x)"',
    'bash -c "git commit -m x"',
    "sh -c 'cd repo && git commit -m x'",
    'cmd /c "git commit -m x"',
    'powershell -Command "git commit -m x"',
    'pwsh -NoProfile -Command "& { git commit -m x }"',
  ];
  for (const h of hits) assert.ok(matchForbidden(h, DEFAULT).includes('commit'), h);
});

test('matchForbidden:引號裡的字串是資料,不當成指令', () => {
  const misses = [
    'rg "git push" src',
    'echo "do not git commit"',
    'grep "npm run dist" docs',
    "git log --grep 'git commit'",
    'echo "gh pr merge 12"',
    'node -e "console.log(\'git push --force\')"',
  ];
  for (const m of misses) assert.deepEqual(matchForbidden(m, ALL), [], m);
});

test('matchForbidden:npm/pnpm/yarn/bun 的 dist、electron-builder', () => {
  const hits = ['npm run dist', 'npm.cmd run dist', 'pnpm run dist', 'yarn dist', 'pnpm dist', 'bun run dist', 'yarn run dist', 'npm --prefix app run dist', 'npm run --silent dist', 'npm -w app run dist', 'npx electron-builder --win nsis', 'electron-vite build && electron-builder --win'];
  for (const h of hits) assert.deepEqual(matchForbidden(h, DEFAULT), ['dist'], h);
  for (const m of ['npm run distribute', 'npm run build', 'node dist/index.js', 'ls dist', 'npm run build -- --out dist', 'npm test dist', 'pnpm add dist-utils']) assert.deepEqual(matchForbidden(m, DEFAULT), [], m);
});

test('matchForbidden:永遠禁止的動作——合併 PR、核准 PR、force push、刪分支', () => {
  assert.deepEqual(matchForbidden('gh pr merge 12 --squash', DEFAULT), ['merge_pr']);
  assert.deepEqual(matchForbidden('gh api -X PUT repos/o/r/pulls/12/merge', DEFAULT), ['merge_pr']);
  assert.deepEqual(matchForbidden('gh pr review 12 --approve', DEFAULT), ['approve_pr']);
  assert.deepEqual(matchForbidden('gh pr review 12 -a -b ok', DEFAULT), ['approve_pr']);
  assert.deepEqual(matchForbidden('gh api repos/o/r/pulls/12/reviews -f event=APPROVE', DEFAULT), ['approve_pr']);
  for (const h of ['git push --force', 'git push -f origin main', 'git push --force-with-lease', 'git push origin +main', 'git push -uf origin b']) assert.deepEqual(matchForbidden(h, DEFAULT), ['push', 'force_push'], h);
  for (const h of ['git push origin --delete feature', 'git push origin :feature', 'git push -d origin feature']) assert.deepEqual(matchForbidden(h, DEFAULT), ['push', 'delete_branch'], h);
  for (const h of ['git branch -D feature', 'git branch -d feature', 'git branch --delete feature']) assert.deepEqual(matchForbidden(h, DEFAULT), ['delete_branch'], h);
  for (const m of ['gh pr view 12', 'gh pr review 12 --comment -b x', 'git branch -a', 'git branch --list', 'git push origin main:main', 'git push --follow-tags']) {
    assert.deepEqual(matchForbidden(m, DEFAULT).filter(a => !['push'].includes(a)), [], m);
  }
});

test('matchForbidden:install(Setup.exe、.msi、Program Files、%LOCALAPPDATA%\\Programs)', () => {
  const hits = [
    '"C:\\Users\\x\\Downloads\\Entropy-Nexus-Setup-0.3.0.exe" /S',
    'release\\Entropy-Nexus-Setup-0.3.0.exe',
    'msiexec /i app.msi /qn',
    'Start-Process .\\tool.msi',
    'copy out\\main.js "C:\\Program Files\\Entropy Nexus\\resources"',
    'xcopy dist %LOCALAPPDATA%\\Programs\\entropy-nexus /s',
    'Copy-Item x $env:LOCALAPPDATA\\Programs\\app',
  ];
  for (const h of hits) assert.deepEqual(matchForbidden(h, ALL), ['install'], h);
  // install 不在禁止清單裡時不擋;一般套件安裝不算「安裝或覆蓋」
  assert.deepEqual(matchForbidden('msiexec /i app.msi', DEFAULT), []);
  for (const m of ['npm install left-pad', 'npm run typecheck', 'node tools/setup-env.js']) assert.deepEqual(matchForbidden(m, ALL), [], m);
});

test('matchForbidden:real_vault(真實 userData 與呼叫端傳入的記憶庫路徑)', () => {
  assert.deepEqual(matchForbidden('del %APPDATA%\\entropy-nexus\\store.json', ALL), ['real_vault']);
  assert.deepEqual(matchForbidden('Remove-Item $env:APPDATA\\entropy-nexus\\x', ALL), ['real_vault']);
  assert.deepEqual(matchForbidden('echo x > "C:\\Users\\me\\AppData\\Roaming\\entropy-nexus\\a.txt"', ALL), ['real_vault']);
  const vault = 'D:\\Notes\\Vault';
  assert.deepEqual(matchForbidden('echo x > "D:/notes/vault/cases/a.md"', ALL, { protectedPaths: [vault] }), ['real_vault']);
  assert.deepEqual(matchForbidden('echo x > D:\\Other\\a.md', ALL, { protectedPaths: [vault] }), []);
  assert.deepEqual(matchForbidden('del %APPDATA%\\entropy-nexus\\x', DEFAULT), []);
});

test('protectedHits:寫入範圍不得包含流程定義、主控台設定與記憶庫資料夾', () => {
  const base = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const flows = process.platform === 'win32' ? 'C:\\Users\\me\\AppData\\Roaming\\entropy-nexus' : '/home/me/.config/entropy-nexus';
  const vault = process.platform === 'win32' ? 'D:\\Vault' : '/vault';
  const sep = process.platform === 'win32' ? '\\' : '/';
  const paths = [`${flows}${sep}flows${sep}implement-review.yaml`, `${vault}${sep}cases${sep}a.md`, 'src/a.ts', flows, `${flows}-backup${sep}x`];
  assert.deepEqual(protectedHits(paths, [flows, vault], base), [paths[0], paths[1], paths[3]]);
  assert.deepEqual(protectedHits(['flows/x.yaml'], [`${base}${sep}flows`], base), ['flows/x.yaml']);
  assert.equal(realUserDataDir({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }).replace(/\\/g, '/'), 'C:/Users/me/AppData/Roaming/entropy-nexus');
  assert.equal(realUserDataDir({}), '');
});

test('outOfScope / unexplained:Windows 上不分大小寫', () => {
  assert.deepEqual(outOfScope(['SRC/Renderer/App.tsx', 'src/main/x.ts'], ['src/renderer/**'], true), ['src/main/x.ts']);
  assert.deepEqual(outOfScope(['SRC/Renderer/App.tsx'], ['src/renderer/**'], false), ['SRC/Renderer/App.tsx']);
  assert.deepEqual(unexplained(['Docs/A.md'], [{ path: 'docs/a.md', reason: '補文件' }], true), []);
});

console.log(`通過 ${passed} 項`);
