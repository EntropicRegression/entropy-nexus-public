import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type { AdapterEvent, ApprovalDecision, AttachmentKind, Backend, Capability, TaskStep, UsageWindow } from '../../shared/types';
import { track, untrack, type Kind as ProcKind } from '../procs';
import type { Adapter, AdapterSession, Emit, StartOptions } from './adapter';

type Json = Record<string, any>;

/**
 * 一個支援 ACP(Agent Client Protocol v1)的 CLI 要怎麼啟動。
 * 想接新的 ACP CLI 時,只要填好這份設定交給 AcpAdapter。
 */
export interface AcpConfig {
  /** 對應的後台;目前只有既有的三家,新增後台時要先擴充 Backend 型別。 */
  backend: Backend;
  /** 顯示在錯誤訊息與說明裡的名稱,例如「agy」。 */
  label: string;
  /** 執行檔;Windows 上的 .cmd/.bat 會經由 cmd 啟動,.ps1 經由 PowerShell 啟動。 */
  bin: string;
  /** 啟動 ACP stdio 伺服器的參數,例如 ['acp']。 */
  args: string[];
  /** 額外的環境變數,會疊在主控台自己的環境變數上。 */
  env?: Record<string, string>;
  /** 子行程記錄用的種類(見 procs.ts)。 */
  procKind: ProcKind;
  /** agent 提供的模式代號:每次詢問與自動各對應哪一個;agent 沒有這個模式就不切換。 */
  modes?: { ask?: string; auto?: string };
  /** 查詢帳號額度;啟動時與每個回合結束後呼叫,查不到回傳 null。 */
  usage?: () => Promise<UsageWindow[] | null>;
  /** 沒有指定模型時改用的模型。 */
  defaultModel?: string;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const SUBAGENT_TOOL = /subagent/i;
const CLIENT_INFO = { name: 'entropy-nexus', title: 'Entropy Nexus', version: '0.1.0' };

/**
 * 啟動設定的執行檔。Windows 上 .cmd/.bat 墊片不能直接 spawn,比照終端機模式經由 cmd 啟動;
 * .ps1 經由 PowerShell 啟動;其餘(.exe 或 PATH 上的名稱)直接啟動。
 */
function launch(cfg: AcpConfig, cwd: string | undefined): ChildProcessWithoutNullStreams {
  const env = { ...process.env, ...(cfg.env ?? {}) };
  let file = cfg.bin, args = cfg.args;
  if (process.platform === 'win32') {
    const ext = extname(cfg.bin).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') [file, args] = ['cmd.exe', ['/d', '/c', cfg.bin, ...cfg.args]];
    else if (ext === '.ps1') [file, args] = ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.bin, ...cfg.args]];
  }
  return spawn(file, args, { cwd, env, windowsHide: true });
}

function killTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => { /* 行程可能已經不在 */ });
  } else {
    child.kill('SIGKILL');
  }
}

/** 一行一則的 JSON-RPC 2.0 連線。 */
class Rpc {
  private buf = '';
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  closed = false;

  constructor(
    private child: ChildProcessWithoutNullStreams,
    private onRequest: (m: Json) => void,
    private onNotify: (m: Json) => void,
    private onBadLine: (err: Error) => void,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => this.onData(d));
    child.stdin.on('error', () => { /* 行程已結束,由 exit 事件處理 */ });
  }

  write(obj: Json): void {
    if (this.closed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  }

  request(method: string, params: Json): Promise<Json> {
    return new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('行程已結束')); return; }
      const id = this.nextId++;
      this.waiting.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  close(err: Error): void {
    this.closed = true;
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let m: Json;
      try { m = JSON.parse(line); } catch { continue; }
      try {
        if (m.method === undefined && m.id !== undefined) {
          const w = this.waiting.get(m.id);
          if (!w) continue;
          this.waiting.delete(m.id);
          if (m.error) w.reject(new Error(String(m.error.message ?? 'agent 回報錯誤')));
          else w.resolve(m.result ?? {});
        } else if (m.id !== undefined) {
          this.onRequest(m);
        } else {
          this.onNotify(m);
        }
      } catch (err) {
        this.onBadLine(err as Error);
      }
    }
  }
}

