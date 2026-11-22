// 統一的測試入口:依組別逐一執行 tests/ 裡的測試,判斷成敗並彙整。
//
// 用法:node tools/run-tests.mjs <組別> [--only 名稱,名稱] [--no-build] [--list]
//   unit   單元測試(node 直接跑,不需要建置)                     npm test
//   core   核心的假資料驗收腳本(每次 PR 在 CI 上跑)               npm run test:core
//   e2e    全部假資料驗收腳本(CI 每週跑一次)                      npm run test:e2e
//   local  需要本機 Python 與語音模型(語音辨識、語音合成)         npm run test:local
//   real   需要真正的 CLI,會花額度                                npm run test:real
//   all    unit + e2e
// 驗收腳本跑的是建置後的 out/,所以 core、e2e、local、real 會先 npm run build(--no-build 可略過)。
//
// 成敗判斷(各腳本的輸出格式不一,用共同的字眼判斷):
//   結束代碼不是 0、或輸出有「不符」「失敗」「等不到」「有 N 項不符」→ 失敗;
//   否則要看到「通過」或 PASS 才算成功,什麼都沒看到也算失敗(避免腳本壞掉卻被當成通過)。
// 每支測試的完整輸出存在系統暫存區的 nexus-test-runs\<組別-時間>\<名稱>.log(可用 NEXUS_TEST_LOGS 指定),結果另存成 summary.json。
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const node = (file, ...args) => ({ cmd: process.execPath, args: ['--no-warnings', file, ...args] });
const bash = file => ({ cmd: 'bash', args: [file] });

