// 驗收:協作流程範圍合約的攔截判斷(src/main/flow/guard.ts,里程碑 M3):
// 禁止動作的範圍(扣掉授權)、從工具事件拆出指令與寫入路徑、L1/L2 的命中判斷(引號內當資料、註解與 heredoc 不算、豁免流程自己的資料夾)、
// install 只看執行與寫入、受保護的資料夾只管寫入(讀取只記紀錄)、環境變數與 Git Bash 路徑寫法、被忽略的建置產出與資料夾指紋。
// 用法:在 app 資料夾執行 node tests/flow-guard.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlow } from '../src/main/flow/definition.ts';
import {
  actionKey, actionTexts, artifactPaths, dirFingerprint, effectiveForbidden, expandPaths, fingerprintDiff, guardFingerprint, isBlocking, isNexusTool,
  mentionedRoots, scanAction, scrubRoots, splitGuardDiff, treeSummary,
} from '../src/main/flow/guard.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const FLOW = parseFlow(readFileSync(new URL('../src/main/flow/templates/implement-review.yaml', import.meta.url), 'utf8'), 'builtin').flow;

// 假的資料夾配置(Windows 路徑;比對不分大小寫、斜線方向不拘)
const HOME = 'C:\\Users\\me';
const APPDATA = `${HOME}\\AppData\\Roaming`;
const DATA = `${APPDATA}\\entropy-nexus`;
const FLOWS = `${DATA}\\flows`;
const VAULT = 'D:\\vault';
const RUN = `${DATA}\\runs\\20261123-abcd1234`;
const COPY = `${RUN}\\copies\\r-0123abcd-5`;
const ENV = { APPDATA, LOCALAPPDATA: `${HOME}\\AppData\\Local`, USERPROFILE: HOME };
const ctx = (over = {}) => ({
  forbidden: effectiveForbidden(FLOW),
  protectedRoots: [FLOWS, DATA],
  vaultRoots: [VAULT],
  readExempt: [RUN],
  writeExempt: [COPY],
  cwd: 'C:\\repo',
  env: ENV,
  ...over,
});
const bash = command => ({ tool: 'Bash', summary: command.slice(0, 80), detail: JSON.stringify({ command, description: 'x' }, null, 2) });
const write = file_path => ({ tool: 'Write', summary: 'x', detail: JSON.stringify({ file_path, content: '' }) });
/** 會擋下的命中;只有讀取紀錄或沒命中都回傳 null。 */
const block = (input, c = ctx()) => { const s = scanAction(input, c); return isBlocking(s) ? s : null; };

test('effectiveForbidden:流程定義的禁止動作加上 install、real_vault 與永遠禁止的動作;授權只扣掉高風險動作', () => {
  const all = effectiveForbidden(FLOW);
  for (const a of ['commit', 'push', 'dist', 'install', 'real_vault', 'merge_pr', 'approve_pr', 'force_push', 'delete_branch']) assert.ok(all.includes(a), a);
  const pushOk = effectiveForbidden(FLOW, ['push']);
  assert.ok(!pushOk.includes('push') && pushOk.includes('force_push') && pushOk.includes('delete_branch') && pushOk.includes('commit'), JSON.stringify(pushOk));
});

test('actionTexts:Claude 的 JSON 明細、Codex 的純文字指令、讀檔工具的路徑不算寫入', () => {
  assert.deepEqual(actionTexts('Bash', 'git push', JSON.stringify({ command: 'git push origin main' })), { commands: ['git push origin main'], paths: [] });
  assert.deepEqual(actionTexts('Shell', 'git push', 'git push origin main\ncwd: C:\\repo\n原因: 需要上傳'), { commands: ['git push origin main'], paths: [] });
  assert.deepEqual(actionTexts('Shell', '', JSON.stringify({ command: ['bash', '-lc', 'git commit -m x'] })).commands, ['bash -lc git commit -m x']);
  assert.deepEqual(actionTexts('Write', 'x.yaml', JSON.stringify({ file_path: 'C:\\a\\flows\\x.yaml', content: 'git push' })), { commands: [], paths: ['C:\\a\\flows\\x.yaml'] });
  assert.deepEqual(actionTexts('Read', 'x', JSON.stringify({ file_path: 'C:\\a\\flows\\x.yaml' })), { commands: [], paths: [] }, '讀檔不算寫入');
  assert.deepEqual(actionTexts('run_command', '', JSON.stringify({ CommandLine: 'npm run dist', Cwd: 'C:\\repo' })).commands, ['npm run dist']);
});

