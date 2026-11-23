// 驗收:協作流程的版本與副本(src/main/flow/version.ts)與 changes.ts 新增的 changedPaths / commitChanges(paths)。
// 用法:在 app 資料夾執行 node tests/flow-version.test.mjs(Node 22.18 以上可直接載入 .ts)
// 全部在系統暫存區的測試版本庫裡做,結束時只刪除這次建立的暫存資料夾。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addDetachedWorktree, COPY_MARKER_SUFFIX, copyChanges, diffRefs, exportTree, ignoredList, linkDeps, newIgnored, refsFingerprint, refsState, removeCopy, removeDetachedWorktree, snapshot, snapshotCopy } from '../src/main/flow/version.ts';
import { changedPaths, commitChanges } from '../src/main/changes.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('[ok]', name); };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const write = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
const isLink = p => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const treeFiles = (repo, tree) => git(repo, 'ls-tree', '-r', '--name-only', tree).split('\n').filter(Boolean);

const BASE = mkdtempSync(join(tmpdir(), 'nexus-flowver-'));
console.log('[test] 暫存資料夾', BASE);

function makeRepo(name) {
  const root = join(BASE, name);
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'tester'); git(root, 'config', 'user.email', 'tester@example.com');
  git(root, 'config', 'core.autocrlf', 'false');
  write(root, '.gitignore', 'node_modules/\nout/\n*.log\n');
  write(root, 'README.md', 'hi\n');
  write(root, 'src/a.ts', 'export const a = 1;\n');
  write(root, 'src/old.ts', 'export const old = 1;\n');
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'init');
  // 被忽略的 node_modules(之後連結進副本)
  write(root, 'node_modules/pkg/index.js', 'module.exports = 42;\n');
  return root;
}