/** 測試清單。min 是預估分鐘數(只用來顯示),timeout 是逾時分鐘數。 */
const SUITES = [
  // ---- 單元測試
  { name: 'script-syntax', group: 'unit', min: 0.1, ...node('tests/script-syntax.test.mjs') },
  { name: 'markdown', group: 'unit', min: 0.1, ...node('tests/markdown.test.mjs') },
  { name: 'project-choice', group: 'unit', min: 0.1, ...node('tests/project-choice.test.mjs') },
  { name: 'board-layout', group: 'unit', min: 0.1, ...node('tests/board-layout.test.mjs') },
  { name: 'voice-summary', group: 'unit', min: 0.1, ...node('tests/voice-summary.test.mjs') },
  { name: 'agy-allow', group: 'unit', min: 0.1, ...node('tests/agy-allow.test.mjs') },
  { name: 'mcp-schema', group: 'unit', min: 0.1, ...node('tests/mcp-schema.test.mjs') },
  { name: 'memory-write', group: 'unit', min: 0.1, ...node('tests/memory-write.test.mjs') },
  { name: 'meeting-record', group: 'unit', min: 0.1, ...node('tests/meeting-record.test.mjs') },
  { name: 'speech-clips-unit', group: 'unit', min: 0.1, ...node('tests/speech-clips.test.mjs') },
  { name: 'window-size', group: 'unit', min: 0.1, ...node('tests/window-size.test.mjs') },
  { name: 'review-prompt', group: 'unit', min: 0.1, ...node('tests/review-prompt.test.mjs') },
  { name: 'dashboard-unit', group: 'unit', min: 0.1, ...node('tests/dashboard.test.mjs') },
  { name: 'claude-content', group: 'unit', min: 0.1, fixtures: true, ...node('tests/claude-content.test.mjs') },
  { name: 'node-stats', group: 'unit', min: 0.1, ...node('tests/node-stats.test.mjs') },
  { name: 'memory-vault', group: 'unit', min: 0.2, ...node('tests/memory-vault.test.mjs') },
  { name: 'case-library', group: 'unit', min: 0.2, ...node('tests/case-library.test.mjs') },
  { name: 'memory-read', group: 'unit', min: 0.2, ...node('tests/memory-read.test.mjs') },
  { name: 'memory-draft-unit', group: 'unit', min: 0.2, ...node('tests/memory-draft.test.mjs') },
  { name: 'memory-tools', group: 'unit', min: 0.2, ...node('tests/memory-tools.test.mjs') },
  { name: 'memory-archive-unit', group: 'unit', min: 0.1, ...node('tests/memory-archive.test.mjs') },
  { name: 'vault-integration', group: 'unit', min: 0.2, ...node('tests/vault-integration.test.mjs') },
  { name: 'project', group: 'unit', min: 0.3, ...node('tests/project.test.mjs') },
  { name: 'collab-unit', group: 'unit', min: 0.1, ...node('tests/collab.test.mjs') },
  { name: 'acp', group: 'unit', min: 0.5, ...node('tests/acp.test.js') },
  { name: 'worktree-setup-unit', group: 'unit', min: 0.5, ...node('tests/worktree-setup.test.js') },
  // ---- 假資料驗收腳本(core 是 e2e 的子集合,每次 PR 都跑)
  { name: 'interop', group: 'e2e', core: true, min: 1, ...bash('tests/interop.sh') },
  { name: 'meeting', group: 'e2e', core: true, min: 1, ...bash('tests/meeting.sh') },
  { name: 'chief', group: 'e2e', core: true, min: 1, ...bash('tests/chief.sh') },
  { name: 'voice-speech', group: 'e2e', core: true, min: 1.5, ...bash('tests/voice-speech.sh') },
  { name: 'queue-fake', group: 'e2e', core: true, min: 1.5, ...bash('tests/queue-fake.sh') },
  { name: 'speech-clips', group: 'e2e', core: true, min: 1, ...bash('tests/speech-clips.sh') },
  { name: 'dashboard', group: 'e2e', core: true, min: 1.5, ...bash('tests/dashboard.sh') },
  { name: 'memory-phase1', group: 'e2e', core: true, min: 1.5, ...bash('tests/memory-phase1.sh') },
  { name: 'case-library', group: 'e2e', core: true, min: 1.5, ...bash('tests/case-library.sh') },
  { name: 'memory-draft', group: 'e2e', core: true, min: 1.5, ...bash('tests/memory-draft.sh') },
  { name: 'memory-phase2', group: 'e2e', core: true, min: 1, ...bash('tests/memory-phase2.sh') },
  { name: 'collab', group: 'e2e', core: true, min: 1.5, ...bash('tests/collab.sh') },
  { name: 'memory-archive', group: 'e2e', core: true, min: 2, ...bash('tests/memory-archive.sh') },
  { name: 'access', group: 'e2e', min: 2, ...bash('tests/access.sh') },
  { name: 'access-ui', group: 'e2e', min: 2, ...bash('tests/access-ui.sh') },
  { name: 'attachments', group: 'e2e', min: 2, ...bash('tests/attachments.sh') },
  { name: 'avatar', group: 'e2e', min: 1, ...bash('tests/avatar.sh') },
  { name: 'dialog-expand', group: 'e2e', min: 1, ...bash('tests/dialog-expand.sh') },
  { name: 'media', group: 'e2e', min: 2, ...bash('tests/media.sh') },
  { name: 'observe', group: 'e2e', min: 1.5, ...node('tests/observe.run.js') },
  { name: 'persona-fake', group: 'e2e', min: 1.5, ...bash('tests/persona-fake.sh') },
  { name: 'reveal', group: 'e2e', min: 1, ...bash('tests/reveal.sh') },
  { name: 'review-comments', group: 'e2e', min: 1.5, ...bash('tests/review-comments.sh') },
  { name: 'web-full', group: 'e2e', min: 2, ...bash('tests/web-full.sh') },
  { name: 'worktree-setup', group: 'e2e', min: 1, ...bash('tests/worktree-setup.sh') },
  { name: 'layout', group: 'e2e', min: 6, timeout: 15, ...bash('tests/layout.sh') },
  { name: 'layout-web', group: 'e2e', min: 6, timeout: 15, cmd: 'bash', args: ['-c', 'LAYOUT_WEB=1 bash tests/layout.sh'] },
  // ---- 需要本機語音環境
  { name: 'voice', group: 'local', min: 2, ...bash('tests/voice.sh') },
  { name: 'voice-tts', group: 'local', min: 3, ...bash('tests/voice-tts.sh') },
  { name: 'voice-offload', group: 'local', min: 4, timeout: 25, ...node('tests/voice-offload.mjs') },
  // ---- 需要真正的 CLI(會花額度)
  { name: 'interop-real', group: 'real', min: 5, ...bash('tests/interop-real.sh') },
  { name: 'meeting-real', group: 'real', min: 8, ...bash('tests/meeting-real.sh') },
  { name: 'chief-real', group: 'real', min: 45, timeout: 80, ...bash('tests/chief-real.sh') },
  { name: 'bg-subagent', group: 'real', min: 5, ...bash('tests/bg-subagent.sh') },
  { name: 'agy-attach', group: 'real', min: 5, ...bash('tests/agy-attach.sh') },
  { name: 'stage7', group: 'real', min: 5, ...bash('tests/stage7.sh') },
  { name: 'kill-test', group: 'real', min: 3, ...bash('tests/kill-test.sh') },
];