/**
 * 通用的 ACP 轉接器:啟動設定的 CLI,在 stdio 上以 JSON-RPC 對話。
 * client 端能力保守宣告:不提供檔案系統與終端機,agent 用自己的工具讀寫檔案與執行指令。
 */
export class AcpAdapter implements Adapter {
  readonly backend: Backend;

  constructor(private cfg: AcpConfig) {
    this.backend = cfg.backend;
  }

  async probe(): Promise<Capability> {
    const info = await probeAcp(this.cfg);
    const base = { backend: this.cfg.backend, simulated: false, fork: false, models: [] as string[], attachments: [] as AttachmentKind[], interject: false };
    if (!info) return { ...base, available: false, version: null, approvals: false, interrupt: false, resume: false, note: `無法以 ACP 啟動 ${this.cfg.label}。` };
    return { ...base, available: true, version: info.version, approvals: true, interrupt: true, resume: info.resume, note: `${info.name} ${info.version ?? ''}(ACP)`.trim() };
  }

  start(opts: StartOptions, emit: Emit): AdapterSession {
    return new AcpSession(this.cfg, opts, emit);
  }
}

/** 只做 initialize 握手就結束,不建立 session、不花額度。 */
export function probeAcp(cfg: AcpConfig): Promise<{ name: string; version: string | null; resume: boolean; agentCapabilities: Json } | null> {
  return new Promise(resolve => {
    let child: ChildProcessWithoutNullStreams;
    try { child = launch(cfg, undefined); } catch { resolve(null); return; }
    let done = false;
    const finish = (v: Awaited<ReturnType<typeof probeAcp>>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      rpc.close(new Error('探測結束'));
      try { child.stdin.end(); } catch { /* 已結束 */ }
      setTimeout(() => { if (child.exitCode === null) killTree(child); }, 1500);
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), 15000);
    const rpc = new Rpc(child, m => rpc.write({ id: m.id, error: { code: -32601, message: 'probe' } }), () => { /* 略過 */ }, () => { /* 略過 */ });
    child.stderr.resume();
    child.on('error', () => finish(null));
    child.on('exit', () => finish(null));
    rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: CLIENT_INFO })
      .then(r => {
        const caps: Json = r.agentCapabilities ?? {};
        finish({
          name: String(r.agentInfo?.title ?? r.agentInfo?.name ?? cfg.label),
          version: r.agentInfo?.version ? String(r.agentInfo.version) : null,
          resume: Boolean(caps.loadSession || caps.sessionCapabilities?.resume || caps.sessionCapabilities?.load),
          agentCapabilities: caps,
        });
      })
      .catch(() => finish(null));
  });
}

interface PendingPermission { rpcId: number | string; options: Json[] }

/** 工具參數裡的檔案路徑(頂層與下一層的 path、file_path、TargetFile 之類,加上 ACP 的 locations[].path)。 */
function toolPaths(input: Json, locations: unknown): string[] {
  const keys = /^(?:path|file_?path|notebook_path|target_?file|absolute_?path|destination|new_path|old_path)$/i;
  const out: string[] = [];
  const take = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 1) return;
    for (const [k, v] of Object.entries(o as Json)) {
      if (typeof v === 'string' && keys.test(k) && v.length < 1000) out.push(v);
      else if (v && typeof v === 'object') take(v, depth + 1);
    }
  };
  take(input, 0);
  if (Array.isArray(locations)) for (const l of locations) if (typeof l?.path === 'string') out.push(l.path);
  return [...new Set(out)].slice(0, 50);
}

function subagentName(input: Json, fallback: string): string {
  for (const k of ['Role', 'Name', 'SubagentName', 'TaskName', 'description', 'Task', 'Prompt', 'prompt']) {
    if (typeof input[k] === 'string' && input[k].trim()) return input[k].trim().split('\n')[0].slice(0, 40);
  }
  return fallback;
}

