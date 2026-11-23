// 驗收:協作流程的核實(src/main/flow/verify.ts、lockers.ts):四類結果、前置失敗時略過、逾時連孫程序一起終止、改檔偵測、桌面核實的開關。
// 用法:在 app 資料夾執行 node tests/flow-verify.test.mjs(Node 22.18 以上可直接載入 .ts)
// 指令都用暫存區裡的小腳本,不開視窗;結束時只刪除這次建立的暫存資料夾。
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, decodeOutput, orderCommands, runVerify, verifyEnv } from '../src/main/flow/verify.ts';
import { findLockers, lockedPathsFromOutput } from '../src/main/flow/lockers.ts';
import { copyChanges, exportTree, snapshot } from '../src/main/flow/version.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('[ok]', name); };
const cmd = (id, run, extra = {}) => ({ id, run, timeout: 30, needs: [], desktop: false, ...extra });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE = mkdtempSync(join(tmpdir(), 'nexus-flowverify-'));
console.log('[test] 暫存資料夾', BASE);
const script = (name, body) => { const p = join(BASE, name); writeFileSync(p, body); return `node "${p}"`; };

try {
  await test('orderCommands:照定義順序,前置指令先排', async () => {
    const list = orderCommands([cmd('unit', 'x', { needs: ['tc'] }), cmd('lint', 'x'), cmd('tc', 'x')]);
    assert.deepEqual(list.map(c => c.id), ['tc', 'unit', 'lint']);
  });

  await test('classify:找不到指令、無法啟動才直接判被擋住;鎖檔之類的字只附成可能的環境原因', async () => {
    assert.deepEqual(classify(0, ''), { outcome: 'pass' });
    assert.deepEqual(classify(1, 'AssertionError: expected 1'), { outcome: 'fail' });
    assert.deepEqual(classify(1, "Error: EBUSY: resource busy or locked, unlink 'C:\\x\\a.dll'"), { outcome: 'fail', envHint: '檔案可能被其他程式鎖住', lockable: true });
    assert.deepEqual(classify(1, 'Error: EACCES: permission denied, open x'), { outcome: 'fail', envHint: '存取被拒(可能是權限或檔案被鎖住)', lockable: true });
    assert.deepEqual(classify(1, 'listen EADDRINUSE: address already in use :::5173'), { outcome: 'fail', envHint: '連接埠可能已被占用', lockable: false });
    assert.equal(classify(1, "'foo' 不是內部或外部命令、可執行的程式或批次檔。").outcome, 'blocked');
    assert.equal(classify(9009, '').outcome, 'blocked');
    assert.equal(classify(127, '').outcome, 'blocked');
    assert.equal(classify(null, '', 'spawn ENOENT').outcome, 'blocked');
    // 只看最後 20 行:前面出現的 EPERM(例如測試名稱、斷言訊息)不算
    const early = ['✓ 處理 EPERM 的錯誤訊息', ...Array.from({ length: 25 }, (_, i) => `line ${i}`), 'AssertionError: 1 !== 2'].join('\n');
    assert.deepEqual(classify(1, early), { outcome: 'fail' });
  });

  await test('verifyEnv:清掉 NEXUS_*、ELECTRON_*、npm_*、INIT_CWD、GIT_DIR 等,設 CI=1、FORCE_COLOR=0', async () => {
    const env = verifyEnv({
      PATH: 'p', NEXUS_DIR: 'secret', nexus_token: 't', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://localhost:5173', FORCE_COLOR: '3',
      npm_lifecycle_event: 'dev', npm_config_cache: 'x', INIT_CWD: 'c', GIT_DIR: 'g', GIT_WORK_TREE: 'w', GIT_INDEX_FILE: 'i', NODE_OPTIONS: '--inspect', GIT_AUTHOR_NAME: 'keep',
    });
    assert.deepEqual(env, { PATH: 'p', GIT_AUTHOR_NAME: 'keep', CI: '1', FORCE_COLOR: '0' });
  });

  await test('環境隔離:NEXUS_DATA_DIR 指到臨時資料夾,核實結束後刪除;結果標出執行位置', async () => {
    const out = join(BASE, 'datadir.txt');
    const r = await runVerify({ cwd: BASE, version: 'v', allowDesktop: false, location: 'worktree', commands: [cmd('d', script('data.js', `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.NEXUS_DATA_DIR || '')`))] });
    assert.equal(r.outcome, 'pass');
    assert.equal(r.commands[0].location, 'worktree');
    const dir = readFileSync(out, 'utf8');
    assert.ok(dir.includes('nexus-flow-data-'), dir);
    assert.ok(!existsSync(dir), '臨時資料夾應已刪除');
    const own = join(BASE, 'own-data');
    await runVerify({ cwd: BASE, version: 'v', allowDesktop: false, dataDir: own, commands: [cmd('d', script('data.js', `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.NEXUS_DATA_DIR || '')`))] });
    assert.equal(readFileSync(out, 'utf8'), own);
  });

  await test('通過、失敗、前置失敗略過:失敗只記一筆,後面的標「略過(前置失敗)」', async () => {
    const ok = await runVerify({ cwd: BASE, version: 'v', allowDesktop: false, commands: [cmd('a', 'node -e "process.exit(0)"'), cmd('b', 'node -e "process.exit(0)"', { needs: ['a'] })] });
    assert.equal(ok.outcome, 'pass');
    assert.deepEqual(ok.commands.map(c => c.outcome), ['pass', 'pass']);
    const r = await runVerify({
      cwd: BASE, version: 'v1', allowDesktop: false, logDir: join(BASE, 'logs1'),
      commands: [cmd('tc', script('fail.js', 'console.log("型別錯誤 x"); process.exit(2);')), cmd('unit', 'node -e "process.exit(0)"', { needs: ['tc'] }), cmd('other', 'node -e "process.exit(0)"')],
    });
    assert.equal(r.outcome, 'fail');
    assert.deepEqual(r.failed, ['tc']);
    assert.equal(r.commands[0].location, 'copy');
    assert.equal(r.version, 'v1');
    const [tc, unit, other] = r.commands;
    assert.equal(tc.outcome, 'fail'); assert.equal(tc.exitCode, 2); assert.equal(tc.lastLine, '型別錯誤 x');
    assert.ok(existsSync(tc.logFile) && readFileSync(tc.logFile, 'utf8').includes('型別錯誤 x'));
    assert.equal(unit.outcome, 'skipped'); assert.match(unit.reason, /略過\(前置失敗\):tc/);
    assert.equal(other.outcome, 'pass');
    assert.equal(r.commands.filter(c => c.outcome === 'fail').length, 1);
  });

  await test('被環境擋住:附上鎖定的程序;找不到指令也算被擋住;整組優先算 blocked', async () => {
    const r = await runVerify({
      cwd: BASE, version: 'v', allowDesktop: false,
      findLockers: async out => (out.includes('EBUSY') ? [{ pid: 4242, name: 'Entropy Nexus' }] : []),
      commands: [
        cmd('locked', script('locked.js', 'console.error("Error: EBUSY: resource busy or locked, unlink \'C:\\\\app\\\\out\\\\main.js\'"); process.exit(1);')),
        cmd('missing', 'nexus-no-such-command-xyz --version'),
        cmd('bad', 'node -e "process.exit(1)"'),
      ],
    });
    assert.equal(r.outcome, 'blocked');
    assert.equal(r.stuckAt, 'locked');
    assert.equal(r.commands[0].outcome, 'blocked');
    assert.deepEqual(r.commands[0].lockers, [{ pid: 4242, name: 'Entropy Nexus' }]);
    assert.equal(r.commands[1].outcome, 'blocked', JSON.stringify(r.commands[1]));
    assert.equal(r.commands[2].outcome, 'fail');
    // 整組是 blocked,但失敗的指令也要列出來
    assert.deepEqual(r.blocked, ['locked', 'missing']);
    assert.deepEqual(r.failed, ['bad']);
  });

  await test('鎖檔的字樣但找不到鎖定程序:仍判失敗,附上可能的環境原因(實作錯誤不能被當成環境問題)', async () => {
    const r = await runVerify({
      cwd: BASE, version: 'v', allowDesktop: false, findLockers: async () => [],
      commands: [
        // 斷言失敗後清理暫存時印出 EBUSY
        cmd('cleanup', script('cleanup.js', 'console.log("AssertionError: 1 !== 2"); console.error("Error: EBUSY: resource busy or locked, rmdir \'C:\\\\tmp\\\\x\'"); process.exit(1);')),
        // 測試名稱含「被鎖」、斷言訊息含 EPERM,但都在很前面
        cmd('early', script('early.js', 'console.log("測試:檔案被鎖時要重試"); console.log("expected EPERM handling"); for (let i = 0; i < 30; i++) console.log("ok " + i); console.log("1 failing"); process.exit(1);')),
      ],
    });
    assert.equal(r.outcome, 'fail');
    assert.deepEqual(r.failed, ['cleanup', 'early']);
    assert.deepEqual(r.blocked, []);
    assert.equal(r.commands[0].envHint, '檔案可能被其他程式鎖住');
    assert.equal(r.commands[0].lockers, undefined);
    assert.equal(r.commands[1].envHint, undefined);
  });

  await test('逾時:回報卡在哪條指令、最後一行輸出;子程序與孫程序都被終止', async () => {
    const pids = join(BASE, 'pids.json');
    const run = script('hang.js', `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ child: process.pid, grand: g.pid }));
      console.log('第一步完成');
      console.log('卡在第二步');
      setInterval(() => {}, 1000);
    `);
    const t0 = Date.now();
    const r = await runVerify({ cwd: BASE, version: 'v', allowDesktop: false, commands: [cmd('hang', run, { timeout: 3 }), cmd('after', 'node -e "process.exit(0)"', { needs: ['hang'] })] });
    assert.ok(Date.now() - t0 < 20000, '逾時後應該很快收尾');
    assert.equal(r.outcome, 'timeout');
    assert.equal(r.stuckAt, 'hang');
    assert.equal(r.commands[0].outcome, 'timeout');
    assert.equal(r.commands[0].exitCode, null);
    assert.equal(r.commands[0].lastLine, '卡在第二步');
    assert.match(r.commands[0].reason, /逾時\(3 秒\),卡在:卡在第二步/);
    assert.equal(r.commands[1].outcome, 'skipped');
    const { child, grand } = JSON.parse(readFileSync(pids, 'utf8'));
    for (let i = 0; i < 30 && (alive(child) || alive(grand)); i++) await sleep(200);
    assert.equal(alive(child), false, `子程序 ${child} 仍在`);
    assert.equal(alive(grand), false, `孫程序 ${grand} 仍在`);
  });

  await test('中止(停止流程或關閉主控台):子程序與孫程序都被終止,其餘指令略過,臨時資料夾刪掉', async () => {
    const pids = join(BASE, 'pids-abort.json');
    const run = script('hang2.js', `
      const { spawn } = require('node:child_process');
      const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify({ child: process.pid, grand: g.pid, data: process.env.NEXUS_DATA_DIR }));
      setInterval(() => {}, 1000);
    `);
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runVerify({ cwd: BASE, version: 'v', allowDesktop: false, signal: ac.signal, commands: [cmd('hang', run, { timeout: 120 }), cmd('next', 'node -e "process.exit(0)"')] });
    for (let i = 0; i < 50 && !existsSync(pids); i++) await sleep(100);
    ac.abort();
    const r = await p;
    assert.ok(Date.now() - t0 < 20000, '中止後應該很快收尾');
    assert.deepEqual(r.commands.map(c => c.outcome), ['skipped', 'skipped']);
    assert.match(r.commands[0].reason, /中止/);
    assert.ok(r.notVerified.some(x => x.includes('核實已中止')));
    const { child, grand, data } = JSON.parse(readFileSync(pids, 'utf8'));
    for (let i = 0; i < 30 && (alive(child) || alive(grand)); i++) await sleep(200);
    assert.equal(alive(child), false, `子程序 ${child} 仍在`);
    assert.equal(alive(grand), false, `孫程序 ${grand} 仍在`);
    assert.ok(data && !existsSync(data), '隔離用的臨時資料夾已刪除');
  });

  await test('桌面核實:沒勾「允許桌面核實」就不跑,寫進 not_verified;勾了但沒有 worktree 也不跑;都給了才跑', async () => {
    const marker = join(BASE, 'desktop-ran.txt');
    const desk = cmd('smoke', script('desk.js', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd());`), { desktop: true });
    const r = await runVerify({ cwd: BASE, version: 'v', allowDesktop: false, commands: [cmd('a', 'node -e "process.exit(0)"'), desk] });
    assert.equal(r.outcome, 'pass');
    assert.equal(r.commands[1].outcome, 'skipped');
    assert.ok(r.notVerified.some(n => n.includes('未跑桌面核實')), JSON.stringify(r.notVerified));
    assert.ok(!existsSync(marker));
    const r2 = await runVerify({ cwd: BASE, version: 'v', allowDesktop: true, commands: [desk] });
    assert.equal(r2.commands[0].outcome, 'skipped');
    assert.ok(r2.notVerified.length === 1 && !existsSync(marker));
    const wt = join(BASE, 'wt'); mkdirSync(wt);
    const r3 = await runVerify({ cwd: BASE, version: 'v', allowDesktop: true, desktopCwd: wt, commands: [desk] });
    assert.equal(r3.commands[0].outcome, 'pass');
    assert.equal(readFileSync(marker, 'utf8'), wt);
    assert.deepEqual(r3.notVerified, []);
  });

  await test('改檔偵測:核實指令改到受版本控制的檔案會被標出來(在真的副本裡比對版本 tree)', async () => {
    const repo = join(BASE, 'repo');
    mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), 'out/\n');
    writeFileSync(join(repo, 'src.txt'), 'original\n');
    const v = await snapshot(repo);
    const copy = join(BASE, 'copies', 'v-test');
    await exportTree(repo, v, copy);
    const r = await runVerify({
      cwd: copy, version: v, allowDesktop: false, detectChanges: cwd => copyChanges(repo, cwd, v),
      commands: [
        cmd('build', 'node -e "require(\'fs\').mkdirSync(\'out\',{recursive:true});require(\'fs\').writeFileSync(\'out/x.js\',\'1\')"'),
        cmd('rewrite', 'node -e "require(\'fs\').writeFileSync(\'src.txt\',\'changed\')"'),
        cmd('noop', 'node -e "process.exit(0)"'),
      ],
    });
    // 改到受版控檔案:整組判 modified(交給使用者),不算失敗;逐指令列出是誰改了哪些檔
    assert.equal(r.outcome, 'modified');
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.modifiedBy, ['rewrite']);
    assert.deepEqual(r.commands.map(c => c.outcome), ['pass', 'pass', 'pass']);
    assert.deepEqual(r.commands.map(c => c.modified), [[], ['src.txt'], []]);
    assert.deepEqual(r.modified, ['src.txt']);
    assert.equal(readFileSync(join(repo, 'src.txt'), 'utf8'), 'original\n');
  });

  await test('log 只保留最後 64KB', async () => {
    const r = await runVerify({ cwd: BASE, version: 'v', allowDesktop: false, logDir: join(BASE, 'logs2'), commands: [cmd('big', script('big.js', 'for (let i = 0; i < 4000; i++) console.log(String(i).padStart(6, "0") + "-".repeat(60)); console.log("最後一行");'))] });
    const c = r.commands[0];
    assert.equal(c.outcome, 'pass');
    assert.equal(c.lastLine, '最後一行');
    assert.ok(statSync(c.logFile).size < 66 * 1024, `log 太大:${statSync(c.logFile).size}`);
    assert.ok(readFileSync(c.logFile, 'utf8').includes('最後一行'));
    assert.ok(!readFileSync(c.logFile, 'utf8').includes('000000---'));
  });

  await test('decodeOutput:UTF-8 照用;cmd 用主控台字碼頁(例如 950)輸出的訊息改用對應編碼解碼', async () => {
    assert.equal(decodeOutput(Buffer.from('測試 ok\n'), 950), '測試 ok\n');
    // 「不是內部」的 Big5 位元組
    const big5 = Buffer.concat([Buffer.from("'x' "), Buffer.from([0xa4, 0xa3, 0xac, 0x4f, 0xa4, 0xba, 0xb3, 0xa1])]);
    assert.equal(decodeOutput(big5, 950), "'x' 不是內部");
    assert.notEqual(decodeOutput(big5, null), "'x' 不是內部");
    assert.equal(classify(1, decodeOutput(Buffer.concat([big5, Buffer.from([0xa9, 0xce, 0xa5, 0x7e, 0xb3, 0xa1, 0xa9, 0x52, 0xa5, 0x4f])]), 950)).outcome, 'blocked');
    // 逐行判斷:同一段輸出混著 UTF-8 與 Big5,各行各自解碼,UTF-8 那幾行不會被改壞
    const mixed = Buffer.concat([Buffer.from('測試開始\n'), big5, Buffer.from('\n結束 ✓')]);
    assert.equal(decodeOutput(mixed, 950), "測試開始\n'x' 不是內部\n結束 ✓");
  });

  await test('lockedPathsFromOutput:從輸出抓出被鎖的檔案路徑', async () => {
    assert.deepEqual(lockedPathsFromOutput("Error: EBUSY: resource busy or locked, unlink 'C:\\app\\out\\main.js'\nother"), ['C:\\app\\out\\main.js']);
    assert.deepEqual(lockedPathsFromOutput('一切正常'), []);
  });

  await test('findLockers:Windows 上找得到開著檔案的程序;其他平台回傳 []', async () => {
    const file = join(BASE, 'held.txt');
    writeFileSync(file, 'x');
    if (process.platform !== 'win32') { assert.deepEqual(await findLockers([file]), []); return; }
    const holder = spawn(process.execPath, ['-e', `const fs=require('fs');fs.openSync(${JSON.stringify(file)},'r+');console.log('ready');setInterval(()=>{},1000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise(r => holder.stdout.once('data', r));
      const list = await findLockers([file]);
      // Windows 上必須找得到自己開著檔案的程序(Restart Manager)
      assert.ok(list.some(l => l.pid === holder.pid), `應找到 ${holder.pid},實際:${JSON.stringify(list)}`);
      assert.deepEqual(await findLockers([]), []);
      // 沒人開著的檔案:回傳空清單
      const free = join(BASE, 'free.txt');
      writeFileSync(free, 'x');
      assert.deepEqual(await findLockers([free]), []);
    } finally { holder.kill(); }
  });
} finally {
  await sleep(300);
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log('[test] 已刪除', BASE, existsSync(BASE) ? '(仍在!)' : '');
}

console.log(`通過 ${passed} 項`);
