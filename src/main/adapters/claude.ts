import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AdapterEvent, ApprovalDecision, Capability, ExternalSession, UsageWindow } from '../../shared/types';
import { saveImage } from '../media';
import { listClaudeSessions } from '../sessions';
import { track, untrack } from '../procs';
import { pathOnlyNote, type Adapter, type AdapterSession, type Emit, type StartOptions } from './adapter';
import { claudeContent } from './claude-content';

type Json = Record<string, any>;

/** 把工具呼叫濃縮成一行,給節點讀數與事件紀錄用。 */
function summarize(tool: string, input: Json): string {
  if (typeof input.file_path === 'string') return basename(input.file_path);
  if (typeof input.command === 'string') return input.command.replace(/\s+/g, ' ').slice(0, 80);
  if (typeof input.pattern === 'string') return input.pattern.slice(0, 60);
  if (typeof input.description === 'string') return input.description.slice(0, 60);
  if (typeof input.url === 'string') return input.url.slice(0, 80);
  const s = JSON.stringify(input);
  return s === '{}' ? tool : s.slice(0, 60);
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** 把 /usage 的重置時間文字(例如「Nov 17, 5:10pm」或「5:10pm」,本機時區)轉成時間戳(秒)。 */
function parseReset(text: string): number | null {
  const m = /(?:([A-Za-z]{3})[a-z]* (\d{1,2}),? )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;
  const now = new Date();
  const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) : now.getMonth();
  if (month < 0) return null;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const d = new Date(now.getFullYear(), month, m[2] ? Number(m[2]) : now.getDate(), hour, Number(m[4] ?? 0));
  // 重置時間一定在未來:沒寫日期的往後推一天,跨年的往後推一年
  if (d.getTime() < now.getTime() - 60000) { if (m[1]) d.setFullYear(d.getFullYear() + 1); else d.setDate(d.getDate() + 1); }
  return Math.round(d.getTime() / 1000);
}

/**
 * 查詢帳號剩餘額度:`claude -p /usage` 是本機指令,不啟動回合、不花額度,也不留下 session。
 * 節點啟動時與每個回合結束後各查一次,這樣剛開的節點不必先跑一次才看得到最新數字。
 */