/** 從 ACP 工具內容取出要顯示的文字。 */
function toolOutput(u: Json): string {
  const parts: string[] = [];
  for (const c of Array.isArray(u.content) ? u.content : []) {
    if (c?.type === 'content' && typeof c.content?.text === 'string') parts.push(c.content.text);
    else if (c?.type === 'diff') parts.push(`${c.path ?? ''}\n${c.newText ?? ''}`);
  }
  if (!parts.join('').trim() && u.rawOutput !== undefined && u.rawOutput !== null) {
    parts.push(typeof u.rawOutput?.output === 'string' ? u.rawOutput.output : typeof u.rawOutput === 'string' ? u.rawOutput : JSON.stringify(u.rawOutput, null, 2));
  }
  return parts.join('\n').slice(0, 4000);
}

function toolName(u: Json, fallback = 'tool'): string {
  return String(u.name ?? u._meta?.name ?? u.kind ?? fallback);
}

function toolSummary(u: Json): string {
  const input: Json = u.rawInput ?? {};
  if (typeof u.title === 'string' && u.title.trim()) return u.title.replace(/\s+/g, ' ').slice(0, 100);
  const loc = u.locations?.[0]?.path;
  if (typeof loc === 'string') return basename(loc);
  if (typeof input.CommandLine === 'string') return input.CommandLine.replace(/\s+/g, ' ').slice(0, 100);
  const s = JSON.stringify(input);
  return s === '{}' ? toolName(u) : s.slice(0, 80);
}

export class AcpSession implements AdapterSession {
  private child: ChildProcessWithoutNullStreams;
  private rpc: Rpc;
  private stderrTail = '';
  private sessionId: string | null = null;
  private ready: Promise<void>;
  private stopping = false;
  private exited = false;
  private busy = false;
  private interrupting = false;
  /** session/load 會先重播整段對話;重播期間的事件主控台已經有了,略過。 */
  private replaying = false;
  private caps: Json = {};
  private permissions = new Map<string, PendingPermission>();
  private tools = new Map<string, { name: string; summary: string }>();
  private subagents = new Map<string, string>();
  /** 目前這則回覆累積的文字;遇到工具呼叫或回合結束時整則送出。 */
  private text = '';
  private messageId: string | null = null;
  /** 沒有系統提示的參數,身分設定改在新對話的第一則訊息前面帶上。 */
  private introduce: boolean;
  /** 自動模式下 agent 沒有對應的模式時,由主控台直接允許所有授權請求。 */
  private autoAllow = false;

