// 驗收:專案識別(src/main/project.ts)。用真的 git 版本庫與 git worktree 驗證:同一個 repo 的 worktree 是同一個專案、
// 子資料夾也是,非 git 資料夾用正規化後的路徑,路徑正規化(大小寫、斜線、結尾斜線),快取與 git init 之後的更新。
// 用法:node --no-warnings tests/project.test.mjs(需要 git)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearProjectCache, normalizePath, projectOf, resolveProject } from '../src/main/project.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('[ok]', name); };
const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'nexus-proj-')));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString().trim();
const win = process.platform === 'win32';
const norm = p => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); return win ? s.toLowerCase() : s; };

try {
  const repo = join(tmp, 'My Repo');
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const wt = join(tmp, 'wt-feature');
  git(repo, 'worktree', 'add', '-q', '-b', 'feature', wt);
  const plain = join(tmp, 'Plain Folder');
  mkdirSync(plain);

  await test('路徑正規化:斜線、結尾斜線、大小寫(依平台)、不存在的路徑', () => {
    assert.equal(normalizePath('C:\\Users\\Foo\\Bar\\', true), norm('C:\\Users\\Foo\\Bar').toLowerCase());
    assert.equal(normalizePath('/tmp/not-exist-xyz/Sub//', false).endsWith('/Sub'), true);
    assert.equal(normalizePath('/tmp/Not-Exist', true), normalizePath('/tmp/not-exist', true));
    assert.notEqual(normalizePath('/tmp/Not-Exist', false), normalizePath('/tmp/not-exist', false));
    assert.equal(normalizePath(plain, false).includes('\\'), false);
    assert.equal(normalizePath(plain + '/', false), normalizePath(plain, false));
  });

  await test('git 版本庫:id 是主版本庫的根目錄,名稱是資料夾名稱', async () => {
    const p = await resolveProject(repo);
    assert.equal(p.isGit, true);
    assert.equal(p.id, norm(repo));
    assert.equal(p.root, p.id);
    assert.equal(p.name, 'My Repo');
  });

  await test('子資料夾與 worktree 都對應到同一個專案', async () => {
    const a = await projectOf(repo);
    const sub = await projectOf(join(repo, 'src', 'deep'));
    const b = await projectOf(wt);
    assert.deepEqual(sub, a);
    assert.deepEqual(b, a);
    assert.equal(b.name, 'My Repo');
    assert.notEqual(b.id, norm(wt));
  });

  await test('路徑寫法不同(結尾斜線、反斜線、大小寫)得到相同的 id', async () => {
    const a = await projectOf(repo);
    assert.equal((await projectOf(repo + '/')).id, a.id);
    assert.equal((await projectOf(repo.replace(/\\/g, '/'))).id, a.id);
    if (win) assert.equal((await projectOf(repo.toUpperCase())).id, a.id);
  });

  await test('非 git 資料夾:用正規化後的路徑,名稱是資料夾名稱;和 git 專案不同', async () => {
    const p = await resolveProject(plain);
    assert.equal(p.isGit, false);
    assert.equal(p.id, norm(plain));
    assert.equal(p.name, 'Plain Folder');
    assert.notEqual(p.id, (await projectOf(repo)).id);
    assert.equal((await projectOf(plain + '\\')).id, p.id);
  });

  await test('不存在的資料夾不會丟出錯誤,當成非 git 資料夾', async () => {
    const p = await projectOf(join(tmp, 'no-such-dir'));
    assert.equal(p.id, norm(join(tmp, 'no-such-dir')));
    assert.equal(p.name, 'no-such-dir');
  });

  await test('快取:git 的結果快取;非 git 資料夾之後 git init 清掉快取就會更新', async () => {
    const dir = join(tmp, 'later-repo');
    mkdirSync(dir);
    const before = await projectOf(dir);
    assert.equal(before.id, norm(dir));
    git(dir, 'init', '-q', '-b', 'main');
    assert.equal((await projectOf(join(dir))).id, norm(dir));
    assert.equal(await projectOf(repo), await projectOf(repo));
    clearProjectCache();
    assert.equal((await projectOf(dir)).id, norm(dir));
  });
} finally {
  try { execFileSync('git', ['worktree', 'prune'], { cwd: join(tmp, 'My Repo') }); } catch { /* 清理而已 */ }
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`通過(${passed} 項)`);