let usageOff = false;
let usageAt = 0;
/** 最近一次查到的完整額度;回合中收到的即時數字會併進來,不會把模型專屬的那一條洗掉。 */
let lastUsage: UsageWindow[] = [];
function readUsage(bin: string): Promise<UsageWindow[] | null> {
  if (usageOff || Date.now() - usageAt < 10000) return Promise.resolve(null);
  usageAt = Date.now();
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return new Promise(resolve => {
    const cmd = command(bin, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'], env);
    execFile(cmd.file, cmd.args, { cwd: tmpdir(), env: cmd.env, windowsHide: true, timeout: 30000 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      let data: Json | null = null;
      try { data = JSON.parse(stdout); } catch { /* 不是 JSON 就當作查不到 */ }
      // 舊版 CLI 不認得這個指令,會把它當成一般提問送給模型;遇到就不再查,免得白花額度
      if (data?.local_command !== 'usage') { usageOff = true; resolve(null); return; }
      const windows: UsageWindow[] = [];
      for (const line of String(data.result ?? '').split('\n')) {
        const m = /^Current (session|week)(?: \((.+?)\))?:\s*(\d+(?:\.\d+)?)% used(?:.*?resets (.+))?/.exec(line.trim());
        if (!m) continue;
        const base = { used: Number(m[3]) / 100, resetsAt: m[4] ? parseReset(m[4]) : null };
        if (m[1] === 'session') windows.push({ label: '5 小時', ...base });
        else if (!m[2] || /all models/i.test(m[2])) windows.push({ label: '每週', ...base });
        // 某個模型專屬的每週額度:只在使用該模型的節點上顯示
        else windows.push({ label: `每週(${m[2]})`, ...base, group: m[2], match: [m[2].toLowerCase(), `claude ${m[2].toLowerCase()}`] });
      }
      if (windows.length) lastUsage = windows;
      resolve(windows.length ? windows : null);
    });
  });
}

/**
 * Claude Code 轉接器。
 * 啟動使用者自己安裝並登入的官方 CLI(`claude -p` 加 stream-json 雙向串流),
 * 不讀取憑證、不代理流量;階段 0 已在這台機器實測過這組參數。
 */
export class ClaudeAdapter implements Adapter {
  readonly backend = 'claude' as const;
  private bin = 'claude';

  constructor(bin?: string) {
    if (bin) this.bin = bin;
  }

  /** 尋找 claude:NEXUS_CLAUDE_BIN → PATH 上的 claude → 官方安裝程式的預設位置。 */
  private async locate(): Promise<void> {
    const tryRun = (bin: string) => new Promise<boolean>(r => execFile(bin, ['--version'], { windowsHide: true, timeout: 15000 }, err => r(!err)));
    const override = process.env.NEXUS_CLAUDE_BIN;
    if (override && existsSync(override)) { this.bin = override; return; }
    if (await tryRun('claude')) { this.bin = 'claude'; return; }
    const local = join(homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (existsSync(local)) this.bin = local;
  }

  async probe(): Promise<Capability> {
    await this.locate();
    return new Promise(resolve => {
      const cmd = command(this.bin, ['--version'], process.env);
      execFile(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, timeout: 15000 }, (err, stdout) => {
        const version = err ? null : stdout.trim().split(/\s+/)[0] || null;
        resolve({
          backend: 'claude',
          available: !err,
          simulated: false,
          version,
          approvals: true,
          interrupt: true,
          resume: true,
          fork: !err,
          note: err ? '找不到 claude 指令。請先安裝 Claude Code 並在終端機執行 claude 完成登入。' : `Claude Code ${version}`,
          // Claude Code 沒有列出模型的指令;這些別名會對應到各級別的最新模型
          models: ['fable', 'opus', 'sonnet', 'haiku'],
          attachments: ['image', 'pdf'],
        });
      });
    });
  }

  async listSessions(): Promise<ExternalSession[]> {
    return listClaudeSessions();
  }

  terminalCommand(sessionId: string | null, model: string): { file: string; args: string[] } {
    return { file: this.bin, args: [...(sessionId ? ['--resume', sessionId] : []), ...(model ? ['--model', model] : [])] };
  }

  start(opts: StartOptions, emit: Emit): AdapterSession {
    return new ClaudeSession(this.bin, opts, emit);
  }
}

/**
 * 啟動 claude 的指令。測試用:NEXUS_CLAUDE_BIN 指向 .js 檔時,改用內建的 Node 執行它
 * (假的 CLI,照劇本輸出 stream-json,見 tests/claude-fake-cli.js),其餘情況原樣執行。
 */
function command(bin: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  if (!/\.[cm]?js$/i.test(bin)) return { file: bin, args, env };
  return { file: process.execPath, args: [bin, ...args], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

class ClaudeSession implements AdapterSession {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private stderrTail = '';
  private stopping = false;
  private exited = false;
  private interrupting = false;
  private tools = new Map<string, { name: string; summary: string }>();
  private approvals = new Map<string, { input: Json; suggestions: unknown[] }>();
  /** 進行中的子代理:Agent 工具呼叫的 id → 名稱。 */
  private subagents = new Map<string, string>();
  /**
   * 在背景執行的子代理(Agent 工具呼叫的 id)。背景子代理一啟動,工具就回報「已啟動」,回合也可能先結束,
   * 但子代理還在跑;要等 CLI 的 task_notification 才算結束,在那之前子節點留在面板上。
   */
  private background = new Set<string>();
  /** 等待使用者作答的提問:request id → 提問工具原本的參數。 */
  private questions = new Map<string, Json>();
  private costSeen = 0;

  constructor(private bin: string, private opts: StartOptions, private emit: Emit) {
    this.reportUsage();
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-prompt-tool', 'stdio',
      // 自動:交給 Claude Code 的 auto 模式,檔案修改與一般指令直接執行,它判斷有風險的動作才會擋下或詢問
      '--permission-mode', opts.permissionMode === 'auto' ? 'auto' : 'default',
    ];
    if (opts.sessionId) args.push('--resume', opts.sessionId);
    // 分支對話:`--resume <來源> --fork-session` 會把來源的對話複製到一個新的 session id(來源不受影響,
    // 不同工作目錄也找得到來源)。新 id 由 system/init 事件的 session_id 回報;stream-json 模式下
    // init 要等第一句指令送進去才會出現,在那之前新的 session 還沒寫到磁碟(已用 Claude Code 2.1.326 實測)。
    else if (opts.forkFrom) args.push('--resume', opts.forkFrom, '--fork-session');
    if (opts.model) args.push('--model', opts.model);
    if (opts.persona) args.push('--append-system-prompt', opts.persona);
    // 節點互相呼叫:掛上主控台的工具服務(只對這個行程,不動使用者的設定),並預先允許它的工具,
    // 不再經 Claude Code 自己的授權——要不要問使用者由主控台依節點的權限模式決定
    if (opts.interop) args.push('--mcp-config', opts.interop.configFile, '--allowedTools', opts.interop.tools.map(t => `mcp__${opts.interop!.name}__${t}`).join(','));

    const env = { ...process.env };
    // 若主控台本身是從另一個 Claude Code session 啟動的,不要讓子行程以為自己是巢狀 session
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const cmd = command(bin, args, env);
    this.child = spawn(cmd.file, cmd.args, { cwd: opts.cwd, env: cmd.env, windowsHide: true });
    track(this.child.pid, 'claude');
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => this.onStdout(d));
    this.child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-600); });
    this.child.stdin.on('error', () => { /* 行程已結束時寫入會失敗,由 exit 事件處理 */ });
    this.child.on('spawn', () => this.emit({ type: 'state', state: 'idle', detail: opts.sessionId ? '已續接' : opts.forkFrom ? '已分支' : '' }));
    this.child.on('error', err => {
      this.exited = true;
      this.emit({ type: 'error', message: `無法啟動 claude:${err.message}` });
      this.emit({ type: 'state', state: 'lost', detail: '無法啟動' });
    });
    this.child.on('exit', code => {
      untrack(this.child.pid);
      this.exited = true;
      // 行程不在了,還在跑的子代理(包括背景的)也跟著結束
      for (const [subId, name] of this.subagents) this.emit({ type: 'subagent', phase: 'end', subId, name, failed: !this.stopping });
      this.subagents.clear();
      this.background.clear();
      if (this.stopping) return;
      const reason = this.stderrTail.trim().split('\n').pop() ?? '';
      this.emit({ type: 'error', message: `claude 行程結束(代碼 ${code})${reason ? `:${reason}` : ''}` });
      this.emit({ type: 'state', state: 'lost', detail: `行程結束(${code})` });
    });
  }

  private reportUsage(): void {
    void readUsage(this.bin).then(windows => { if (windows) this.emit({ type: 'usage', windows }); });
  }

  send(text: string, images: string[] = []): void {
    if (this.exited) return;
    this.interrupting = false;
    // 圖片與 PDF 內嵌在訊息裡;其他類型、太大或讀不到的改傳路徑並告訴使用者
    const { content, fallback } = claudeContent(text, images);
    const note = pathOnlyNote('Claude Code', fallback);
    if (note) this.emit(note);
    this.write({ type: 'user', message: { role: 'user', content } });
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
  }

  interrupt(): void {
    if (this.exited) return;
    this.interrupting = true;
    // 等待中的授權一律視為拒絕
    for (const id of this.approvals.keys()) this.emit({ type: 'approval_resolved', requestId: id, decision: 'deny' });
    this.approvals.clear();
    for (const id of this.questions.keys()) this.emit({ type: 'question_resolved', requestId: id, answers: null });
    this.questions.clear();
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } });
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    const pending = this.approvals.get(requestId);
    if (!pending) return;
    this.approvals.delete(requestId);
    const response: Json = decision === 'deny'
      ? { behavior: 'deny', message: '使用者拒絕了這個動作。' }
      : { behavior: 'allow', updatedInput: pending.input };
    if (decision === 'allow_session' && pending.suggestions.length) response.updatedPermissions = pending.suggestions;
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit({ type: 'approval_resolved', requestId, decision });
    this.emit({ type: 'state', state: decision === 'deny' ? 'planning' : 'working', detail: decision === 'deny' ? '思考中' : '執行已授權的動作' });
  }

  answerQuestion(requestId: string, answers: Record<string, string[]> | null): void {
    const input = this.questions.get(requestId);
    if (!input) return;
    this.questions.delete(requestId);
    let response: Json;
    if (answers) {
      // 提問工具要的格式:以題目文字為鍵,答案為值
      const byText: Record<string, string> = {};
      (input.questions as Json[]).forEach((q, i) => { byText[String(q.question)] = (answers[String(i)] ?? []).join(', '); });
      response = { behavior: 'allow', updatedInput: { ...input, answers: byText } };
    } else {
      response = { behavior: 'deny', message: '使用者選擇不回答這個問題,請自行判斷後繼續。' };
    }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    this.emit({ type: 'question_resolved', requestId, answers });
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      this.child.once('exit', done);
      // 先關閉輸入讓它自己結束;超過時間就連同子行程一起強制結束
      this.child.stdin.end();
      const timer = setTimeout(() => {
        if (process.platform === 'win32' && this.child.pid) {
          execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => { /* 行程可能已經不在 */ });
        } else {
          this.child.kill('SIGKILL');
        }
        setTimeout(done, 1500);
      }, 2500);
    });
  }

  /** 從回合結果估算記憶空間:最後一次請求送進模型的 token 數,對上模型的上限。 */
  private reportContext(m: Json): void {
    // 花費:金額是這個行程的累計值,所以取與上次的差;token 是這一回合的用量
    const total = Number(m.total_cost_usd) || 0;
    const usd = total >= this.costSeen ? total - this.costSeen : total;
    this.costSeen = total;
    const u = m.usage ?? {};
    const tokens = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.output_tokens) || 0);
    if (tokens > 0 || usd > 0) this.emit({ type: 'usage', spent: { tokens, usd } });
    const last = Array.isArray(m.usage?.iterations) ? m.usage.iterations.at(-1) : m.usage;
    const max = Object.values((m.modelUsage ?? {}) as Record<string, Json>).map(v => Number(v?.contextWindow) || 0).sort((a, b) => b - a)[0] ?? 0;
    if (!last || !max) return;
    const used = (Number(last.input_tokens) || 0) + (Number(last.cache_read_input_tokens) || 0) + (Number(last.cache_creation_input_tokens) || 0) + (Number(last.output_tokens) || 0);
    if (used > 0) this.emit({ type: 'usage', context: { used, max } });
  }

  private write(obj: Json): void {
    if (this.exited || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: Json;
      // 寬容解析:看不懂的行直接略過,不讓 CLI 改版弄壞整個 session
      try { msg = JSON.parse(line); } catch { continue; }
      try { this.onMessage(msg); } catch (err) {
        this.emit({ type: 'error', message: `解析 claude 輸出失敗:${(err as Error).message}` });
      }
    }
  }

  private onMessage(m: Json): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && typeof m.session_id === 'string' && m.session_id !== this.opts.sessionId) {
          // 分支時若回報的仍是來源的 id,表示這版 CLI 沒有真的分支;不能讓兩個節點寫同一個 session
          if (this.opts.forkFrom && m.session_id === this.opts.forkFrom) {
            this.emit({ type: 'error', message: '這一版 Claude Code 沒有建立新的分支 session,已停止使用,避免和來源節點寫進同一個對話。' });
            void this.stop();
            this.emit({ type: 'state', state: 'error', detail: '分支失敗' });
            return;
          }
          this.opts.sessionId = m.session_id;
          this.emit({ type: 'session', sessionId: m.session_id });
        }
        // 背景任務的生命週期(Claude Code 2.1.326):task_started → task_progress… → task_notification。
        // 只處理子代理(tool_use_id 對得上 Agent 工具呼叫的);背景的 Bash 之類不是子節點
        else if (typeof m.tool_use_id === 'string' && this.subagents.has(m.tool_use_id)) {
          const id = m.tool_use_id;
          if (m.subtype === 'task_started' && m.is_backgrounded === true) this.background.add(id);
          else if (m.subtype === 'task_progress' && this.background.has(id)) {
            const what = [m.last_tool_name, m.summary || m.description].filter(x => typeof x === 'string' && x).join(' · ');
            this.emit({ type: 'state', state: 'working', detail: what.slice(0, 120) || '背景執行中' }, id);
          } else if (m.subtype === 'task_notification') {
            const name = this.subagents.get(id)!;
            if (this.background.has(id) && typeof m.summary === 'string' && m.summary.trim()) this.emit({ type: 'note', text: m.summary.trim().slice(0, 2000) }, id);
            this.subagents.delete(id);
            this.background.delete(id);
            this.emit({ type: 'subagent', phase: 'end', subId: id, name, failed: m.status !== 'completed' });
          }
        }
        return;

      case 'assistant': {
        // 子代理送出的訊息帶有 parent_tool_use_id,指向呼叫它的那次 Agent 工具
        const sub = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : undefined;
        for (const c of m.message?.content ?? []) {
          if (c.type === 'text' && c.text?.trim()) {
            this.emit({ type: 'message', role: 'agent', text: c.text }, sub);
          } else if (c.type === 'tool_use') {
            const summary = summarize(c.name, c.input ?? {});
            this.tools.set(c.id, { name: c.name, summary });
            this.emit({ type: 'tool', phase: 'start', name: c.name, summary, detail: pretty(c.input ?? {}) }, sub);
            // 待辦清單工具(這一版 Claude Code 在無視窗模式不一定提供)
            if (!sub && c.name === 'TodoWrite' && Array.isArray(c.input?.todos)) {
              this.emit({ type: 'plan', steps: c.input.todos.map((t: Json) => ({ text: String(t.content ?? '').slice(0, 160), status: t.status === 'completed' ? 'done' : t.status === 'in_progress' ? 'active' : 'pending' })) });
            }
            if (c.name === 'Agent' || c.name === 'Task') {
              const name = String(c.input?.description || c.input?.subagent_type || '子代理');
              this.subagents.set(c.id, name);
              if (c.input?.run_in_background === true) this.background.add(c.id);
              this.emit({ type: 'subagent', phase: 'start', subId: c.id, name });
            }
            if (sub) this.emit({ type: 'state', state: 'working', detail: `${c.name} · ${summary}` }, sub);
            // 授權請求可能比工具呼叫先到;已在等待授權時不要蓋掉狀態
            else if (!this.approvals.size) this.emit({ type: 'state', state: 'working', detail: `${c.name} · ${summary}` });
          }
        }
        return;
      }

      case 'user': {
        const sub = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : undefined;
        for (const c of Array.isArray(m.message?.content) ? m.message.content : []) {
          // 子代理收到的任務說明
          if (sub && c.type === 'text' && c.text?.trim()) { this.emit({ type: 'message', role: 'user', text: c.text }, sub); continue; }
          if (c.type !== 'tool_result') continue;
          const t = this.tools.get(c.tool_use_id);
          this.tools.delete(c.tool_use_id);
          if (!t) continue;
          // 工具結果裡的圖片(例如 Read 讀圖、MCP 截圖)存成檔案再顯示;細節只留文字,不把 base64 寫進紀錄
          const blocks: Json[] = Array.isArray(c.content) ? c.content : [];
          const images = blocks.filter(b => b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string');
          const out = typeof c.content === 'string' ? c.content : pretty(images.length ? blocks.map(b => (images.includes(b) ? { type: 'image', media_type: b.source.media_type } : b)) : c.content);
          this.emit({ type: 'tool', phase: 'end', name: t.name, summary: t.summary, detail: out.slice(0, 4000), failed: c.is_error === true }, sub);
          for (const b of images) {
            const path = saveImage(this.opts.agentId, b.source.data, String(b.source.media_type ?? ''));
            this.emit(path ? { type: 'image', path, caption: `${t.name} · ${t.summary}` } : { type: 'note', text: `${t.name} 回傳的圖片格式不支援或太大,沒有顯示。` }, sub);
          }
          const subName = this.subagents.get(c.tool_use_id);
          // 背景子代理的工具結果只是「已啟動」:子節點留著,狀態改成背景執行中,等 task_notification 才結束。
          // 沒收到 task_started 的舊版 CLI,從結果文字判斷
          if (subName !== undefined && !c.is_error && (this.background.has(c.tool_use_id) || /^Async agent launched|working in the background/i.test(out))) {
            this.background.add(c.tool_use_id);
            this.emit({ type: 'state', state: 'working', detail: '背景執行中' }, c.tool_use_id);
          } else if (subName !== undefined) {
            this.subagents.delete(c.tool_use_id);
            this.background.delete(c.tool_use_id);
            this.emit({ type: 'subagent', phase: 'end', subId: c.tool_use_id, name: subName, failed: c.is_error === true });
          }
          if (sub) this.emit({ type: 'state', state: 'planning', detail: '思考中' }, sub);
          else if (!this.interrupting && !this.approvals.size) { const waiting = this.subagents.size - this.background.size; this.emit({ type: 'state', state: waiting ? 'working' : 'planning', detail: waiting ? `等待 ${waiting} 個子代理` : '思考中' }); }
        }
        return;
      }

      case 'control_request': {
        const req = m.request ?? {};
        if (req.subtype === 'can_use_tool' && req.tool_name === 'AskUserQuestion' && Array.isArray(req.input?.questions)) {
          // 提問工具:不是授權,而是要使用者作答
          this.questions.set(m.request_id, req.input);
          this.emit({
            type: 'question', requestId: m.request_id,
            questions: req.input.questions.map((q: Json, i: number) => ({
              id: String(i), header: String(q.header ?? ''), question: String(q.question ?? ''), multi: q.multiSelect === true,
              options: (q.options ?? []).map((o: Json) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
            })),
          });
          this.emit({ type: 'state', state: 'awaiting', detail: '等你回答' });
          return;
        }
        if (req.subtype === 'can_use_tool') {
          const input = req.input ?? {};
          const suggestions = Array.isArray(req.permission_suggestions) ? req.permission_suggestions : [];
          this.approvals.set(m.request_id, { input, suggestions });
          const summary = summarize(req.tool_name, input);
          this.emit({
            type: 'approval_request', requestId: m.request_id, tool: req.tool_name, summary,
            detail: pretty(input), canAllowSession: suggestions.length > 0,
          });
          this.emit({ type: 'state', state: 'awaiting', detail: `${req.tool_name} · ${summary}` });
        } else {
          // 還不支援的控制請求明確回覆錯誤,避免 CLI 一直等
          this.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Entropy Nexus 不支援 ${req.subtype}` } });
        }
        return;
      }

      case 'stream_event': {
        // 回覆生成中的文字片段
        const ev = m.event ?? {};
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
          this.emit({ type: 'delta', text: ev.delta.text }, typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : undefined);
        }
        return;
      }

      case 'rate_limit_event': {
        // 訂閱額度:各視窗的已用比例與重置時間
        const wins = m.rate_limit_info?.unifiedWindows ?? {};
        const LABELS: Record<string, string> = { five_hour: '5 小時', seven_day: '每週' };
        const windows = Object.entries(wins as Record<string, Json>)
          .filter(([, w]) => typeof w?.utilization === 'number')
          .map(([k, w]) => ({ label: LABELS[k] ?? k, used: w.utilization, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }));
        if (!windows.length) return;
        // 以即時數字更新已知的額度,保留 /usage 才查得到的模型專屬額度
        const fresh = new Map(windows.map(w => [w.label, w]));
        const merged = lastUsage.length ? lastUsage.map(w => fresh.get(w.label) ?? w) : windows;
        lastUsage = merged;
        this.emit({ type: 'usage', windows: merged });
        return;
      }

      case 'result':
        this.reportContext(m);
        this.reportUsage();
        this.tools.clear();
        // 回合結束:前景的子代理一定已經結束;背景的還在跑,留到 task_notification
        for (const [subId, name] of this.subagents) {
          if (this.background.has(subId)) continue;
          this.subagents.delete(subId);
          this.emit({ type: 'subagent', phase: 'end', subId, name });
        }
        if (this.interrupting) {
          this.interrupting = false;
          this.emit({ type: 'message', role: 'agent', text: '(已中斷)' });
          this.emit({ type: 'state', state: 'idle', detail: '已中斷' });
        } else if (m.is_error) {
          const reason = typeof m.result === 'string' && m.result ? m.result : String(m.subtype ?? '未知錯誤');
          this.emit({ type: 'error', message: reason.slice(0, 500) });
          this.emit({ type: 'state', state: 'error', detail: reason.slice(0, 60) });
        } else {
          this.emit({ type: 'state', state: 'idle', detail: '' });
        }
        return;

      default:
        // rate_limit_event、control_response 等目前不需要處理
        return;
    }
  }
}
