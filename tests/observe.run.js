// 缺口 7 外部觀察的驗收:用假資料模式啟動主控台(tests/observe.e2e.js 在畫面裡執行),
// 從外部對 hooks 接收端送模擬的 hook 請求,並檢查暫存區裡假的 Claude Code 設定檔。
// 用法:在 app 資料夾執行 node tests/observe.run.js [--real]
//   --real:另外用真正的 Claude Code 跑一個極短的 claude -p 回合(用 --settings 帶入暫存的設定檔,不改你的設定),確認真實事件能被接收。
// 資料、截圖、設定檔都放在系統暫存區的新資料夾,連接埠隨機選,不碰 %APPDATA%\entropy-nexus 與 ~/.claude。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const app = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-observe-'));
const work = path.join(root, 'work');
const settingsFile = path.join(root, 'claude', 'settings.json');
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
const port = 47700 + Math.floor(Math.random() * 900);
const real = process.argv.includes('--real');

// 使用者原有的設定與 hooks:安裝與移除後都必須原封不動
const userSettings = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-pre' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
  },
};
fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2));

const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` — ${extra}` : ''}`); };
const lines = [];
const waiters = [];
const waitLine = (re, timeout = 90000) => new Promise((resolve, reject) => {
  const hit = lines.find(l => re.test(l));
  if (hit) { resolve(hit); return; }
  const t = setTimeout(() => reject(new Error(`等不到輸出 ${re}`)), timeout);
  waiters.push({ re, resolve: l => { clearTimeout(t); resolve(l); } });
});
const wait = ms => new Promise(r => setTimeout(r, ms));

function post(urlPath, body, headers = {}) {
  return new Promise(resolve => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let text = '';
      res.on('data', c => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', err => resolve({ status: 0, text: err.message }));
    req.end(data);
  });
}

const ours = s => JSON.stringify(s).match(/entropy-nexus-hook\/[0-9a-f]+/g) ?? [];

async function main() {
  const env = { ...process.env, NEXUS_FAKE: '1', NEXUS_DATA_DIR: path.join(root, 'profile'), NEXUS_TEST_DIR: root, NEXUS_TEST_SCRIPT: path.join(__dirname, 'observe.e2e.js'),
    NEXUS_HOOKS_PORT: String(port), NEXUS_REMOTE_PORT: String(port + 1), NEXUS_CLAUDE_SETTINGS: settingsFile, NEXUS_OBSERVE_IDLE_MS: '2500', NEXUS_OBSERVE_DROP_MS: '6000' };
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete env[k];
  delete env.NEXUS_HOOK_MANAGED;
  console.log('暫存資料夾', root, '連接埠', port);
  const child = spawn(path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe'), ['.'], { cwd: app, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  const onData = c => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!l.startsWith('[test]') && !/rror/.test(l)) continue;
      console.log('  ', l.slice(0, 400));
      lines.push(l);
      for (const w of [...waiters]) if (w.re.test(l)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(l); }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise(r => child.on('exit', r));

  const ownLine = await waitLine(/\[test\] own /);
  const ownSid = ownLine.split(' ').pop();
  const st0 = await waitLine(/\[test\] status-initial/);
  check('接收端啟動、初始未安裝', /status-initial true \d+ none ""/.test(st0), st0);
  check('啟動時沒有修改設定檔', JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))) === JSON.stringify(userSettings));

  await waitLine(/\[test\] installed current/);
  const s1 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const token = ours(s1)[0]?.split('/').pop() ?? '';
  check('安裝後每個事件一個我們的 hook', ours(s1).length === 8, `共 ${ours(s1).length} 個`);
  check('安裝後保留使用者原有的 hooks 與設定', s1.model === 'opus' && s1.permissions.allow[0] === 'Bash(ls:*)' && s1.hooks.PreToolUse[0].hooks[0].command === 'echo user-pre' && s1.hooks.Stop[0].hooks[0].command === 'echo user-stop');
  check('hook 是 http 型、只指向 127.0.0.1', s1.hooks.SessionEnd[0].hooks[0].type === 'http' && s1.hooks.SessionEnd[0].hooks[0].url === `http://127.0.0.1:${port}/entropy-nexus-hook/${token}`);
  check('安裝前有備份', fs.readdirSync(path.dirname(settingsFile)).some(f => f.endsWith('.bak')));
  await waitLine(/\[test\] installed2 current/);
  const s2 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check('重複安裝不會重複新增', ours(s2).length === 8 && s2.hooks.PreToolUse.length === 2, `共 ${ours(s2).length} 個`);

  const hookPath = `/entropy-nexus-hook/${token}`;
  const ev = (sid, name, extra = {}) => post(hookPath, { session_id: sid, transcript_path: 'x.jsonl', cwd: work, permission_mode: 'default', hook_event_name: name, ...extra });

  // 權杖與大小
  check('錯誤權杖被拒', (await post('/entropy-nexus-hook/' + '0'.repeat(token.length), { session_id: 'bad', hook_event_name: 'SessionStart' })).status === 403);
  check('沒有權杖被拒', (await post('/', { session_id: 'bad', hook_event_name: 'SessionStart' })).status === 403);
  check('GET 被拒', await new Promise(r => http.get({ host: '127.0.0.1', port, path: hookPath }, res => { res.resume(); r(res.statusCode === 403); }).on('error', () => r(false))));
  const big = await post(hookPath, JSON.stringify({ session_id: 'big', hook_event_name: 'SessionStart', pad: 'x'.repeat(300 * 1024) }));
  check('過大的 body 被拒', big.status === 413 || big.status === 0, `status ${big.status}`);

  // 完整流程
  const t0 = Date.now();
  const r1 = await ev('ext-1', 'SessionStart', { source: 'startup' });
  check('hook 回 200 空內容且很快', r1.status === 200 && r1.text === '' && Date.now() - t0 < 500, `${r1.status} ${JSON.stringify(r1.text)} ${Date.now() - t0}ms`);
  await waitLine(/obs ext-1 idle "已啟動"/);
  await ev('ext-1', 'UserPromptSubmit', { prompt: '幫我跑測試' });
  await waitLine(/obs ext-1 planning/);
  await ev('ext-1', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' });
  await waitLine(/obs ext-1 working "Bash" tool=Bash/);
  await ev('ext-1', 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  await waitLine(/obs ext-1 awaiting/);
  await waitLine(/\[test\] chime/);
  await ev('ext-1', 'Stop', { stop_hook_active: false, last_assistant_message: 'ok' });
  await waitLine(/obs ext-1 idle "回合結束"/);
  await ev('ext-1', 'SessionEnd', { reason: 'prompt_input_exit' });
  await waitLine(/obs-removed ext-1/);
  check('SessionStart → UserPromptSubmit → PreToolUse → PermissionRequest → Stop → SessionEnd 狀態依序變化並移除', true);
  const chime = lines.find(l => /\[test\] chime/.test(l));
  check('外部節點待授權時響提示音、沒有授權按鈕', /chime 1 /.test(chime) && /有授權按鈕 false/.test(chime), chime);
  const mark = lines.find(l => /儀表的外部標記/.test(l)) ?? '';
  check('外部節點列在總覽儀表:標題列有「外部 1」(警示色),展開後列出這個節點', /"外部 1"/.test(mark) && /warn/.test(mark) && /外部列 1 /.test(chime), `${mark} | ${chime}`);

  // 去重:主控台自己的 session,以及帶著 NEXUS_HOOK_MANAGED 標頭的請求
  await ev(ownSid, 'PreToolUse', { tool_name: 'Read' });
  await post(hookPath, { session_id: 'ext-managed', cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Read' }, { 'X-Nexus-Managed': '1' });
  // Notification 的 permission_prompt 也算待授權
  await ev('ext-n', 'Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' });
  await waitLine(/obs ext-n awaiting/);
  await ev('ext-n', 'SessionEnd', { reason: 'other' });
  check('主控台自己的 session 不會出現在外部清單', !lines.some(l => l.includes(`obs ${ownSid}`)));
  check('帶 managed 標頭的請求被略過', !lines.some(l => l.includes('obs ext-managed')));

  // 閒置與自動移除
  await ev('ext-3', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
  await waitLine(/obs ext-3 idle "久無動靜"/, 15000);
  await waitLine(/obs-removed ext-3/, 15000);
  check('太久沒事件:先標閒置再自動移除', true);

  // 接手
  await ev('ext-2', 'PreToolUse', { tool_name: 'TakeoverMe' });
  const taken = await waitLine(/\[test\] takeover /);
  const warn = lines.find(l => /takeover-warn/.test(l));
  check('接手前先警告外部 session 還在執行', /\/exit/.test(warn ?? ''), warn);
  check('接手後成為正式節點、從外部清單移除', /仍在外部清單 false/.test(taken) && /快照的外部清單 \[\]/.test(taken), taken);

  // 移除
  await ev('sig-uninstall', 'SessionStart');
  await waitLine(/\[test\] uninstalled none/);
  await ev('sig-uninstall', 'SessionEnd');
  const s3 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  check('移除後設定檔回到原本的內容', JSON.stringify(s3) === JSON.stringify(userSettings), JSON.stringify(s3).slice(0, 200));

  // JSON 壞掉時不覆寫
  const broken = '{ "model": "opus", "hooks": { oops ';
  fs.writeFileSync(settingsFile, broken);
  await ev('sig-broken', 'SessionStart');
  await waitLine(/\[test\] broken-done/);
  await ev('sig-broken', 'SessionEnd');
  check('JSON 壞掉時安裝被拒絕', lines.some(l => /broken-install rejected/.test(l)));
  check('JSON 壞掉時檔案沒有被改動', fs.readFileSync(settingsFile, 'utf8') === broken);

  // 真正的 Claude Code:用 --settings 帶入暫存的設定檔(內容就是主控台安裝的 hooks),跑一個極短回合
  if (real) {
    fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2));
    const realSettings = path.join(root, 'real-settings.json');
    const sh = JSON.parse(JSON.stringify(s2.hooks));
    for (const k of Object.keys(sh)) sh[k] = sh[k].filter(g => g.hooks.some(h => h.type === 'http'));
    fs.writeFileSync(realSettings, JSON.stringify({ hooks: sh }, null, 2));
    const cenv = { ...process.env };
    for (const k of Object.keys(cenv)) if (/^(CLAUDE|ANTHROPIC)/.test(k) && k !== 'ANTHROPIC_API_KEY') delete cenv[k];
    delete cenv.NEXUS_HOOK_MANAGED;
    const bin = process.env.NEXUS_CLAUDE_BIN || 'claude.exe';
    const out = await new Promise(resolve => {
      const c = spawn(bin, ['-p', 'Use the Bash tool to run exactly: echo hi   Then reply with one word: done', '--settings', realSettings, '--allowedTools', 'Bash(echo:*)', '--model', 'haiku', '--output-format', 'json'], { cwd: work, env: cenv, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '';
      c.stdout.on('data', d => (o += d));
      c.stderr.on('data', d => (o += d));
      c.on('exit', code => resolve({ code, o }));
      c.on('error', err => resolve({ code: -1, o: err.message }));
    });
    const sid = /"session_id":"([^"]+)"/.exec(out.o)?.[1] ?? '';
    console.log('   真正的 claude -p 結束', out.code, 'session', sid);
    await wait(800);
    const mine = lines.filter(l => sid && l.includes(sid));
    check('真正的 Claude Code 事件被接收並整理成外部節點', mine.some(l => / planning /.test(l)) && mine.some(l => /working "Bash"/.test(l)) && mine.some(l => /obs-removed/.test(l)), mine.join(' || ').slice(0, 600));
  }

  await ev('sig-quit', 'SessionStart');
  await Promise.race([exited, wait(20000)]);
  const done = lines.some(l => l.includes('全部步驟完成'));
  check('畫面腳本全部步驟完成', done);
  if (child.exitCode === null) child.kill();
  console.log(`\n${results.filter(Boolean).length}/${results.length} 通過。截圖在 ${root}`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

main().catch(err => { console.log('FAIL', err.message); process.exit(1); });