try {
  const repo = makeRepo('repo');
  let v1;

  await test('版本:涵蓋未被忽略的新檔與刪除,不含被忽略的檔案;內容不變時版本不變', async () => {
    const v0 = await snapshot(repo);
    write(repo, 'src/new.ts', 'export const n = 1;\n');
    rmSync(join(repo, 'src/old.ts'));
    write(repo, 'build.log', 'ignored\n');
    write(repo, 'src/a.ts', 'export const a = 2;\n');
    v1 = await snapshot(repo);
    assert.match(v1, /^[0-9a-f]{40,64}$/);
    assert.notEqual(v0, v1);
    const files = treeFiles(repo, v1);
    assert.ok(files.includes('src/new.ts'));
    assert.ok(!files.includes('src/old.ts'));
    assert.ok(!files.includes('build.log') && !files.some(f => f.startsWith('node_modules/')));
    assert.equal(await snapshot(repo), v1);
    // 使用者的暫存區沒被動到
    assert.equal(git(repo, 'diff', '--cached', '--name-only'), '');
  });

  await test('被忽略的產出清單與差集', async () => {
    const before = await ignoredList(repo);
    assert.ok(before.includes('build.log') && before.includes('node_modules/'), JSON.stringify(before));
    write(repo, 'out/main.js', 'x\n');
    const after = await ignoredList(repo);
    assert.deepEqual(newIgnored(before, after), ['out/']);
    rmSync(join(repo, 'out'), { recursive: true, force: true });
  });

  await test('changedPaths:列出新增、修改、刪除;改名拆成刪除加新增', async () => {
    const head = git(repo, 'rev-parse', 'HEAD^{tree}');
    const list = await changedPaths(repo, head, v1);
    assert.deepEqual(list, [
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/new.ts', status: 'A' },
      { path: 'src/old.ts', status: 'D' },
    ]);
  });

  const COPIES = join(BASE, 'runs', 'run1', 'copies');
  let copy = '';
  await test('匯出副本:不含 .git,內容與版本一致(含 CRLF 位元組),旁邊有標記檔', async () => {
    write(repo, 'crlf.txt', 'line1\r\nline2\r\n');
    v1 = await snapshot(repo);
    copy = join(COPIES, `r-${v1.slice(0, 8)}`);
    await exportTree(repo, v1, copy);
    assert.ok(!existsSync(join(copy, '.git')));
    assert.equal(JSON.parse(readFileSync(copy + COPY_MARKER_SUFFIX, 'utf8')).tree, v1);
    assert.equal(readFileSync(join(copy, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.ok(existsSync(join(copy, 'src/new.ts')) && !existsSync(join(copy, 'src/old.ts')));
    assert.ok(!existsSync(join(copy, 'build.log')) && !existsSync(join(copy, 'node_modules')));
    assert.deepEqual(readFileSync(join(copy, 'crlf.txt')), Buffer.from('line1\r\nline2\r\n'));
    await assert.rejects(exportTree(repo, v1, copy), /不是空的/);
  });

  await test('副本快照等於版本;連結 node_modules 後(排除連結)仍相等', async () => {
    assert.equal(await snapshotCopy(repo, copy), v1);
    const { linked, failed } = linkDeps(repo, copy);
    assert.deepEqual(failed, []);
    assert.deepEqual(linked, ['node_modules']);
    assert.ok(isLink(join(copy, 'node_modules')));
    assert.equal(readFileSync(join(copy, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 42;\n');
    assert.deepEqual(await copyChanges(repo, copy, v1, linked), []);
  });

  await test('副本被寫入的偵測:新增與修改都抓得到,正本不受影響', async () => {
    write(copy, 'src/a.ts', 'export const a = 999;\n');
    write(copy, 'sneaky.txt', 'x\n');
    assert.deepEqual((await copyChanges(repo, copy, v1, ['node_modules'])).sort(), ['sneaky.txt', 'src/a.ts']);
    assert.equal(readFileSync(join(repo, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.ok(!existsSync(join(repo, 'sneaky.txt')));
    assert.equal(await snapshot(repo), v1);
  });

  await test('刪除副本:先解除 junction,被連結的 node_modules 仍在;標記檔一起刪掉', async () => {
    const r = removeCopy(COPIES, copy);
    assert.equal(r.error, undefined);
    assert.equal(r.removed, true);
    assert.equal(r.unlinked.length, 1);
    assert.ok(!existsSync(copy) && !existsSync(copy + COPY_MARKER_SUFFIX));
    assert.ok(existsSync(join(repo, 'node_modules')) && !isLink(join(repo, 'node_modules')));
    assert.equal(readFileSync(join(repo, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 42;\n');
    assert.deepEqual(removeCopy(COPIES, copy), { removed: true, unlinked: [] });
  });

  await test('刪除副本:深層子專案的 node_modules junction 也會解除,目標仍在', async () => {
    const r3 = makeRepo('repo3');
    write(r3, 'packages/app/src/index.ts', 'export {};\n');
    git(r3, 'add', '-A'); git(r3, 'commit', '-q', '-m', 'app');
    write(r3, 'packages/app/node_modules/dep/keep.js', 'keep\n');
    const v = await snapshot(r3);
    const c = join(COPIES, `v-${v.slice(0, 8)}`);
    await exportTree(r3, v, c);
    const { linked } = linkDeps(r3, c);
    assert.deepEqual(linked.sort(), ['node_modules', 'packages/app/node_modules']);
    const r = removeCopy(COPIES, c);
    assert.equal(r.error, undefined);
    assert.equal(r.removed, true);
    assert.equal(r.unlinked.length, 2);
    assert.equal(readFileSync(join(r3, 'packages/app/node_modules/dep/keep.js'), 'utf8'), 'keep\n');
    assert.equal(readFileSync(join(r3, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 42;\n');
  });

  await test('刪除副本的防護:錯誤目標一律拒絕,什麼都不動(連結也不解除)', async () => {
    // 準備一個「看起來像副本」但沒有標記檔的資料夾,裡面有指向真正 node_modules 的連結
    const fake = join(COPIES, 'r-0123abcd');
    mkdirSync(join(fake, 'src'), { recursive: true });
    write(fake, 'src/x.ts', 'x\n');
    linkDeps(repo, fake);
    const bad = [
      [COPIES, fake, /標記檔/],                                        // 名稱對,但沒有標記檔
      [COPIES, join(COPIES, 'notacopy'), /不是副本資料夾的名稱/],
      [COPIES, join(repo, 'src'), /不在副本資料夾/],                    // repo 的子資料夾
      [COPIES, repo, /不在副本資料夾/],
      [COPIES, homedir(), /家目錄/],
      [homedir(), join(homedir(), 'r-0123abcd'), /家目錄/],
      [dirname(homedir()), homedir(), /家目錄/],
      [COPIES, 'relative/r-0123abcd', /絕對路徑/],
    ];
    for (const [root, dir, why] of bad) {
      const r = removeCopy(root, dir);
      assert.equal(r.removed, false, String(dir));
      assert.match(r.error, why, `${dir}:${r.error}`);
      assert.deepEqual(r.unlinked, []);
    }
    // 標記檔的版本和名稱不符也拒絕
    writeFileSync(fake + COPY_MARKER_SUFFIX, JSON.stringify({ tree: 'f'.repeat(40) }));
    assert.match(removeCopy(COPIES, fake).error, /標記檔版本/);
    // 副本裡有 .git 也拒絕
    writeFileSync(fake + COPY_MARKER_SUFFIX, JSON.stringify({ tree: '0123abcd' + '0'.repeat(32) }));
    mkdirSync(join(fake, '.git'));
    assert.match(removeCopy(COPIES, fake).error, /\.git/);
    // 什麼都沒動:連結還在、檔案還在
    assert.ok(isLink(join(fake, 'node_modules')));
    assert.ok(existsSync(join(fake, 'src/x.ts')) && existsSync(join(repo, 'README.md')));
    // 拿掉 .git 之後就是合法的副本,可以刪
    rmSync(join(fake, '.git'), { recursive: true });
    assert.equal(removeCopy(COPIES, fake).removed, true);
    assert.equal(readFileSync(join(repo, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 42;\n');
  });

  await test('從子資料夾拍快照再匯出:副本的根目錄是 repo 根目錄結構,只含那個子資料夾的檔案', async () => {
    const vs = await snapshot(join(repo, 'src'));
    const files = treeFiles(repo, vs);
    assert.ok(files.length > 0 && files.every(f => f.startsWith('src/')), JSON.stringify(files));
    const c = join(COPIES, `r-${vs.slice(0, 8)}`);
    await exportTree(join(repo, 'src'), vs, c);
    assert.equal(readFileSync(join(c, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
    assert.ok(!existsSync(join(c, 'README.md')) && !existsSync(join(c, 'a.ts')));
    assert.equal(removeCopy(COPIES, c).removed, true);
  });

  await test('refs:快照與匯出不改變;commit 之後改變,diffRefs 指出 HEAD 與分支', async () => {
    const f0 = await refsFingerprint(repo);
    const s0 = await refsState(repo);
    assert.equal(s0.symbolic, 'refs/heads/main');
    await snapshot(repo);
    assert.equal(await refsFingerprint(repo), f0);
    git(repo, 'add', 'README.md');
    write(repo, 'README.md', 'hi2\n');
    git(repo, 'commit', '-q', '-am', 'second');
    assert.notEqual(await refsFingerprint(repo), f0);
    const s1 = await refsState(repo);
    assert.deepEqual(diffRefs(s0, s1), ['HEAD', 'refs/heads/main']);
    // 遠端追蹤分支與標籤也在範圍內(push 會更新 refs/remotes/…)
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'tag', 'v0');
    assert.deepEqual(diffRefs(s1, await refsState(repo)), ['refs/remotes/origin/main', 'refs/tags/v0']);
  });

  await test('桌面核實 worktree:不建分支,node_modules 連結進去;移除後被連結的 node_modules 仍在', async () => {
    // 模擬 pnpm:真正的 node_modules 裡面也有 junction,指向 store
    write(BASE, 'store/dep/index.js', 'store\n');
    symlinkSync(join(BASE, 'store/dep'), join(repo, 'node_modules/linked-dep'), process.platform === 'win32' ? 'junction' : 'dir');
    // 版本庫的 post-checkout hook 不應該被執行
    write(repo, '.git/hooks/post-checkout', `#!/bin/sh\necho ran > "${join(BASE, 'hook-ran.txt').replace(/\\/g, '/')}"\n`);
    const v = await snapshot(repo);
    const refs0 = await refsFingerprint(repo);
    const branches0 = git(repo, 'branch', '--list');
    const dest = join(BASE, 'wt', `v-${v.slice(0, 8)}`);
    const w = await addDetachedWorktree(repo, v, dest);
    assert.deepEqual(w.failed, []);
    assert.deepEqual(w.linked, ['node_modules']);
    assert.ok(!existsSync(join(BASE, 'hook-ran.txt')), 'post-checkout hook 不該被執行');
    assert.ok(existsSync(join(dest, '.git')));
    assert.equal(readFileSync(join(dest, 'src/new.ts'), 'utf8'), 'export const n = 1;\n');
    assert.ok(isLink(join(dest, 'node_modules')));
    assert.equal(git(repo, 'branch', '--list'), branches0);
    assert.equal(await refsFingerprint(repo), refs0);
    assert.equal(git(dest, 'rev-parse', 'HEAD^{tree}'), v);

    // 錯誤對象一律拒絕,真正 node_modules 裡的連結不能被拆
    const other = join(BASE, 'wt', 'normal');
    git(repo, 'worktree', 'add', '-q', '-b', 'side', other);
    symlinkSync(join(BASE, 'store/dep'), join(other, 'own-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const refused = [
      [repo, w.commit, /版本庫本身|主工作樹/],                 // 主工作樹
      [other, w.commit, /停在分支上/],                         // 一般 worktree
      [dest, git(repo, 'rev-parse', 'HEAD'), /不是核實用提交/], // 對象對、提交不對
      [join(BASE, 'wt'), w.commit, /不是這個版本庫登記的 worktree/],
      [homedir(), w.commit, /家目錄/],
    ];
    for (const [d, c, why] of refused) {
      const r = await removeDetachedWorktree(repo, d, c);
      assert.equal(r.removed, false, String(d));
      assert.match(r.error, why, `${d}:${r.error}`);
      assert.deepEqual(r.unlinked, []);
    }
    assert.ok(isLink(join(repo, 'node_modules/linked-dep')), '真正 node_modules 裡的 junction 仍在');
    assert.ok(isLink(join(other, 'own-link')));
    assert.ok(isLink(join(dest, 'node_modules')));
    assert.equal(readFileSync(join(repo, 'node_modules/linked-dep/index.js'), 'utf8'), 'store\n');

    const r = await removeDetachedWorktree(repo, dest, w.commit);
    assert.equal(r.error, undefined);
    assert.equal(r.removed, true);
    assert.ok(!existsSync(dest));
    assert.equal(readFileSync(join(repo, 'node_modules/pkg/index.js'), 'utf8'), 'module.exports = 42;\n');
    assert.equal(readFileSync(join(BASE, 'store/dep/index.js'), 'utf8'), 'store\n');
    // 收掉一般 worktree(先解除自己建的連結)
    try { unlinkSync(join(other, 'own-link')); } catch { rmdirSync(join(other, 'own-link')); }
    git(repo, 'worktree', 'remove', '--force', other);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length, 1);

    // 資料夾已經不在:只移除這一筆登記,不跑全域 prune(使用者自己暫時不在的 worktree 登記要留著)
    const tree2 = await snapshot(repo);
    const gone = join(BASE, 'wt', 'gone-verify');
    const w2 = await addDetachedWorktree(repo, tree2, gone);
    const away = join(BASE, 'wt', 'user-away');
    git(repo, 'worktree', 'add', '-q', '--detach', away);
    for (const d of [gone, away]) {
      const nm = join(d, 'node_modules');
      if (isLink(nm)) { try { unlinkSync(nm); } catch { rmdirSync(nm); } }
      rmSync(d, { recursive: true, force: true });
    }
    const listed = () => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).length;
    assert.equal(listed(), 3);
    const rg = await removeDetachedWorktree(repo, gone, w2.commit);
    assert.equal(rg.removed, true, rg.error);
    assert.equal(listed(), 2, '只移除核實 worktree 的登記,使用者暫時不在的那一筆還在');
    assert.equal((await removeDetachedWorktree(repo, gone, w2.commit)).removed, true, '沒登記就當成已移除');
    assert.equal((await removeDetachedWorktree(repo, away, w2.commit)).removed, false, '不是自己建的就不動');
    assert.equal(listed(), 2);
    git(repo, 'worktree', 'remove', '--force', away);
  });

  await test('commitChanges 的路徑過濾:只提交選取的檔案,其他修改留在工作區', async () => {
    const r2 = makeRepo('repo2');
    const base = await snapshot(r2);
    write(r2, 'src/a.ts', 'export const a = 3;\n');
    write(r2, 'src/b.ts', 'export const b = 1;\n');
    const end = await snapshot(r2);
    const sha = await commitChanges(r2, base, end, '只提交 a', ['src\\a.ts']);
    assert.match(sha, /^[0-9a-f]{4,}$/);
    assert.equal(git(r2, 'show', '--name-only', '--format=', 'HEAD'), 'src/a.ts');
    assert.equal(git(r2, 'status', '--porcelain'), '?? src/b.ts');
    await assert.rejects(commitChanges(r2, base, end, 'x', ['not/changed.ts']), /選取的檔案沒有可以提交的修改/);
    // 不給路徑時維持原本的行為:整個任務的修改都提交
    const sha2 = await commitChanges(r2, base, end, '其餘');
    assert.match(sha2, /^[0-9a-f]{4,}$/);
    assert.equal(git(r2, 'status', '--porcelain'), '');
  });

  await test('commitChanges:路徑很多時改從 stdin 傳清單,不會超過命令列長度上限', async () => {
    const r4 = makeRepo('repo4');
    const base = await snapshot(r4);
    const names = Array.from({ length: 400 }, (_, i) => `src/generated/very-long-file-name-for-cmdline-test-${String(i).padStart(4, '0')}.ts`);
    for (const n of names) write(r4, n, `export const x = ${n.length};\n`);
    const end = await snapshot(r4);
    assert.ok(names.join(' ').length > 20000);
    const sha = await commitChanges(r4, base, end, '大量檔案', names.slice(0, 350));
    assert.match(sha, /^[0-9a-f]{4,}$/);
    assert.equal(git(r4, 'show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).length, 350);
    assert.equal(git(r4, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).length, 50);
  });
} finally {
  // 只刪這次建立的暫存資料夾(連結的目標也在裡面)
  rmSync(BASE, { recursive: true, force: true });
  console.log('[test] 已刪除', BASE, existsSync(BASE) ? '(仍在!)' : '');
}

console.log(`通過 ${passed} 項`);