test('必修 2:主控台自己的 MCP 工具不比對;其他非指令工具只看明細頂層的指令欄位', () => {
  const report = JSON.stringify({ assignment_id: 'a1', summary: '完成', commands_run: [{ command: 'git push origin main', result: '沒有執行' }, { command: 'npm run dist', result: '-' }] });
  assert.ok(isNexusTool('mcp__nexus__step_report') && isNexusTool('MCP', 'nexus/step_report') && !isNexusTool('MCP', 'github/create_pr'));
  assert.equal(scanAction({ tool: 'mcp__nexus__step_report', summary: 'a1', detail: report }, ctx()), null, 'Claude 的 step_report');
  assert.equal(scanAction({ tool: 'MCP', summary: 'nexus/step_report', detail: report }, ctx()), null, 'Codex 的 MCP step_report');
  assert.equal(scanAction({ tool: 'mcp__nexus__ask_node', summary: 'x', detail: JSON.stringify({ node: 'b', text: '請執行 git commit', command: 'git commit' }) }, ctx()), null, 'ask_node');
  // 其他 MCP 工具:巢狀的 command 不比對,頂層的才比
  assert.equal(scanAction({ tool: 'mcp__other__run', summary: 'x', detail: JSON.stringify({ steps: [{ command: 'git push' }] }) }, ctx()), null);
  assert.deepEqual(block({ tool: 'mcp__other__run', summary: 'x', detail: JSON.stringify({ command: 'git push' }) })?.actions, ['push']);
});

