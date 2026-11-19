// 假的 ACP agent:stdio 上一行一則 JSON-RPC,給 acp.test.js 用,不連網、不花額度。
// 依指令文字決定劇本:hello(串流、計畫、工具、子代理)、perm(一次權限詢問)、slow(等待中斷)、crash(行程意外結束)。
// 環境變數:FAKE_LOG 記錄收到的每則訊息;FAKE_RESUME=1 宣告 session/resume;FAKE_MODES=1 提供 default/auto 模式。
const fs = require('node:fs');
const LOG = process.env.FAKE_LOG;
const log = m => { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(m)}\n`); };
const send = m => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const wait = ms => new Promise(r => setTimeout(r, ms));

let nextServerId = 100;
const pendingClient = new Map();
const ask = (method, params) => new Promise(resolve => { const id = nextServerId++; pendingClient.set(id, resolve); send({ id, method, params }); });
let cancelled = false;
let wake = null;

const modes = process.env.FAKE_MODES === '1'
  ? { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto', name: 'Auto' }] }
  : undefined;

async function turn(id, sessionId, text) {
  cancelled = false;
  if (text.includes('crash')) { update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '要當掉了' } }); await wait(50); process.exit(3); }
  if (text.includes('hello')) {
    update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一下' } });
    update(sessionId, { sessionUpdate: 'plan', entries: [{ content: '讀檔', priority: 'high', status: 'completed' }, { content: '回覆', priority: 'high', status: 'in_progress' }] });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '先讀' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '檔案' } });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.txt', kind: 'read', status: 'in_progress', rawInput: { path: 'a.txt' } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '檔案內容' } }] });
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't2', name: 'invoke_subagent', title: 'Run invoke_subagent', kind: 'other', status: 'in_progress', rawInput: { Role: '查資料員', Prompt: '去查資料' } });
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'completed' });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '完成' } });
    update(sessionId, { sessionUpdate: 'usage_update', used: 1200, size: 100000 });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 345 } } });
    return;
  }
  if (text.includes('perm')) {
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'p1', name: 'run_command', title: 'mkdir x', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'mkdir x' } });
    const res = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'p1', name: 'run_command', title: 'mkdir x', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'mkdir x' } },
      options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Deny', kind: 'reject_once' }],
    });
    const o = res.outcome ?? {};
    if (o.outcome === 'cancelled' || cancelled) {
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: 'failed' });
      send({ id, result: { stopReason: 'cancelled' } });
      return;
    }
    const ok = o.optionId === 'yes' || o.optionId === 'always';
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'p1', status: ok ? 'completed' : 'failed', rawOutput: { output: ok ? '已建立' : '' } });
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ok ? `允許:${o.optionId}` : '被拒絕' } });
    send({ id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (text.includes('slow')) {
    for (let i = 0; i < 200 && !cancelled; i++) {
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${i} ` } });
      await new Promise(r => { wake = r; setTimeout(r, 50); });
    }
    send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } });
    return;
  }
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `收到:${text}` } });
  send({ id, result: { stopReason: 'end_turn' } });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    log(m);
    if (m.method === undefined) { const r = pendingClient.get(m.id); pendingClient.delete(m.id); r?.(m.result ?? {}); continue; }
    const p = m.params ?? {};
    switch (m.method) {
      case 'initialize':
        send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '9.9.9' }, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, ...(process.env.FAKE_RESUME === '1' ? { sessionCapabilities: { resume: {} } } : {}) }, authMethods: [] } });
        break;
      case 'session/new':
        send({ id: m.id, result: { sessionId: 'sess-new-1', ...(modes ? { modes } : {}) } });
        break;
      case 'session/load':
        // 規格:回覆前先重播整段對話
        update(p.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '舊的提問' } });
        update(p.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '舊的回覆' } });
        update(p.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'old tool', status: 'completed' });
        send({ id: m.id, result: { ...(modes ? { modes } : {}) } });
        break;
      case 'session/resume':
        send({ id: m.id, result: { ...(modes ? { modes } : {}) } });
        break;
      case 'session/set_mode':
      case 'session/set_model':
        send({ id: m.id, result: {} });
        break;
      case 'session/prompt':
        void turn(m.id, p.sessionId, (p.prompt ?? []).filter(b => b.type === 'text').map(b => b.text).join(''));
        break;
      case 'session/cancel':
        cancelled = true;
        wake?.();
        break;
      default:
        if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: `unknown ${m.method}` } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
