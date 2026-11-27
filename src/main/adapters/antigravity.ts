import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AdapterEvent, Capability, ExternalSession, UsageWindow } from '../../shared/types';
import { agySettings } from '../../shared/agy-allow';
import { attachmentDirs, stageAttachment } from '../attachments';
import { listAntigravitySessions } from '../sessions';
import { track, untrack } from '../procs';
import { AcpSession, type AcpConfig } from './acp';
import { pathOnlyNote, withPaths, type Adapter, type AdapterSession, type Emit, type StartOptions } from './adapter';

type Json = Record<string, any>;

/**
 * agy 每次啟動時,若距離上次檢查超過 15 分鐘就會檢查自動更新,而且是另開一個看得見的主控台視窗去做
 * (實測 agy 1.5.10:視窗標題是 agy.exe,一閃而過)。主控台每個回合結束都會啟動一次 agy 查額度,所以常常跳視窗。
 * 設定這個環境變數後 agy 就不檢查更新(也不會更新 last_check.timestamp);要更新時請自己在終端機執行 `agy update`。
 * 終端機模式不帶這個設定,在那裡 agy 仍會照常自動更新。
 */
const AGY_ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' };

const run = (file: string, args: string[]): Promise<string | null> =>
  new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 20000, env: { ...process.env, ...AGY_ENV } }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });

/** 尋找 agy 執行檔。順序:NEXUS_AGY_BIN → PATH 上的 agy → Antigravity 安裝的預設位置。 */
async function findAgy(): Promise<{ bin: string; source: string } | null> {
  const override = process.env.NEXUS_AGY_BIN;
  if (override && existsSync(override)) return { bin: override, source: '手動指定' };
  if (await run('agy', ['--version'])) return { bin: 'agy', source: 'PATH' };
  const local = join(homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (existsSync(local)) return { bin: local, source: '預設安裝位置' };
  return null;
}

/** 查詢帳號剩餘額度:`agy -p /usage` 是唯讀指令,不啟動回合、不花額度、不留下對話。 */
let usageOff = false;
let usageAt = 0;
async function readUsage(bin: string): Promise<UsageWindow[] | null> {
  if (usageOff || Date.now() - usageAt < 10000) return null;
  usageAt = Date.now();
  const out = await run(bin, ['-p', '/usage', '--output-format', 'json', '--print-timeout', '15s']);
  let data: Json | null = null;
  try { data = JSON.parse(out ?? ''); } catch { /* 不是 JSON 就當作查不到 */ }
  // 舊版 CLI 不認得這個指令,會把它當成一般提問送給模型;遇到就不再查,免得白花額度
  if (out && data?.command?.name !== 'usage') { usageOff = true; return null; }
  const windows: UsageWindow[] = [];
  for (const g of data?.command?.data?.groups ?? []) {
    const listed = /Models within this group:s*(.+)$/i.exec(String(g.description ?? ''))?.[1];
    const match = (listed ?? String(g.name ?? '')).split(',').map(s => s.toLowerCase().replace(/[-._]+/g, ' ').trim()).filter(Boolean);
    for (const b of g.buckets ?? []) {
      if (typeof b.remaining_fraction !== 'number') continue;
      const ts = Date.parse(String(b.reset_time ?? ''));
      windows.push({ label: b.window === '5h' ? '5 小時' : b.window === 'weekly' ? '每週' : String(b.name ?? b.window ?? '額度'), used: 1 - b.remaining_fraction, resetsAt: Number.isFinite(ts) ? Math.round(ts / 1000) : null, group: String(g.name ?? ''), match });
    }
  }
  return windows.length ? windows : null;
}

const NO_PROMPT_NOTE = '無視窗模式不會詢問權限:工作目錄內的動作直接執行,其餘自動拒絕。';

/** NEXUS_AGY_ACP=1 時改走 `agy acp`(Agent Client Protocol):有權限詢問、真正的中斷與圖片輸入。預設仍用 stream-json。 */
const useAcp = () => process.env.NEXUS_AGY_ACP === '1';

function acpConfig(bin: string): AcpConfig {
  return {
    backend: 'antigravity', label: 'agy', bin, args: ['acp'], procKind: 'agy',
    // 每次詢問用 agy 的 default 模式;自動用 agy 的 auto 模式(它判斷不可逆的動作仍會詢問)
    modes: { ask: 'default', auto: 'auto' },
    env: AGY_ENV,
    usage: () => readUsage(bin),
    defaultModel: process.env.NEXUS_AGY_MODEL,
  };
}

/**
 * Antigravity 轉接器:啟動 `agy` 的 stream-json 雙向模式。
 * 階段 0 實測的限制:這個模式沒有授權請求,也沒有中斷用的輸入事件;
 * 輸入格式沒有官方文件,改版時可能失效,所以解析一律從寬。
 */
export class AntigravityAdapter implements Adapter {
  readonly backend = 'antigravity' as const;
  private bin: string | null = null;

  async probe(): Promise<Capability> {
    const found = await findAgy();
    const version = found ? await run(found.bin, ['--version']) : null;
    this.bin = found && version ? found.bin : null;
    // agy models 每行是「模型代號<Tab>顯示名稱」
    const listed = this.bin ? await run(this.bin, ['models']) : null;
    const models = (listed ?? '').split(/\r?\n/).map(l => l.split('\t')[0].trim()).filter(id => /^[a-z0-9][\w.-]*$/i.test(id) && id.includes('-'));
    return {
      backend: 'antigravity',
      available: this.bin !== null,
      simulated: false,
      version,
      approvals: useAcp(),
      interrupt: true,
      resume: true,
      // agy 1.5.10 的 `agy --help` 只有 --conversation(續接)與 --continue,沒有分支對話的參數,所以不支援
      fork: false,
      note: this.bin ? `Antigravity CLI ${version}(${found!.source})。${useAcp() ? '經由 ACP 連線,會詢問權限。' : NO_PROMPT_NOTE}` : '找不到 agy。請安裝 Antigravity 並完成登入。',
      models,
      // ACP 模式下 agy 收得到 base64 圖片(實測過);stream-json 模式只能傳路徑
      attachments: useAcp() ? ['image'] : [],
      // 回合中送出的訊息有時被忽略、有時等回合結束才處理(2026-11-27 實測),改成排隊
      interject: false,
    };
  }

  async listSessions(): Promise<ExternalSession[]> {
    return listAntigravitySessions();
  }

  terminalCommand(sessionId: string | null, model: string): { file: string; args: string[] } {
    return { file: this.bin ?? 'agy', args: [...(sessionId ? ['--conversation', sessionId] : []), ...(model ? ['--model', model] : [])] };
  }

  start(opts: StartOptions, emit: Emit): AdapterSession {
    if (useAcp()) return new AcpSession(acpConfig(this.bin ?? 'agy'), opts, emit);
    return new AntigravitySession(this.bin ?? 'agy', opts, emit);
  }
}

const SUBAGENT_TOOLS = /^(invoke_subagent|browser_subagent)$/;

function subagentName(params: Json, fallback: string): string {
  for (const k of ['Name', 'SubagentName', 'TaskName', 'Task', 'Prompt', 'Message']) {
    if (typeof params[k] === 'string' && params[k].trim()) return params[k].trim().split('\n')[0].slice(0, 40);
  }
  return fallback;
}

function summarize(tool: string, params: Json): string {
  // MCP 工具都經由 call_mcp_tool:顯示實際的伺服器與工具名稱
  if (tool === 'call_mcp_tool' && typeof params.ToolName === 'string') return `${params.ServerName ?? ''}/${params.ToolName}${params.Arguments?.node ? ` → ${String(params.Arguments.node).slice(0, 40)}` : ''}`;
  const path = params.Path ?? params.AbsolutePath ?? params.TargetFile ?? params.File;
  if (typeof path === 'string') return basename(path);
  if (typeof params.CommandLine === 'string') return params.CommandLine.replace(/\s+/g, ' ').slice(0, 100);
  if (typeof params.Query === 'string') return params.Query.slice(0, 80);
  const s = JSON.stringify(params);
  return s === '{}' ? tool : s.slice(0, 80);
}

class AntigravitySession implements AdapterSession {
  private child!: ChildProcessWithoutNullStreams;
  private buf = '';
  private stderrTail = '';
  private stopping = false;
  private exited = true;
  private interrupting = false;
  private busy = false;
  /** 每個 agent_response 步驟累積的文字,步驟完成時才送出。 */
  private text = new Map<number, string>();
  private tools = new Map<number, { name: string; summary: string }>();
  private subagents = new Map<string, string>();

  /** Antigravity 沒有系統提示的參數,身分設定改在新對話的第一則訊息前面帶上。 */
  private introduce: boolean;
  /** agy 的 MCP 工具是延遲載入的,模型要知道伺服器名稱才找得到;這個 session 的第一則訊息前面提示一次。 */
  private hintInterop = true;
  /** 圖片要放在工作目錄才顯示得出來的提示,同樣每個 session 第一則訊息帶一次。 */
  private hintImage = true;

  constructor(private bin: string, private opts: StartOptions, private emit: Emit) {
    this.introduce = Boolean(opts.persona) && !opts.sessionId;
    this.spawn();
    this.reportUsage();
  }

  private spawn(): void {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (this.opts.sessionId) args.push('--conversation', this.opts.sessionId);
    const model = this.opts.model || process.env.NEXUS_AGY_MODEL;
    if (model) args.push('--model', model);
    // 無視窗模式會自動拒絕讀取工作區以外的檔案(實測 agy 1.5.10),所以把主控台存放附件的資料夾加進工作區,
    // 貼上或上傳的圖片才讀得到(read_file 讀圖片時模型看得到內容)
    for (const d of attachmentDirs()) if (existsSync(d)) args.push('--add-dir', d);
    // 節點互相呼叫:agy 要經工作區外掛才能掛上 MCP 伺服器(放在主控台自己的資料夾,用 --add-dir 加進工作區),
    // 並用 --settings 放行它的工具,否則無視窗模式會自動拒絕
    // 無視窗模式沒有畫面可以詢問權限,不在白名單裡的動作一律自動拒絕:主控台自己的工具,加上使用者的白名單(設定裡的「Antigravity 允許的工具」)
    const agy = this.opts.interop?.agy;
    if (agy) args.push('--add-dir', agy.dir);
    const settings = this.settingsFile(agy);
    if (settings) args.push('--settings', settings);

    this.buf = '';
    this.exited = false;
    const child = spawn(this.bin, args, { cwd: this.opts.cwd, windowsHide: true, env: { ...process.env, ...AGY_ENV } });
    this.child = child;
    track(child.pid, 'agy');
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { if (child === this.child) this.onStdout(d); });
    child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-600); });
    child.stdin.on('error', () => { /* 行程已結束,由 exit 事件處理 */ });
    child.on('error', err => {
      if (child !== this.child) return;
      this.exited = true;
      this.emit({ type: 'error', message: `無法啟動 agy:${err.message}` });
      this.emit({ type: 'state', state: 'lost', detail: '無法啟動' });
    });
    child.on('exit', code => {
      untrack(child.pid);
      if (child !== this.child) return;
      this.exited = true;
      if (this.stopping) return;
      if (this.interrupting) {
        // 中斷是靠結束行程做的:行程結束後用同一個對話續接
        this.interrupting = false;
        this.busy = false;
        this.text.clear();
        this.tools.clear();
        this.emit({ type: 'message', role: 'agent', text: '(已中斷)' });
        this.spawn();
        return;
      }
      const reason = this.stderrTail.trim().split('\n').pop() ?? '';
      this.emit({ type: 'error', message: `agy 行程結束(代碼 ${code})${reason ? `:${reason}` : ''}` });
      this.emit({ type: 'state', state: 'lost', detail: `行程結束(${code})` });
    });
  }

  /** 寫出這次啟動要帶給 agy 的權限檔(只在本次 session 生效,agy 不會存回使用者設定);沒有任何規則時回傳 null。 */
  private settingsFile(agy: { dir: string; settings: string; server: string } | null | undefined): string | null {
    const base = agy ? [`mcp(${agy.server}/*)`] : [];
    const extra = this.opts.agyAllow ?? [];
    if (!base.length && !extra.length) return null;
    const file = agy ? agy.settings : join(tmpdir(), `nexus-agy-${this.opts.agentId.replace(/[^\w-]/g, '')}.json`);
    try { writeFileSync(file, JSON.stringify(agySettings(base, extra))); return file; } catch { return agy ? agy.settings : null; }
  }

  /** 啟動時和每個回合結束後更新帳號的剩餘額度。 */
  private reportUsage(): void {
    void readUsage(this.bin).then(windows => { if (windows) this.emit({ type: 'usage', windows }); });
  }

  send(text: string, images: string[] = []): void {
    if (this.exited) return;
    this.busy = true;
    // agy 的輸入只有文字,附件都只傳路徑,由它自己用讀檔工具查看。工作區以外的檔案它讀不到,
    // 所以先複製一份到主控台的附件資料夾(已加進工作區),並把指令裡的路徑換成複製後的
    let body = text;
    const paths: string[] = [];
    const items: Array<{ path: string; reason: string }> = [];
    for (const path of images) {
      const staged = existsSync(path) ? stageAttachment(path, this.opts.cwd) : null;
      if (staged && staged !== path) body = body.split(path).join(staged);
      paths.push(staged ?? path);
      items.push({ path, reason: !existsSync(path) ? '找不到檔案' : staged ? '由它自己讀取' : '檔案太大或無法複製,它可能讀不到工作目錄以外的檔案' });
    }
    const note = pathOnlyNote('Antigravity', items);
    if (note) this.emit(note);
    body = withPaths(body, paths);
    const agy = this.opts.interop?.agy;
    const hint = agy && this.hintInterop ? `(主控台工具:你可以用 call_mcp_tool 呼叫 MCP 伺服器「${agy.server}」的工具,把工作交給主控台面板上的其他節點或向它們提問:list_nodes 列出節點、ask_node 把指令交給某個節點並取回答覆(參數 node、prompt)、wait_reply 繼續等候(參數 request_id)、start_meeting 召開會議讓幾個節點多輪討論(參數 topic、participants、rounds)、meeting_say 會議中輪到你主持發言或結束會議(參數 request_id、text、end)。使用者沒有要求時不必使用。)

` : '';
    this.hintInterop = false;
    // 主控台只讀得到工作目錄裡的圖片(agy 把產生的圖放在自己的資料夾,不在其中);續接的對話不帶身分設定,
    // 所以這段獨立於 introduce,每個 session 物件(含續接)的第一則訊息都提示一次
    const imageHint = this.hintImage ? `(主控台顯示圖片的規則:要讓使用者在主控台對話裡看到圖片,必須把圖片存進或複製到工作目錄「${this.opts.cwd}」之內,並在回覆中用工作目錄內的路徑引用,例如 ![說明](相對路徑.png)。放在工作目錄以外的圖片(包含你自己的暫存或產生圖片的資料夾)主控台無法顯示。)

` : '';
    this.hintImage = false;
    const content = `${imageHint}${hint}${this.introduce ? `(主控台設定:${this.opts.persona})

` : ''}${body}`;
    this.introduce = false;
    this.write({ event: 'user', message: { role: 'user', content } });
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
  }

  interrupt(): void {
    if (this.exited || !this.busy || this.interrupting) return;
    // agy 沒有中斷用的輸入事件,只能結束行程;對話紀錄留在 Antigravity 那邊,續接後仍在
    this.interrupting = true;
    this.kill();
  }

  answerQuestion(): void {
    // 這個後台的無視窗模式不會向使用者提問
  }

  respondApproval(): void {
    // 這個後台不會送出授權請求
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      this.child.once('exit', done);
      this.child.stdin.end();
      const timer = setTimeout(() => { this.kill(); setTimeout(done, 1500); }, 2500);
    });
  }

  private kill(): void {
    if (process.platform === 'win32' && this.child.pid) {
      execFile('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => { /* 行程可能已經不在 */ });
    } else {
      this.child.kill('SIGKILL');
    }
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
      try { msg = JSON.parse(line); } catch { continue; }
      try { this.onMessage(msg); } catch (err) {
        this.emit({ type: 'error', message: `解析 agy 輸出失敗:${(err as Error).message}` });
      }
    }
  }

  private onMessage(m: Json): void {
    if (m.event === 'init') {
      const id = m.conversation_id;
      const resumed = this.opts.sessionId !== null;
      if (typeof id === 'string' && id !== this.opts.sessionId) {
        this.opts.sessionId = id;
        this.emit({ type: 'session', sessionId: id });
      }
      this.emit({ type: 'state', state: 'idle', detail: resumed ? '已續接' : '' });
      return;
    }

    if (m.event === 'step_update') {
      const s = m.step_update ?? {};
      const idx = Number(s.step_index);
      if (s.step_type === 'agent_response') {
        if (typeof s.text_delta === 'string') {
          this.text.set(idx, (this.text.get(idx) ?? '') + s.text_delta);
          if (s.text_delta) this.emit({ type: 'delta', text: s.text_delta });
        }
        if (s.state === 'DONE') {
          const text = (this.text.get(idx) ?? '').trim();
          this.text.delete(idx);
          if (text) this.emit({ type: 'message', role: 'agent', text });
        }
        return;
      }
      if (s.step_type === 'subagent') {
        // agy 只回報子代理「已啟動」,之後的進度與結束都不在串流裡;子節點留到這一回合結束
        const list: Json[] = s.subagent_info?.subagents ?? [];
        list.forEach((sa, i) => {
          const subId = `step-${idx}-${i}`;
          if (this.subagents.has(subId)) return;
          const name = String(sa.role || sa.type_name || '子代理').slice(0, 40);
          this.subagents.set(subId, name);
          this.emit({ type: 'subagent', phase: 'start', subId, name });
          if (typeof sa.initial_prompt === 'string') this.emit({ type: 'message', role: 'user', text: sa.initial_prompt }, subId);
          this.emit({ type: 'state', state: 'working', detail: 'Antigravity 不回報子代理的進度' }, subId);
        });
        if (list.length) this.emit({ type: 'state', state: 'working', detail: `子代理 · ${String(list[0].role || list[0].type_name || '')}` });
        return;
      }
      if (s.step_type === 'tool') {
        const info = s.tool_info ?? {};
        if (s.state === 'ACTIVE') {
          const name = String(s.tool_name ?? info.name ?? 'tool');
          const tool = { name, summary: summarize(name, info.parameters ?? {}) };
          this.tools.set(idx, tool);
          // agy 的子代理只看得到開始與結束,看不到裡面的過程
          if (SUBAGENT_TOOLS.test(name)) this.emit({ type: 'subagent', phase: 'start', subId: `step-${idx}`, name: subagentName(info.parameters ?? {}, name) });
          this.emit({ type: 'tool', phase: 'start', name: tool.name, summary: tool.summary, detail: JSON.stringify(info.parameters ?? {}, null, 2) });
          this.emit({ type: 'state', state: 'working', detail: `${tool.name} · ${tool.summary}` });
        } else if (s.state === 'DONE' || s.state === 'ERROR') {
          const tool = this.tools.get(idx) ?? { name: String(s.tool_name ?? 'tool'), summary: summarize(String(s.tool_name ?? 'tool'), info.parameters ?? {}) };
          this.tools.delete(idx);
          const failed = s.state === 'ERROR';
          if (SUBAGENT_TOOLS.test(tool.name)) this.emit({ type: 'subagent', phase: 'end', subId: `step-${idx}`, name: tool.summary, failed });
          const errText = String(info.error?.message ?? '');
          this.emit({ type: 'tool', phase: 'end', name: tool.name, summary: tool.summary, detail: String(failed ? errText : info.output ?? '').slice(0, 4000), failed });
          if (failed && /permission/i.test(errText)) {
            this.emit({ type: 'error', message: `Antigravity 自動拒絕了「${tool.name} · ${tool.summary}」。${NO_PROMPT_NOTE}` });
          }
          this.emit({ type: 'state', state: 'planning', detail: '思考中' });
        }
      }
      return;
    }

    if (m.event === 'result') {
      const r = m.result ?? {};
      const spentTokens = Number(r.usage?.total_tokens) || 0;
      if (spentTokens > 0) this.emit({ type: 'usage', spent: { tokens: spentTokens } });
      this.reportUsage();
      this.busy = false;
      this.text.clear();
      this.tools.clear();
      for (const [subId, name] of this.subagents) this.emit({ type: 'subagent', phase: 'end', subId, name });
      this.subagents.clear();
      if (r.status === 'SUCCESS') {
        this.emit({ type: 'state', state: 'idle', detail: '' });
      } else {
        const reason = String(r.error ?? r.status ?? '未知錯誤');
        this.emit({ type: 'error', message: reason.slice(0, 500) });
        this.emit({ type: 'state', state: 'error', detail: reason.slice(0, 60) });
      }
    }
  }
}