test('scanAction:git push、git -C x commit、npm run dist 命中;引號內的字串、git commit-tree 不命中', () => {
  assert.deepEqual(block(bash('git push origin main'))?.actions, ['push']);
  assert.deepEqual(block(bash('git -C ../x commit -m "a"'))?.actions, ['commit']);
  assert.deepEqual(block(bash('npm run dist'))?.actions, ['dist']);
  assert.ok(block(bash('git push --force origin main'))?.actions.includes('force_push'));
  assert.equal(scanAction(bash('rg "git push" src'), ctx()), null, '引號內是資料');
  assert.equal(scanAction(bash('git commit-tree abc -m x'), ctx()), null);
  assert.equal(scanAction(bash('npm test'), ctx()), null);
  assert.ok(block(bash('bash -c "git push"'))?.actions.includes('push'), '交給 shell 執行的引號內容仍比對');
  assert.deepEqual(block({ tool: 'Bash', summary: 'git push', detail: '' })?.actions, ['push'], '沒有明細時用摘要');
  // Codex 的指令常帶外層 pwsh 的完整路徑:pwsh 不算安裝,裡面的指令照樣比對
  assert.equal(scanAction(bash(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status'`), ctx()), null);
  assert.deepEqual(block(bash(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "git push origin main"`))?.actions, ['push']);
});

test('必修 1:install 只看「執行」安裝檔與「寫入」安裝位置;只是提到不算', () => {
  for (const m of [
    `"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command 'git status'`,
    'ls "/c/Program Files/nodejs"',
    'rg "Program Files" src',
    'cat src/foo.msi.json',
    'cp "/c/Program Files/App/a.dll" ./lib/',
    'dir "%LOCALAPPDATA%\\Programs"',
    'node tools/setup-env.js',
    'Get-Content "C:\\Program Files\\App\\config.json"',
  ]) assert.equal(block(bash(m)), null, m);
  for (const h of [
    '.\\EntropyNexus-Setup-0.3.0.exe /S',
    '& "C:\\Users\\me\\Downloads\\App Setup 1.2.exe" /S',
    'msiexec /i x.msi /qn',
    'Start-Process .\\tool.msi',
    'Start-Process -FilePath "release\\Entropy Nexus Setup 0.3.0.exe" -ArgumentList /S',
    'copy a.dll "C:\\Program Files\\App\\"',
    'echo x > "C:\\Program Files\\App\\a.txt"',
    'Copy-Item -Path a.dll -Destination "$env:LOCALAPPDATA\\Programs\\app"',
    'xcopy dist %LOCALAPPDATA%\\Programs\\entropy-nexus /s',
    'robocopy out "C:\\Program Files\\App" /E',
    'Remove-Item "C:\\Program Files\\App\\old.dll"',
  ]) assert.deepEqual(block(bash(h))?.actions, ['install'], h);
  assert.deepEqual(block(write('C:\\Program Files\\App\\app.exe'))?.actions, ['install'], '寫檔工具寫入安裝位置');
});

test('必修 3:Codex 的 Patch 用結構化路徑;diff 內容(含空行、Program Files、userData 路徑)不當成路徑', () => {
  const detail = `src/a.ts\n+// 安裝到 Program Files\n\n+const p = '${DATA}\\settings.json';\n\nC:\\Program Files\\App\n+x`;
  assert.equal(scanAction({ tool: 'Patch', summary: 'update a.ts', detail, paths: ['C:\\repo\\src\\a.ts'] }, ctx()), null, '有結構化路徑');
  assert.equal(scanAction({ tool: 'Patch', summary: 'update a.ts', detail }, ctx()), null, '沒有結構化路徑時只信第一行');
  assert.ok(block({ tool: 'Patch', summary: 'x.yaml', detail: 'x.yaml\n+id: x', paths: [`${FLOWS}\\x.yaml`] })?.protected.length, '結構化路徑寫到 flows/');
  // 檔案修改的授權請求:完整路徑與要求寫入的資料夾
  assert.deepEqual(block({ tool: 'Patch', summary: 'add a', detail: 'C:\\repo\\a.txt\n原因: x\n要求寫入: C:\\Program Files\\App', paths: ['C:\\repo\\a.txt', 'C:\\Program Files\\App'] })?.actions, ['install']);
  // ACP:明細被截斷時,寫入路徑由轉接器另外帶;指令盡量從截斷的 JSON 取出
  const truncated = `{\n  "content": "${'x'.repeat(50)}`;
  assert.ok(block({ tool: 'edit', summary: 'a.yaml', detail: truncated, paths: [`${FLOWS}\\a.yaml`] })?.protected.length);
  assert.deepEqual(block({ tool: 'execute', summary: 'x', detail: '{\n  "command": "git push origin ma' })?.actions, ['push']);
});

test('必修 4:用 .. 跳出豁免資料夾不算豁免;路徑正規化後再判斷', () => {
  assert.ok(block(bash(`echo x > ${RUN}\\..\\..\\settings.json`))?.protected.includes(DATA));
  assert.ok(block(write(`${COPY}\\..\\..\\..\\..\\settings.json`))?.protected.includes(DATA), '寫入工具的路徑也正規化');
  assert.equal(scrubRoots(`type ${RUN}\\..\\..\\nexus.db`, [RUN]), `type ${RUN}\\..\\..\\nexus.db`);
  assert.equal(scrubRoots(`type ${RUN}\\reports\\..\\a.md`, [RUN]), 'type <流程資料>\\reports\\..\\a.md');
  assert.ok(scanAction(bash(`type ${RUN}\\..\\..\\nexus.db`), ctx())?.reads.includes(DATA), '跳出後的讀取會記紀錄');
});

test('建議 6:受保護的資料夾只管寫入;讀取只記紀錄(不擋)', () => {
  const r = scanAction(bash(`type ${DATA}\\nexus.db`), ctx());
  assert.ok(r && !isBlocking(r) && r.reads.includes(DATA), JSON.stringify(r));
  assert.ok(!isBlocking(scanAction(bash(`cat "${FLOWS}\\x.yaml"`), ctx())));
  assert.ok(block(bash(`echo x > "${FLOWS}\\a.yaml"`))?.protected.length, '寫入擋');
  assert.ok(block(bash(`Set-Content -Path "${DATA}\\settings.json" -Value x`))?.protected.length);
  assert.ok(block(bash(`rm -rf ${FLOWS}`))?.protected.length, '刪除也算寫入');
  assert.ok(block(write(`${FLOWS}\\evil.yaml`))?.protected.length);
  assert.equal(scanAction(bash(`cd "${COPY}" && npm test`), ctx()), null, '流程自己的資料夾連紀錄都不記');
  assert.equal(block(write(`${COPY}\\src\\a.ts`)), null, '審查副本可以寫');
  assert.ok(block(write(`${RUN}\\reports\\x.json`))?.protected.length, '回報檔不能寫');
  assert.equal(scanAction(bash('dir C:\\Users\\me\\AppData\\Roaming\\entropy-nexus-dev'), ctx()), null, '相鄰名稱不算');
});

test('建議 6:環境變數、~、Git Bash 的 /c/… 寫法都展開;授權 real_vault 仍擋主控台設定資料夾', () => {
  assert.equal(expandPaths('%APPDATA%\\entropy-nexus $env:APPDATA ~/x /c/Users/me', ENV), `${APPDATA}\\entropy-nexus ${APPDATA} ${HOME}/x C:/Users/me`);
  assert.equal(expandPaths('$null $(pwd) %UNKNOWN%', ENV), '$null $(pwd) %UNKNOWN%');
  assert.ok(block(bash('echo x > /c/Users/me/AppData/Roaming/entropy-nexus/flows/a.yaml'))?.protected.length, 'Git Bash 寫法的 flows/');
  assert.deepEqual(block(bash('echo x >> /d/vault/note.md'))?.actions, ['real_vault'], 'Git Bash 寫法的記憶庫');
  assert.equal(block(bash('echo x > /c/Users/me/AppData/Roaming/entropy-nexus/runs/20261123-abcd1234/copies/r-0123abcd-5/a.txt')), null, 'Git Bash 寫法的審查副本');
  assert.equal(scanAction(bash('cat ~/AppData/Roaming/entropy-nexus/runs/20261123-abcd1234/reports/a.md'), ctx()), null, '~ 寫法的流程資料夾');
  const open = ctx({ forbidden: effectiveForbidden(FLOW, ['real_vault']), readExempt: [RUN, VAULT], writeExempt: [COPY, VAULT] });
  assert.equal(block(bash(`echo x >> ${VAULT}\\note.md`), open), null, '授權後可以寫記憶庫');
  for (const c of ['echo x > $env:APPDATA\\entropy-nexus\\settings.json', 'del %APPDATA%\\entropy-nexus\\settings.json', 'echo x > ~/AppData/Roaming/entropy-nexus/a.json']) {
    assert.ok(block(bash(c), open)?.protected.includes(DATA), c);
  }
  assert.ok(block(write(`${FLOWS}\\a.yaml`), open)?.protected.length, '授權記憶庫也不能寫流程定義資料夾');
  assert.deepEqual(block(bash(`echo x >> ${VAULT}\\note.md`))?.actions, ['real_vault'], '沒授權不能寫記憶庫');
});

test('建議 7:heredoc 內容與 # 註解不當成指令(heredoc 餵給 shell 例外)', () => {
  assert.equal(block(bash("cat > notes.md <<'EOF'\ngit push origin main\nnpm run dist\nEOF")), null);
  assert.equal(block(bash('cat <<-EOF > a.txt\n\tgit commit -m x\n\tEOF\necho done')), null);
  assert.deepEqual(block(bash('bash <<EOF\ngit push\nEOF'))?.actions, ['push']);
  assert.deepEqual(block(bash("cat > a.txt <<'EOF'\nx\nEOF\ngit push"))?.actions, ['push'], 'heredoc 結束後的指令照樣比對');
  assert.equal(block(bash('npm test # 之後再 git push')), null);
  assert.equal(block(bash('git status  # git commit -m x')), null);
  assert.equal(block(bash('# git push\nnpm test')), null);
  assert.deepEqual(block(bash('echo a#b && git push'))?.actions, ['push'], '詞中間的 # 不是註解');
});

test('建議 5:同一個指令的工具啟動與授權請求得到相同的比對鍵(L1 只取消同一個指令的 L2)', () => {
  const cmd = 'git push origin main';
  const t = scanAction(bash(cmd), ctx());
  const a = scanAction({ tool: 'Bash', summary: cmd, detail: JSON.stringify({ command: cmd, description: '推送' }, null, 2) }, ctx());
  assert.deepEqual(t.items.map(actionKey), a.items.map(actionKey));
  const other = scanAction(bash('git commit -m x'), ctx());
  assert.notDeepEqual(other.items.map(actionKey), t.items.map(actionKey));
});

test('scrubRoots、mentionedRoots:斜線方向與大小寫不拘,不比到相鄰名稱', () => {
  assert.equal(scrubRoots('cd c:/users/me/appdata/roaming/entropy-nexus/runs/20261123-abcd1234/copies', [RUN]), 'cd <流程資料>/copies');
  assert.deepEqual(mentionedRoots('x C:\\Users\\me\\AppData\\Roaming\\entropy-nexus\\flows\\a', [FLOWS, DATA]), [FLOWS, DATA]);
  assert.deepEqual(mentionedRoots('x C:\\Users\\me\\AppData\\Roaming\\entropy-nexus2', [DATA]), []);
});

test('artifactPaths:預設 dist/、release/(任何一層),專案可以改', () => {
  assert.deepEqual(artifactPaths(['dist/', 'release/x.exe', 'out/', 'packages/a/dist/', 'node_modules/', 'distance.txt', 'src/dist']), ['dist/', 'release/x.exe', 'packages/a/dist/']);
  assert.deepEqual(artifactPaths(['dist/', 'release/x.exe', 'build/out/a.exe'], ['build/out']), ['build/out/a.exe']);
  assert.deepEqual(artifactPaths(['dist/'], []), [], '空清單表示不比對');
});

test('資料夾指紋:flows/、主控台設定資料夾頂層的設定檔、建置產出(含深層檔案);資料庫與程序清單不算', () => {
  const T = mkdtempSync(join(tmpdir(), 'nexus-flow-guard-'));
  try {
    const data = join(T, 'data');
    const flows = join(data, 'flows');
    const repo = join(T, 'repo');
    mkdirSync(flows, { recursive: true });
    mkdirSync(join(repo, 'release', 'win-unpacked', 'resources', 'app'), { recursive: true });
    writeFileSync(join(flows, 'projects.yaml'), 'a: 1\n');
    writeFileSync(join(data, 'settings.json'), '{}');
    writeFileSync(join(data, 'nexus.db'), 'db');
    writeFileSync(join(data, 'children.json'), '[]');
    writeFileSync(join(repo, 'release', 'old.exe'), 'x');
    writeFileSync(join(repo, 'release', 'win-unpacked', 'resources', 'app', 'main.js'), '1');
    const fp = () => guardFingerprint({ flowsDir: flows, repoDirs: [repo, repo], dataDir: data });
    const before = fp();
    assert.ok(before['data/settings.json'] && !before['data/nexus.db'] && !before['data/children.json'], JSON.stringify(before));
    writeFileSync(join(flows, 'evil.yaml'), 'id: evil\n');
    writeFileSync(join(data, 'settings.json'), '{"x":1}');
    writeFileSync(join(data, 'nexus.db'), 'db2');
    writeFileSync(join(data, 'children.json'), '[1]');
    writeFileSync(join(repo, 'release', 'old.exe'), 'xyz');
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'app.js'), '1');
    const diff = splitGuardDiff(fingerprintDiff(before, fp()));
    assert.deepEqual(diff.flows, ['flows/evil.yaml']);
    assert.deepEqual(diff.data, ['userData/settings.json']);
    assert.ok(diff.artifacts.includes('dist/app.js') && diff.artifacts.includes('release/old.exe'), JSON.stringify(diff.artifacts));
    // 深層檔案的修改:明細(往下 2 層)看不到,整棵樹的摘要看得到
    const b2 = fp();
    const t = new Date(Date.now() + 120000);
    writeFileSync(join(repo, 'release', 'win-unpacked', 'resources', 'app', 'main.js'), '22');
    utimesSync(join(repo, 'release', 'win-unpacked', 'resources', 'app', 'main.js'), t, t);
    assert.deepEqual(splitGuardDiff(fingerprintDiff(b2, fp())).artifacts, ['release/(深層檔案)']);
    // 專案設定的產出資料夾
    const custom = guardFingerprint({ flowsDir: flows, repoDirs: [repo], artifactDirs: ['release/win-unpacked'] });
    assert.ok(Object.keys(custom).some(k => k.startsWith('repo/release/win-unpacked/')) && !Object.keys(custom).some(k => k.startsWith('repo/dist/')));
    assert.equal(treeSummary(join(T, 'nope')), '');
    // 只改修改時間也算
    const fp1 = dirFingerprint(flows, 'flows/');
    utimesSync(join(flows, 'projects.yaml'), t, t);
    assert.deepEqual(fingerprintDiff(fp1, dirFingerprint(flows, 'flows/')), ['flows/projects.yaml']);
    assert.deepEqual(dirFingerprint(join(T, 'nope'), 'x/'), {}, '資料夾不存在 → 空');
  } finally { rmSync(T, { recursive: true, force: true }); }
});

console.log(`通過 ${passed} 項`);