const BAD = /不符|等不到|有 \d+ 項不符|(^|[\]\s])失敗[\s::]|\bFAIL(ED)?\b|Traceback \(most recent/m;
const GOOD = /通過|\bPASS\b/;

function judge(code, out) {
  if (code !== 0) return { ok: false, why: `結束代碼 ${code}` };
  const bad = out.split(/\r?\n/).find(l => BAD.test(l));
  if (bad) return { ok: false, why: bad.trim().slice(0, 160) };
  if (!GOOD.test(out)) return { ok: false, why: '沒有看到「通過」(腳本可能沒有執行完)' };
  return { ok: true, why: '' };
}

function pick(group) {
  if (group === 'unit') return SUITES.filter(s => s.group === 'unit');
  if (group === 'core') return SUITES.filter(s => s.core);
  if (group === 'e2e') return SUITES.filter(s => s.group === 'e2e');
  if (group === 'local') return SUITES.filter(s => s.group === 'local');
  if (group === 'real') return SUITES.filter(s => s.group === 'real');
  if (group === 'all') return SUITES.filter(s => s.group === 'unit' || s.group === 'e2e');
  return null;
}

function run(suite, logDir, extraArgs) {
  return new Promise(done => {
    const t0 = Date.now();
    const chunks = [];
    const p = spawn(suite.cmd, [...suite.args, ...extraArgs], { cwd: ROOT, env: { ...process.env, PYTHONUTF8: '1' }, windowsHide: true });
    const timer = setTimeout(() => { chunks.push(Buffer.from('\n[runner] 逾時,強制結束\n')); p.kill(); }, (suite.timeout ?? Math.max(10, suite.min * 4)) * 60000);
    p.stdout.on('data', d => chunks.push(d));
    p.stderr.on('data', d => chunks.push(d));
    p.on('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString('utf8');
      writeFileSync(join(logDir, `${suite.name}.log`), out);
      done({ name: suite.name, group: suite.group, secs: Math.round((Date.now() - t0) / 1000), ...judge(code ?? 1, out) });
    });
    p.on('error', err => { clearTimeout(timer); done({ name: suite.name, group: suite.group, secs: 0, ok: false, why: `無法執行:${err.message}` }); });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const group = argv[0];
  const list = pick(group);
  if (!list) {
    console.log('用法:node tools/run-tests.mjs <unit|core|e2e|local|real|all> [--only 名稱,名稱] [--no-build] [--list]');
    process.exit(2);
  }
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
  const suites = only ? list.filter(s => only.includes(s.name)) : list;
  if (argv.includes('--list')) {
    for (const s of suites) console.log(`${s.name.padEnd(22)} ${s.group.padEnd(6)} 約 ${s.min} 分鐘  ${s.args.at(-1)}`);
    return;
  }
  if (group !== 'unit' && !argv.includes('--no-build')) {
    console.log('[runner] 建置 out/ …');
    const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (b.status !== 0) { console.log('[runner] 建置失敗'); process.exit(1); }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // CI 用 NEXUS_TEST_LOGS 指定紀錄位置,方便上傳
  const logDir = join(process.env.NEXUS_TEST_LOGS || join(tmpdir(), 'nexus-test-runs'), `${group}-${stamp}`);
  mkdirSync(logDir, { recursive: true });
  console.log(`[runner] ${group}:${suites.length} 支,預估 ${Math.ceil(suites.reduce((n, s) => n + s.min, 0))} 分鐘;紀錄在 ${logDir}`);
  const results = [];
  for (const s of suites) {
    process.stdout.write(`[runner] ${s.name} … `);
    const extra = s.fixtures ? [mkdtempSync(join(tmpdir(), 'nexus-fixtures-'))] : [];
    if (s.fixtures) spawnSync(process.execPath, ['tests/attachments-fixtures.mjs', extra[0]], { cwd: ROOT });
    const r = await run(s, logDir, extra);
    results.push(r);
    console.log(r.ok ? `通過(${r.secs} 秒)` : `失敗(${r.secs} 秒):${r.why}`);
  }
  const bad = results.filter(r => !r.ok);
  writeFileSync(join(logDir, 'summary.json'), JSON.stringify({ group, results }, null, 1));
  console.log(`\n[runner] ${group}:${results.length - bad.length}/${results.length} 通過${bad.length ? `;失敗:${bad.map(r => r.name).join('、')}` : ''}`);
  console.log(`[runner] 紀錄:${logDir}`);
  process.exit(bad.length ? 1 : 0);
}

main();