  constructor(private cfg: AcpConfig, private opts: StartOptions, private emit: Emit) {
    this.introduce = Boolean(opts.persona) && !opts.sessionId;
    this.child = launch(cfg, opts.cwd);
    track(this.child.pid, cfg.procKind);
    this.rpc = new Rpc(this.child, m => this.onRequest(m), m => this.onNotify(m), err => {
      this.emit({ type: 'error', message: `解析 ${cfg.label} 輸出失敗:${err.message}` });
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-600); });
    this.child.on('error', err => {
      this.exited = true;
      this.rpc.close(err);
      this.emit({ type: 'error', message: `無法啟動 ${cfg.label}:${err.message}` });
      this.emit({ type: 'state', state: 'lost', detail: '無法啟動' });
    });
    this.child.on('exit', code => {
      untrack(this.child.pid);
      if (this.exited) return;
      this.exited = true;
      this.rpc.close(new Error(`${cfg.label} 行程已結束`));
      if (this.stopping) return;
      for (const id of this.permissions.keys()) this.emit({ type: 'approval_resolved', requestId: id, decision: 'deny' });
      this.permissions.clear();
      const reason = this.stderrTail.trim().split('\n').pop() ?? '';
      this.emit({ type: 'error', message: `${cfg.label} 行程結束(代碼 ${code})${reason ? `:${reason}` : ''}` });
      this.emit({ type: 'state', state: 'lost', detail: `行程結束(${code})` });
    });
    this.ready = this.handshake();
    this.ready.catch(err => {
      if (this.stopping || this.exited) return;
      this.emit({ type: 'error', message: `${cfg.label} 啟動失敗:${err.message}` });
      this.emit({ type: 'state', state: 'error', detail: String(err.message).slice(0, 60) });
    });
    this.reportUsage();
  }

  private async handshake(): Promise<void> {
    const init = await this.rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: CLIENT_INFO,
    });
    this.caps = init.agentCapabilities ?? {};
    const where = { cwd: this.opts.cwd, mcpServers: [] };
    let res: Json;
    const old = this.opts.sessionId;
    if (old && this.caps.sessionCapabilities?.resume) {
      // resume 不重播對話,最省事
      res = await this.rpc.request('session/resume', { sessionId: old, ...where });
    } else if (old && this.caps.loadSession) {
      this.replaying = true;
      try { res = await this.rpc.request('session/load', { sessionId: old, ...where }); } finally { this.replaying = false; }
    } else {
      if (old) this.emit({ type: 'error', message: `${this.cfg.label} 不支援續接舊對話,已改開新的對話。` });
      res = await this.rpc.request('session/new', where);
    }
    this.sessionId = String(res.sessionId ?? old ?? '');
    if (!this.sessionId) throw new Error('agent 沒有回傳 session id');
    if (this.sessionId !== old) this.emit({ type: 'session', sessionId: this.sessionId });

    // 權限模式:agent 有對應的模式就切過去;自動模式找不到對應的模式時,由主控台自動允許
    const modes: string[] = (res.modes?.availableModes ?? []).map((m: Json) => String(m.id));
    const want = this.opts.permissionMode === 'auto' ? this.cfg.modes?.auto : this.cfg.modes?.ask;
    if (want && modes.includes(want)) {
      if (res.modes?.currentModeId !== want) await this.rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: want });
    } else if (this.opts.permissionMode === 'auto') {
      this.autoAllow = true;
    }

    const model = this.opts.model || this.cfg.defaultModel;
    if (model) {
      await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: model }).catch(err => {
        this.emit({ type: 'error', message: `${this.cfg.label} 無法切換到模型 ${model}:${(err as Error).message}` });
      });
    }
    this.emit({ type: 'state', state: 'idle', detail: old ? '已續接' : '' });
  }

  private reportUsage(): void {
    if (!this.cfg.usage) return;
    void this.cfg.usage().then(windows => { if (windows) this.emit({ type: 'usage', windows }); }).catch(() => { /* 查不到就略過 */ });
  }

  send(text: string, images: string[] = []): void {
    if (this.exited) return;
    this.busy = true;
    this.interrupting = false;
    const content = this.introduce ? `(主控台設定:${this.opts.persona})\n\n${text}` : text;
    this.introduce = false;
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
    void this.ready.then(() => {
      const prompt: Json[] = [{ type: 'text', text: content }];
      // 圖片以 base64 內嵌;agent 沒有宣告支援圖片時只送文字(路徑已寫在指令裡)
      if (images.length && this.caps.promptCapabilities?.image) {
        for (const path of images) {
          const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
          try {
            if (!mimeType) throw new Error('不支援的圖片格式');
            if (statSync(path).size > 5 * 1024 * 1024) throw new Error('超過 5 MB');
            prompt.push({ type: 'image', mimeType, data: readFileSync(path).toString('base64') });
          } catch (err) {
            this.emit({ type: 'error', message: `圖片 ${basename(path)} 沒有附上:${(err as Error).message}` });
          }
        }
      }
      return this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt });
    }).then(r => this.onTurnEnd(r), err => {
      this.busy = false;
      this.flushText();
      if (this.stopping || this.exited) return;
      this.emit({ type: 'error', message: `送出指令失敗:${(err as Error).message}` });
      this.emit({ type: 'state', state: 'error', detail: String((err as Error).message).slice(0, 60) });
    });
  }

  interrupt(): void {
    if (this.exited || !this.busy || !this.sessionId) return;
    this.interrupting = true;
    // 規格要求:送出取消後,等待中的授權一律回覆 cancelled
    this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    for (const [requestId, p] of this.permissions) {
      this.rpc.write({ id: p.rpcId, result: { outcome: { outcome: 'cancelled' } } });
      this.emit({ type: 'approval_resolved', requestId, decision: 'deny' });
    }
    this.permissions.clear();
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    const p = this.permissions.get(requestId);
    if (!p) return;
    this.permissions.delete(requestId);
    this.answerPermission(p, decision);
    this.emit({ type: 'approval_resolved', requestId, decision });
    this.emit({ type: 'state', state: decision === 'deny' ? 'planning' : 'working', detail: decision === 'deny' ? '思考中' : '執行已授權的動作' });
  }

  answerQuestion(): void {
    // ACP 沒有向使用者提問的方法
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      this.child.once('exit', done);
      this.child.stdin.end();
      const timer = setTimeout(() => { killTree(this.child); setTimeout(done, 1500); }, 2500);
    });
  }

  /** 把主控台的決定對應到 agent 提供的選項。 */
  private answerPermission(p: PendingPermission, decision: ApprovalDecision): void {
    const byKind = (...kinds: string[]) => kinds.map(k => p.options.find(o => o.kind === k)).find(Boolean);
    const option = decision === 'allow' ? byKind('allow_once', 'allow_always')
      : decision === 'allow_session' ? byKind('allow_always', 'allow_once')
      : byKind('reject_once', 'reject_always');
    if (option) this.rpc.write({ id: p.rpcId, result: { outcome: { outcome: 'selected', optionId: option.optionId } } });
    else this.rpc.write({ id: p.rpcId, result: { outcome: { outcome: 'cancelled' } } });
  }

  private onRequest(m: Json): void {
    if (m.method !== 'session/request_permission') {
      // 沒有宣告 fs 與 terminal,其他請求一律明確回覆不支援,避免 agent 一直等
      this.rpc.write({ id: m.id, error: { code: -32601, message: `Entropy Nexus 不支援 ${m.method}` } });
      return;
    }
    const params = m.params ?? {};
    const tc: Json = params.toolCall ?? {};
    const known = this.tools.get(String(tc.toolCallId));
    const pending: PendingPermission = { rpcId: m.id, options: Array.isArray(params.options) ? params.options : [] };
    if (this.interrupting) { this.rpc.write({ id: m.id, result: { outcome: { outcome: 'cancelled' } } }); return; }
    if (this.autoAllow) { this.answerPermission(pending, 'allow'); return; }
    const requestId = `acp-${m.id}`;
    this.permissions.set(requestId, pending);
    const tool = known?.name ?? toolName(tc);
    const summary = tc.title || tc.rawInput ? toolSummary(tc) : known?.summary ?? tool;
    const detail = tc.rawInput ? JSON.stringify(tc.rawInput, null, 2).slice(0, 4000) : undefined;
    this.emit({ type: 'approval_request', requestId, tool, summary, detail, canAllowSession: pending.options.some(o => o.kind === 'allow_always') });
    this.emit({ type: 'state', state: 'awaiting', detail: `${tool} · ${summary}` });
  }

  private onNotify(m: Json): void {
    if (m.method !== 'session/update') return;
    const u: Json = m.params?.update ?? {};
    if (u.sessionUpdate === 'usage_update') {
      const used = Number(u.used) || 0, max = Number(u.size) || 0;
      if (used > 0 && max > 0) this.emit({ type: 'usage', context: { used, max } });
      return;
    }
    if (this.replaying) return;

    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (u.messageId && u.messageId !== this.messageId) { this.flushText(); this.messageId = u.messageId; }
        if (!t) return;
        this.text += t;
        this.emit({ type: 'delta', text: t });
        return;
      }
      case 'agent_thought_chunk':
        if (!this.permissions.size && !this.interrupting) this.emit({ type: 'state', state: 'planning', detail: '思考中' });
        return;
      case 'plan':
        if (Array.isArray(u.entries)) {
          this.emit({ type: 'plan', steps: u.entries.map((e: Json): TaskStep => ({ text: String(e.content ?? '').slice(0, 160), status: e.status === 'completed' ? 'done' : e.status === 'in_progress' ? 'active' : 'pending' })) });
        }
        return;
      case 'tool_call':
      case 'tool_call_update':
        this.onTool(u);
        return;
      default:
        return;
    }
  }

  private onTool(u: Json): void {
    const id = String(u.toolCallId ?? '');
    if (!id) return;
    let tool = this.tools.get(id);
    if (!tool) {
      this.flushText();
      tool = { name: toolName(u), summary: toolSummary(u) };
      this.tools.set(id, tool);
      const input: Json = u.rawInput ?? {};
      if (SUBAGENT_TOOL.test(tool.name) && !this.subagents.has(id)) {
        // 子代理只看得到啟動;它在背景執行,工具本身很快就回報完成,子節點留到這一回合結束
        const name = subagentName(input, tool.name);
        this.subagents.set(id, name);
        this.emit({ type: 'subagent', phase: 'start', subId: id, name });
        const prompt = input.Prompt ?? input.prompt;
        if (typeof prompt === 'string') this.emit({ type: 'message', role: 'user', text: prompt }, id);
        this.emit({ type: 'state', state: 'working', detail: `${this.cfg.label} 不回報子代理的進度` }, id);
      }
      // 明細只留 4000 字,檔案路徑在截斷前另外取出(協作流程的範圍合約用來判斷寫入)
      const paths = toolPaths(input, u.locations);
      this.emit({ type: 'tool', phase: 'start', name: tool.name, summary: tool.summary, detail: JSON.stringify(input, null, 2).slice(0, 4000), ...(paths.length ? { paths } : {}) });
      if (!this.permissions.size) this.emit({ type: 'state', state: 'working', detail: `${tool.name} · ${tool.summary}` });
    }
    if (u.status === 'completed' || u.status === 'failed') {
      this.tools.delete(id);
      const failed = u.status === 'failed';
      this.emit({ type: 'tool', phase: 'end', name: tool.name, summary: tool.summary, detail: toolOutput(u), failed });
      if (!this.permissions.size && !this.interrupting) this.emit({ type: 'state', state: 'planning', detail: '思考中' });
    }
  }

  private flushText(): void {
    const text = this.text.trim();
    this.text = '';
    if (text) this.emit({ type: 'message', role: 'agent', text });
  }

  private onTurnEnd(r: Json): void {
    this.busy = false;
    this.flushText();
    this.messageId = null;
    this.tools.clear();
    for (const [subId, name] of this.subagents) this.emit({ type: 'subagent', phase: 'end', subId, name });
    this.subagents.clear();
    const spent = Number(r.usage?.totalTokens) || 0;
    if (spent > 0) this.emit({ type: 'usage', spent: { tokens: spent } });
    this.reportUsage();
    const reason = String(r.stopReason ?? 'end_turn');
    if (this.interrupting || reason === 'cancelled') {
      this.interrupting = false;
      this.emit({ type: 'message', role: 'agent', text: '(已中斷)' });
      this.emit({ type: 'state', state: 'idle', detail: '已中斷', outcome: 'interrupted' });
    } else if (reason === 'end_turn') {
      this.emit({ type: 'state', state: 'idle', detail: '' });
    } else {
      const why = reason === 'max_tokens' ? '達到 token 上限' : reason === 'max_turn_requests' ? '達到單回合的請求上限' : reason === 'refusal' ? 'agent 拒絕繼續' : reason;
      this.emit({ type: 'error', message: `回合提前結束:${why}` });
      this.emit({ type: 'state', state: 'error', detail: why.slice(0, 60) });
    }
  }
}
