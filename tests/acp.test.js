// AcpAdapter 的自動化測試:對假的 ACP agent(acp-fake-agent.js)跑,不啟動真正的 CLI、不花額度。
// 執行:在 app/ 下 `node tests/acp.test.js`。會先用 rolldown 把 src/main/adapters/acp.ts 打包到系統暫存區。
// 設定 NEXUS_ACP_REAL=1 時另外對真正的 `agy acp` 做最小實測(會花少量額度;NEXUS_AGY_BIN 可指定執行檔)。
const { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const APP = resolve(__dirname, '..');
const FAKE = join(__dirname, 'acp-fake-agent.js');
const work = mkdtempSync(join(tmpdir(), 'nexus-acp-test-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(ok ? '通過' : '失敗', name, ok ? '' : extra); };

async function load() {
  const { build } = require('rolldown');
  const out = join(work, 'acp.mjs');
  await build({ input: join(APP, 'src/main/adapters/acp.ts'), platform: 'node', external: [/^node:/], output: { file: out, format: 'esm' }, logLevel: 'silent' });
  return import(pathToFileURL(out).href);
}

/** 啟動一個 session,回傳事件紀錄與等待工具。 */
function open(mod, cfg, opts = {}) {
  const events = [];
  const session = new mod.AcpSession(cfg, { agentId: 'a1', cwd: work, permissionMode: 'ask', model: '', sessionId: null, persona: '', ...opts }, (e, subId) => events.push(subId ? { ...e, subId } : e));
  const until = async (what, fn, timeout = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { const v = fn(events); if (v) return v; await wait(20); }
    throw new Error(`等不到:${what}\n${JSON.stringify(events, null, 1).slice(-3000)}`);
  };
  const idleCount = () => events.filter(e => e.type === 'state' && e.state === 'idle').length;
  return { events, session, until, idleCount };
}

function fakeCfg(extraEnv = {}, logFile) {
  return { backend: 'antigravity', label: 'fake', bin: process.execPath, args: [FAKE], procKind: 'agy', env: { ...extraEnv, ...(logFile ? { FAKE_LOG: logFile } : {}) } };
}
const received = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];

async function fakeTests(mod) {
  // 1. 新對話:session 事件、串流片段、訊息切段、計畫、工具、子代理、用量
  {
    const logFile = join(work, 't1.log');
    const s = open(mod, fakeCfg({}, logFile), { persona: '你叫測試一號', model: 'm-1' });
    await s.until('待命', () => s.idleCount() >= 1);
    check('新對話回報 session id', s.events.some(e => e.type === 'session' && e.sessionId === 'sess-new-1'));
    const img = join(work, 'dot.png');
    writeFileSync(img, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    s.session.send('hello', [img]);
    await s.until('回合結束', () => s.idleCount() >= 2);
    const ev = s.events;
    check('串流片段', ev.filter(e => e.type === 'delta').map(e => e.text).join('') === '先讀檔案完成');
    const msgs = ev.filter(e => e.type === 'message' && e.role === 'agent' && !e.subId).map(e => e.text);
    check('工具呼叫前後的文字分成兩則訊息', JSON.stringify(msgs) === JSON.stringify(['先讀檔案', '完成']), JSON.stringify(msgs));
    check('計畫', ev.some(e => e.type === 'plan' && e.steps.length === 2 && e.steps[0].status === 'done' && e.steps[1].status === 'active'));
    const tStart = ev.find(e => e.type === 'tool' && e.phase === 'start' && e.summary === 'Read a.txt');
    const tEnd = ev.find(e => e.type === 'tool' && e.phase === 'end' && e.summary === 'Read a.txt');
    check('工具開始與結束', Boolean(tStart && tEnd && tEnd.detail === '檔案內容' && !tEnd.failed));
    check('子代理開始(名稱取自 Role)與回合結束時收尾', ev.some(e => e.type === 'subagent' && e.phase === 'start' && e.name === '查資料員') && ev.some(e => e.type === 'subagent' && e.phase === 'end' && e.name === '查資料員'));
    check('子代理的提示記到子節點', ev.some(e => e.type === 'message' && e.role === 'user' && e.subId === 't2' && e.text === '去查資料'));
    check('用量:context 與 token', ev.some(e => e.type === 'usage' && e.context?.used === 1200 && e.context?.max === 100000) && ev.some(e => e.type === 'usage' && e.spent?.tokens === 345));
    const sent = received(logFile);
    const prompt = sent.find(m => m.method === 'session/prompt');
    check('身分設定帶在第一則訊息', prompt?.params.prompt[0].text.startsWith('(主控台設定:你叫測試一號)'));
    check('圖片以 base64 內嵌', prompt?.params.prompt.some(b => b.type === 'image' && b.mimeType === 'image/png' && b.data.length > 10));
    check('指定模型時呼叫 session/set_model', sent.some(m => m.method === 'session/set_model' && m.params.modelId === 'm-1'));
    const init = sent.find(m => m.method === 'initialize');
    check('client 能力保守宣告(不提供 fs 與 terminal)', init?.params.clientCapabilities.terminal === false && init?.params.clientCapabilities.fs.writeTextFile === false);
    s.session.send('second');
    await s.until('第二回合', () => s.idleCount() >= 3);
    check('第二則訊息不再帶身分設定', received(logFile).filter(m => m.method === 'session/prompt')[1]?.params.prompt[0].text === 'second');
    await s.session.stop();
    check('stop 不回報失聯', !s.events.some(e => e.type === 'state' && e.state === 'lost'));
  }

  // 2. 權限:允許、本次都允許、拒絕
  for (const [decision, expect] of [['allow', '允許:yes'], ['allow_session', '允許:always'], ['deny', '被拒絕']]) {
    const s = open(mod, fakeCfg());
    await s.until('待命', () => s.idleCount() >= 1);
    s.session.send('perm');
    const req = await s.until('授權請求', ev => ev.find(e => e.type === 'approval_request'));
    check(`授權請求內容(${decision})`, req.tool === 'run_command' && req.summary === 'mkdir x' && req.canAllowSession === true && s.events.some(e => e.type === 'state' && e.state === 'awaiting'));
    s.session.respondApproval(req.requestId, decision);
    await s.until('回合結束', () => s.idleCount() >= 2);
    const end = s.events.find(e => e.type === 'tool' && e.phase === 'end');
    check(`授權結果(${decision})`, s.events.some(e => e.type === 'approval_resolved' && e.decision === decision) && s.events.some(e => e.type === 'message' && e.text === expect) && end?.failed === (decision === 'deny'));
    await s.session.stop();
  }

  // 3. 中斷:串流中、等待授權中
  {
    const s = open(mod, fakeCfg());
    await s.until('待命', () => s.idleCount() >= 1);
    s.session.send('slow');
    await s.until('開始串流', ev => ev.filter(e => e.type === 'delta').length >= 3);
    s.session.interrupt();
    await s.until('中斷完成', ev => ev.some(e => e.type === 'state' && e.detail === '已中斷'));
    check('串流中中斷(session/cancel → stopReason cancelled)', s.events.some(e => e.type === 'message' && e.text === '(已中斷)'));
    s.session.send('after');
    await s.until('中斷後仍可繼續對話', ev => ev.some(e => e.type === 'message' && e.text === '收到:after'));
    check('中斷後同一個行程繼續對話', true);
    await s.session.stop();
  }
  {
    const s = open(mod, fakeCfg());
    await s.until('待命', () => s.idleCount() >= 1);
    s.session.send('perm');
    const req = await s.until('授權請求', ev => ev.find(e => e.type === 'approval_request'));
    s.session.interrupt();
    await s.until('中斷完成', ev => ev.some(e => e.type === 'state' && e.detail === '已中斷'));
    check('等待授權時中斷:授權視為拒絕並回覆 cancelled', s.events.some(e => e.type === 'approval_resolved' && e.requestId === req.requestId && e.decision === 'deny'));
    await s.session.stop();
  }

  // 4. 自動模式:agent 沒有對應的模式時由主控台自動允許;有模式時切換模式
  {
    const s = open(mod, fakeCfg(), { permissionMode: 'auto' });
    await s.until('待命', () => s.idleCount() >= 1);
    s.session.send('perm');
    await s.until('回合結束', () => s.idleCount() >= 2);
    check('自動模式(agent 無模式):自動允許、不跳授權', !s.events.some(e => e.type === 'approval_request') && s.events.some(e => e.type === 'message' && e.text === '允許:yes'));
    await s.session.stop();
  }
  {
    const logFile = join(work, 't4.log');
    const s = open(mod, { ...fakeCfg({ FAKE_MODES: '1' }, logFile), modes: { ask: 'default', auto: 'auto' } }, { permissionMode: 'auto' });
    await s.until('待命', () => s.idleCount() >= 1);
    check('自動模式(agent 有 auto 模式):呼叫 session/set_mode', received(logFile).some(m => m.method === 'session/set_mode' && m.params.modeId === 'auto'));
    s.session.send('perm');
    await s.until('授權請求', ev => ev.find(e => e.type === 'approval_request'));
    check('切到 agent 的 auto 模式後,agent 仍詢問的動作交給使用者', true);
    s.session.interrupt();
    await s.session.stop();
  }

  // 5. 續接:session/load 的重播不重複記錄;有 resume 時改用 session/resume
  {
    const logFile = join(work, 't5.log');
    const s = open(mod, fakeCfg({}, logFile), { sessionId: 'sess-old' });
    await s.until('待命', () => s.idleCount() >= 1);
    check('session/load 續接', received(logFile).some(m => m.method === 'session/load' && m.params.sessionId === 'sess-old') && s.events.some(e => e.type === 'state' && e.detail === '已續接'));
    check('重播的舊對話不重複送出', !s.events.some(e => ['message', 'delta', 'tool', 'session'].includes(e.type)), JSON.stringify(s.events));
    await s.session.stop();
  }
  {
    const logFile = join(work, 't6.log');
    const s = open(mod, fakeCfg({ FAKE_RESUME: '1' }, logFile), { sessionId: 'sess-old' });
    await s.until('待命', () => s.idleCount() >= 1);
    check('宣告 resume 時用 session/resume', received(logFile).some(m => m.method === 'session/resume') && !received(logFile).some(m => m.method === 'session/load'));
    await s.session.stop();
  }

  // 6. 行程意外結束
  {
    const s = open(mod, fakeCfg());
    await s.until('待命', () => s.idleCount() >= 1);
    s.session.send('crash');
    await s.until('失聯', ev => ev.some(e => e.type === 'state' && e.state === 'lost'));
    check('行程意外結束回報錯誤與失聯', s.events.some(e => e.type === 'error' && /代碼 3/.test(e.message)));
  }

  // 7. 啟動失敗
  {
    const s = open(mod, { ...fakeCfg(), bin: join(work, 'no-such-agent.exe') });
    await s.until('失聯', ev => ev.some(e => e.type === 'state' && e.state === 'lost'));
    check('找不到執行檔回報無法啟動', s.events.some(e => e.type === 'error' && /無法啟動/.test(e.message)));
  }

  // 8. probe 只握手;Windows 上 .cmd 包裝經由 cmd 啟動
  {
    const adapter = new mod.AcpAdapter(fakeCfg());
    const cap = await adapter.probe();
    check('probe 回報 agent 名稱與能力', cap.available && cap.version === '9.9.9' && cap.approvals && cap.resume && cap.interrupt);
    if (process.platform === 'win32') {
      const cmd = join(work, 'fake agent.cmd');
      writeFileSync(cmd, `@"${process.execPath}" "${FAKE}" %*\r\n`);
      const s = open(mod, { ...fakeCfg(), bin: cmd, args: [] });
      await s.until('待命', () => s.idleCount() >= 1);
      s.session.send('hi');
      await s.until('回覆', ev => ev.some(e => e.type === 'message' && e.text === '收到:hi'));
      check('.cmd 包裝(路徑含空白)可啟動', true);
      await s.session.stop();
    }
  }
}

/** 對真正的 agy acp 做最小實測:新對話、拒絕、允許、中斷、續接。 */
async function realTests(mod) {
  const bin = process.env.NEXUS_AGY_BIN || join(homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  const cfg = { backend: 'antigravity', label: 'agy', bin, args: ['acp'], procKind: 'agy', modes: { ask: 'default', auto: 'auto' } };
  const model = process.env.NEXUS_ACP_REAL_MODEL || 'gemini-3.8-flash-low';
  const s = open(mod, cfg, { model });
  await s.until('agy 待命', () => s.idleCount() >= 1, 60000);
  const sid = s.events.find(e => e.type === 'session')?.sessionId;
  check('[agy] 新對話', Boolean(sid));
  s.session.send('Use the terminal to run exactly: mkdir nexus_deny . If refused, do not retry; reply one word.');
  let req = await s.until('[agy] 授權請求', ev => ev.find(e => e.type === 'approval_request'), 120000);
  s.session.respondApproval(req.requestId, 'deny');
  await s.until('[agy] 回合結束', () => s.idleCount() >= 2, 120000);
  check('[agy] 拒絕後沒有建立資料夾', !existsSync(join(work, 'nexus_deny')));
  s.session.send('Use the terminal to run exactly: mkdir nexus_allow . Reply one word.');
  req = await s.until('[agy] 第二次授權請求', ev => ev.filter(e => e.type === 'approval_request')[1], 120000);
  s.session.respondApproval(req.requestId, 'allow');
  await s.until('[agy] 回合結束', () => s.idleCount() >= 3, 120000);
  check('[agy] 允許後建立了資料夾', existsSync(join(work, 'nexus_allow')));
  s.session.send('Write a 500 word story about a lighthouse. No tools.');
  await s.until('[agy] 開始串流', ev => ev.filter(e => e.type === 'delta').length >= 3, 120000);
  s.session.interrupt();
  await s.until('[agy] 中斷', ev => ev.some(e => e.type === 'state' && e.detail === '已中斷'), 60000);
  check('[agy] 中斷', true);
  check('[agy] 用量(context 與 token)', s.events.some(e => e.type === 'usage' && e.context) && s.events.some(e => e.type === 'usage' && e.spent));
  await s.session.stop();
  const r = open(mod, cfg, { model, sessionId: sid });
  await r.until('[agy] 續接', ev => ev.some(e => e.type === 'state' && e.detail === '已續接'), 60000);
  r.session.send('What directory name did you successfully create earlier? Reply with just the name.');
  await r.until('[agy] 續接後回覆', () => r.idleCount() >= 2, 120000);
  const reply = r.events.filter(e => e.type === 'message' && e.role === 'agent').map(e => e.text).join(' ');
  check('[agy] 續接後記得之前的對話', /nexus_allow/.test(reply), reply);
  await r.session.stop();
  console.log('[agy] session id:', sid);
}

(async () => {
  try {
    const mod = await load();
    await fakeTests(mod);
    if (process.env.NEXUS_ACP_REAL === '1') await realTests(mod);
  } catch (err) {
    check('未預期的錯誤', false, err.stack);
  }
  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} 通過`);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* 子行程可能還沒放開檔案 */ }
  process.exit(failed.length ? 1 : 0);
})();
