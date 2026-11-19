// 假的 claude CLI:照劇本輸出 stream-json,用來測試 Claude Code 轉接器對特定事件順序的處理,不連線、不花額度。
// 用法:NEXUS_CLAUDE_BIN 指向這個檔案(轉接器看到 .js 會用內建的 Node 執行)。
// 劇本:收到第一句指令後,啟動一個背景子代理(bg1)與一個前景子代理(fg1);前景的在回合內結束,
// 回合結束後背景的繼續回報進度,幾秒後完成(task_notification),CLI 再自己開一個回合回報結果。
// 事件格式依 Claude Code 2.1.326 的 task_started / task_progress / task_notification。
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
if (args.includes('/usage')) process.exit(1);

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
const wait = ms => new Promise(r => setTimeout(r, ms));
const assistant = (content, parent = null) => out({ type: 'assistant', parent_tool_use_id: parent, message: { role: 'assistant', content } });
const toolResult = (id, content, parent = null) => out({ type: 'user', parent_tool_use_id: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
const result = () => out({ type: 'result', subtype: 'success', is_error: false, result: '', usage: {}, total_cost_usd: 0 });

let started = false;
async function turn() {
  out({ type: 'system', subtype: 'init', session_id: 'fake-session-1' });
  assistant([{ type: 'tool_use', id: 'bg1', name: 'Agent', input: { description: '背景工作', prompt: '慢慢做' } }]);
  out({ type: 'system', subtype: 'task_started', task_id: 't-bg1', tool_use_id: 'bg1', description: '背景工作', subagent_type: 'general-purpose', is_backgrounded: true });
  toolResult('bg1', 'Async agent launched successfully.\nagentId: t-bg1');
  assistant([{ type: 'tool_use', id: 'fg1', name: 'Agent', input: { description: '前景工作', prompt: '快速做' } }]);
  out({ type: 'system', subtype: 'task_started', task_id: 't-fg1', tool_use_id: 'fg1', description: '前景工作', subagent_type: 'general-purpose', is_backgrounded: false });
  await wait(1500);
  assistant([{ type: 'text', text: '前景子代理做完了。' }], 'fg1');
  toolResult('fg1', '前景的結果');
  out({ type: 'system', subtype: 'task_notification', task_id: 't-fg1', tool_use_id: 'fg1', status: 'completed', summary: '前景完成' });
  assistant([{ type: 'text', text: '背景子代理還在跑,先回報到這裡。' }]);
  result();
  // 回合已結束,背景子代理繼續
  await wait(2500);
  assistant([{ type: 'tool_use', id: 'x1', name: 'Read', input: { file_path: 'a.txt' } }], 'bg1');
  out({ type: 'system', subtype: 'task_progress', task_id: 't-bg1', tool_use_id: 'bg1', description: '背景工作', last_tool_name: 'Read', summary: '讀取 a.txt' });
  await wait(3500);
  out({ type: 'system', subtype: 'task_notification', task_id: 't-bg1', tool_use_id: 'bg1', status: 'completed', summary: '背景工作的最終報告' });
  assistant([{ type: 'text', text: '背景子代理也完成了。' }]);
  result();
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'user' && !started) { started = true; void turn(); }
  }
});
process.stdin.on('end', () => process.exit(0));
