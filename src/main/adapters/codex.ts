import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { attachmentKind, type AdapterEvent, type ApprovalDecision, type Capability, type ExternalSession } from '../../shared/types';
import { listCodexSessions } from '../sessions';
import { imageFromFile, saveImage } from '../media';
import { track, untrack } from '../procs';
import { pathOnlyNote, withPaths, type Adapter, type AdapterSession, type Emit, type StartOptions } from './adapter';

type Json = Record<string, any>;

const run = (file: string, args: string[]): Promise<string | null> =>
  new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 20000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
  });

/**
 * 尋找 codex 執行檔。順序:NEXUS_CODEX_BIN → PATH 上的 codex → Codex 桌面版內附的 codex.exe。
 * 桌面版的安裝路徑含版本號且資料夾不能直接列出,所以向系統查詢套件位置。
 */
async function findCodex(): Promise<{ bin: string; source: string } | null> {
  const override = process.env.NEXUS_CODEX_BIN;
  if (override && existsSync(override)) return { bin: override, source: '手動指定' };
  if (await run('codex', ['--version'])) return { bin: 'codex', source: 'PATH' };
  if (process.platform === 'win32') {
    const loc = await run('powershell.exe', ['-NoProfile', '-Command', '(Get-AppxPackage -Name OpenAI.Codex).InstallLocation']);
    const bin = loc ? join(loc, 'app', 'resources', 'codex.exe') : '';
    if (bin && existsSync(bin)) return { bin, source: 'Codex 桌面版內附' };
  }
  return null;
}

/**
 * Codex 轉接器:啟動 `codex app-server`,在 stdio 上以一行一則 JSON-RPC 訊息溝通。
 * 使用的是使用者自己安裝並登入的 Codex,不經手任何憑證。
 */
export class CodexAdapter implements Adapter {
  readonly backend = 'codex' as const;
  private bin: string | null = null;

  async probe(): Promise<Capability> {
    const found = await findCodex();
    const version = found ? (await run(found.bin, ['--version']))?.replace(/^codex-cli\s+/, '') ?? null : null;
    this.bin = found && version ? found.bin : null;
    const models = this.bin ? await listModels(this.bin) : [];
    return {
      backend: 'codex',
      available: this.bin !== null,
      simulated: false,
      version,
      approvals: true,
      interrupt: true,
      resume: true,
      fork: this.bin !== null,
      note: this.bin ? `Codex ${version}(${found!.source})` : '找不到 codex。請安裝 Codex CLI 或 Codex 桌面版並完成登入。',
      models,
      attachments: ['image'],
      interject: true,
    };
  }

  async listSessions(): Promise<ExternalSession[]> {
    return this.bin ? listCodexSessions(this.bin) : [];
  }

  terminalCommand(sessionId: string | null, model: string): { file: string; args: string[] } {
    return { file: this.bin ?? 'codex', args: [...(sessionId ? ['resume', sessionId] : []), ...(model ? ['-m', model] : [])] };
  }

  start(opts: StartOptions, emit: Emit): AdapterSession {
    return new CodexSession(this.bin ?? 'codex', opts, emit);
  }
}

/** 向 app-server 查詢可選的模型;查不到就回傳空清單,不影響其他功能。 */
function listModels(bin: string): Promise<string[]> {
  return new Promise(resolve => {
    let done = false;
    const child = spawn(bin, ['app-server'], { windowsHide: true });
    const finish = (models: string[]) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.end(); child.kill(); } catch { /* 已結束 */ } resolve(models); };
    const timer = setTimeout(() => finish([]), 10000);
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: Json;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ method: 'model/list', id: 2, params: { limit: 50 } })}\n`); }
        if (m.id === 2) finish(Array.isArray(m.result?.data) ? m.result.data.filter((x: Json) => !x.hidden).map((x: Json) => String(x.model ?? x.id)) : []);
      }
    });
    child.stdin.on('error', () => finish([]));
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'entropy-nexus', title: 'Entropy Nexus', version: '0.1.0' }, capabilities: null } })}\n`);
  });
}

interface PendingApproval { rpcId: number | string }

class CodexSession implements AdapterSession {
  private child: ChildProcessWithoutNullStreams;
  private buf = '';
  private stderrTail = '';
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private approvals = new Map<string, PendingApproval>();
  private items = new Map<string, { name: string; summary: string; paths?: string[] }>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private ready: Promise<void>;
  private stopping = false;
  private exited = false;
  private interrupting = false;
  /** 這個 thread 產生的子代理 thread:id → 名稱;結束後移到 endedSubs。 */
  private subThreads = new Map<string, string>();
  private endedSubs = new Set<string>();
  /** 等待使用者作答的提問:request id → JSON-RPC id。 */
  private questions = new Map<string, number | string>();
  private tokensSeen = 0;

  constructor(bin: string, private opts: StartOptions, private emit: Emit) {
    this.child = spawn(bin, ['app-server'], { cwd: opts.cwd, windowsHide: true });
    track(this.child.pid, 'codex');
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d: string) => this.onStdout(d));
    // Codex 會把個人設定裡連不上的 MCP 伺服器等訊息寫到 stderr,只留尾端供失聯時參考
    this.child.stderr.on('data', (d: string) => { this.stderrTail = (this.stderrTail + d).slice(-600); });
    this.child.stdin.on('error', () => { /* 行程已結束,由 exit 事件處理 */ });
    this.child.on('error', err => {
      this.exited = true;
      this.failAll(err);
      this.emit({ type: 'error', message: `無法啟動 codex:${err.message}` });
      this.emit({ type: 'state', state: 'lost', detail: '無法啟動' });
    });
    this.child.on('exit', code => {
      untrack(this.child.pid);
      this.exited = true;
      this.failAll(new Error('codex 行程已結束'));
      if (this.stopping) return;
      this.emit({ type: 'error', message: `codex 行程結束(代碼 ${code})` });
      this.emit({ type: 'state', state: 'lost', detail: `行程結束(${code})` });
    });
    this.ready = this.handshake();
    this.ready.catch(err => {
      if (this.stopping || this.exited) return;
      this.emit({ type: 'error', message: `Codex 啟動失敗:${err.message}` });
      this.emit({ type: 'state', state: 'error', detail: String(err.message).slice(0, 60) });
    });
  }

  private async handshake(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'entropy-nexus', title: 'Entropy Nexus', version: '0.1.0' }, capabilities: null });
    this.write({ method: 'initialized' });
    // 每次詢問:不信任的指令都要核准;自動:只有需要超出工作目錄的權限時才詢問
    const params = {
      cwd: this.opts.cwd,
      approvalPolicy: this.opts.permissionMode === 'auto' ? 'on-request' : 'untrusted',
      sandbox: 'workspace-write',
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.persona ? { developerInstructions: this.opts.persona } : {}),
      // 節點互相呼叫:用這個 thread 的 config 掛上主控台的工具服務,疊加在使用者自己的 MCP 設定上,不動 ~/.codex/config.toml。
      // default_tools_approval_mode 讓這個伺服器的工具不經 Codex 自己的授權(要不要問使用者由主控台依節點的權限模式決定);
      // 逾時明確設定,不依賴預設值(以 codex-cli 0.169.0 實測:thread/start 的 config.mcp_servers 可用,HTTP 型 url 可用)
      ...(this.opts.interop ? { config: { mcp_servers: { [this.opts.interop.name]: { url: this.opts.interop.url, default_tools_approval_mode: 'approve', tool_timeout_sec: 120 } } } } : {}),
    };
    // 分支對話:`thread/fork` 的參數是 { threadId: 來源, excludeTurns, cwd, approvalPolicy, sandbox, model, developerInstructions … },
    // 回應的 thread.id 是新的 thread,並且立刻寫到 ~/.codex/sessions,之後可以直接用 thread/resume 續接
    // (以 codex-cli 0.169.0 的 `codex app-server generate-ts` 產生的 ThreadForkParams/ThreadForkResponse 為準,並已實測)。
    const res = this.opts.sessionId
      ? await this.request('thread/resume', { threadId: this.opts.sessionId, excludeTurns: true, ...params })
      : this.opts.forkFrom
        ? await this.request('thread/fork', { threadId: this.opts.forkFrom, excludeTurns: true, ...params })
        : await this.request('thread/start', params);
    this.threadId = res.thread?.id ?? null;
    if (!this.threadId) throw new Error('Codex 沒有回傳 thread id');
    if (this.opts.forkFrom && !this.opts.sessionId && this.threadId === this.opts.forkFrom) { this.threadId = null; throw new Error('Codex 沒有建立新的分支 thread'); }
    if (this.threadId !== this.opts.sessionId) this.emit({ type: 'session', sessionId: this.threadId });
    // 啟動時就先問一次額度,不必等第一個回合
    this.request('account/rateLimits/read', {}).then(r => this.reportLimits(r.rateLimits)).catch(() => { /* 這個版本不支援就略過 */ });
    this.emit({ type: 'state', state: 'idle', detail: this.opts.sessionId ? '已續接' : this.opts.forkFrom ? '已分支' : '' });
  }

  send(text: string, images: string[] = []): void {
    if (this.exited) return;
    this.interrupting = false;
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
    // app-server 的輸入項目只有圖片能確定交給模型看(localImage);其他類型改傳路徑並告訴使用者。
    // schema 雖然也有 localAudio,但一般的 Codex 模型不一定收音訊,先不內嵌。
    const embed = images.filter(p => attachmentKind(p) === 'image' && existsSync(p));
    const rest = images.filter(p => !embed.includes(p));
    const note = pathOnlyNote('Codex', rest.map(path => ({ path, reason: existsSync(path) ? 'Codex 只能內嵌圖片' : '找不到檔案' })));
    if (note) this.emit(note);
    const input: Json[] = [{ type: 'text', text: withPaths(text, rest), text_elements: [] }, ...embed.map(path => ({ type: 'localImage', path }))];
    void this.ready
      .then(() => this.request('turn/start', { threadId: this.threadId, input }))
      .then(res => { this.turnId = res.turn?.id ?? this.turnId; })
      .catch(err => {
        if (this.stopping || this.exited) return;
        this.emit({ type: 'error', message: `送出指令失敗:${err.message}` });
        this.emit({ type: 'state', state: 'error', detail: String(err.message).slice(0, 60) });
      });
  }

  interrupt(): void {
    if (this.exited || !this.threadId || !this.turnId) return;
    this.interrupting = true;
    for (const [requestId, p] of this.approvals) {
      this.write({ id: p.rpcId, result: { decision: 'cancel' } });
      this.emit({ type: 'approval_resolved', requestId, decision: 'deny' });
    }
    this.approvals.clear();
    for (const [requestId, rpcId] of this.questions) {
      this.write({ id: rpcId, result: { answers: {} } });
      this.emit({ type: 'question_resolved', requestId, answers: null });
    }
    this.questions.clear();
    this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => { /* 回合可能剛好結束 */ });
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    const p = this.approvals.get(requestId);
    if (!p) return;
    this.approvals.delete(requestId);
    const mapped = decision === 'allow' ? 'accept' : decision === 'allow_session' ? 'acceptForSession' : 'decline';
    this.write({ id: p.rpcId, result: { decision: mapped } });
    this.emit({ type: 'approval_resolved', requestId, decision });
    this.emit({ type: 'state', state: decision === 'deny' ? 'planning' : 'working', detail: decision === 'deny' ? '思考中' : '執行已授權的動作' });
  }

  answerQuestion(requestId: string, answers: Record<string, string[]> | null): void {
    const rpcId = this.questions.get(requestId);
    if (rpcId === undefined) return;
    this.questions.delete(requestId);
    const mapped: Record<string, { answers: string[] }> = {};
    for (const [id, list] of Object.entries(answers ?? {})) mapped[id] = { answers: list };
    this.write({ id: rpcId, result: { answers: mapped } });
    this.emit({ type: 'question_resolved', requestId, answers });
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.exited) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      this.child.once('exit', done);
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

  private reportLimits(limits: Json | undefined): void {
    if (!limits) return;
    const label = (mins: number) => (mins === 300 ? '5 小時' : mins === 10080 ? '每週' : mins >= 1440 ? `${Math.round(mins / 1440)} 天` : `${Math.round(mins / 60)} 小時`);
    const windows = [limits.primary, limits.secondary]
      .filter((w: Json | null) => w && typeof w.usedPercent === 'number')
      .map((w: Json) => ({ label: label(Number(w.windowDurationMins) || 0), used: w.usedPercent / 100, resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : null }));
    if (windows.length) this.emit({ type: 'usage', windows });
  }

  private write(obj: Json): void {
    if (this.exited || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  private request(method: string, params: Json): Promise<Json> {
    return new Promise((resolve, reject) => {
      if (this.exited) { reject(new Error('codex 行程已結束')); return; }
      const id = this.nextId++;
      this.waiting.set(id, { resolve, reject });
      this.write({ method, id, params });
    });
  }

  private failAll(err: Error): void {
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
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
      try {
        if (msg.id !== undefined && msg.method === undefined) this.onResponse(msg);
        else if (msg.id !== undefined) this.onServerRequest(msg);
        else this.onNotification(msg);
      } catch (err) {
        this.emit({ type: 'error', message: `解析 codex 輸出失敗:${(err as Error).message}` });
      }
    }
  }

  private onResponse(m: Json): void {
    const w = this.waiting.get(m.id);
    if (!w) return;
    this.waiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error.message ?? 'Codex 回報錯誤'));
    else w.resolve(m.result ?? {});
  }

  private onServerRequest(m: Json): void {
    const p = m.params ?? {};
    if (m.method === 'item/commandExecution/requestApproval' || m.method === 'item/fileChange/requestApproval') {
      const requestId = `codex-${m.id}`;
      this.approvals.set(requestId, { rpcId: m.id });
      const known = this.items.get(p.itemId);
      const isCommand = m.method.includes('commandExecution');
      const tool = isCommand ? 'Shell' : 'Patch';
      const summary = isCommand ? describeCommand(p) : known?.summary ?? p.reason ?? '修改檔案';
      const detail = isCommand
        ? [p.command, p.cwd ? `cwd: ${p.cwd}` : '', p.reason ? `原因: ${p.reason}` : ''].filter(Boolean).join('\n')
        : [known?.paths?.length ? known.paths.join('\n') : known?.summary, p.reason ? `原因: ${p.reason}` : '', p.grantRoot ? `要求寫入: ${p.grantRoot}` : ''].filter(Boolean).join('\n');
      // 檔案修改的授權:附上完整路徑(摘要只有檔名),協作流程的範圍合約用來判斷寫到哪裡
      const paths = isCommand ? [] : [...(known?.paths ?? []), ...(p.grantRoot ? [String(p.grantRoot)] : [])];
      this.emit({ type: 'approval_request', requestId, tool, summary, detail, canAllowSession: true, ...(paths.length ? { paths } : {}) });
      this.emit({ type: 'state', state: 'awaiting', detail: `${tool} · ${summary}` });
      return;
    }
    if (m.method === 'item/tool/requestUserInput' && Array.isArray(p.questions)) {
      const requestId = `codex-q-${m.id}`;
      this.questions.set(requestId, m.id);
      this.emit({
        type: 'question', requestId,
        questions: p.questions.map((q: Json) => ({
          id: String(q.id), header: String(q.header ?? ''), question: String(q.question ?? ''), multi: false,
          options: (q.options ?? []).map((o: Json) => ({ label: String(o.label ?? ''), description: String(o.description ?? '') })),
        })),
      });
      this.emit({ type: 'state', state: 'awaiting', detail: '等你回答' });
      return;
    }
    // 其他伺服器請求目前不支援,明確回覆錯誤避免 Codex 一直等
    this.write({ id: m.id, error: { code: -32601, message: `Entropy Nexus 不支援 ${m.method}` } });
  }

  /**
   * 圖片類的 item:imageView 是模型看了一張本機圖片(只有路徑),imageGeneration 是生成的圖片
   * (有存檔路徑 savedPath,或只有 base64 的 result)。轉成圖片事件,處理過就回傳 true。
   */
  private onImageItem(it: Json, emit: (e: AdapterEvent) => void): boolean {
    let path: string | null = null;
    let caption = '';
    if (it.type === 'imageView' && typeof it.path === 'string') {
      path = imageFromFile(this.opts.agentId, this.opts.cwd, it.path);
      caption = `檢視圖片 · ${basename(it.path)}`;
    } else if (it.type === 'imageGeneration') {
      if (typeof it.savedPath === 'string') path = imageFromFile(this.opts.agentId, this.opts.cwd, it.savedPath);
      else if (typeof it.result === 'string' && it.result) path = saveImage(this.opts.agentId, it.result.replace(/^data:[^,]*,/, ''), 'image/png');
      caption = `生成圖片${it.revisedPrompt ? ` · ${String(it.revisedPrompt).slice(0, 120)}` : ''}`;
      // failure 目前只有 { type: 'usageLimitExceeded' } 一種;只有 fileId 沒有內容的結果無法顯示,略過
      if (!path && (it.failure || it.status === 'failed')) { emit({ type: 'note', text: `圖片生成失敗${it.failure?.type === 'usageLimitExceeded' ? ':圖片生成額度已用完' : ''}` }); return true; }
    } else {
      return false;
    }
    if (path) emit({ type: 'image', path, caption });
    return true;
  }

  private onNotification(m: Json): void {
    const p = m.params ?? {};
    // app-server 會把子代理 thread 的事件也送過來;屬於子代理的記到子節點,不認識的 thread 一律略過
    let sub: string | undefined;
    if (typeof p.threadId === 'string' && this.threadId && p.threadId !== this.threadId) {
      if (!this.subThreads.has(p.threadId)) return;
      sub = p.threadId;
    }
    const emit = (e: AdapterEvent) => this.emit(e, sub);

    switch (m.method) {
      case 'account/rateLimits/updated':
        this.reportLimits(p.rateLimits);
        return;

      case 'thread/tokenUsage/updated': {
        const u = p.tokenUsage ?? {};
        const used = Number(u.last?.totalTokens) || 0, max = Number(u.modelContextWindow) || 0;
        if (!sub && used > 0 && max > 0) this.emit({ type: 'usage', context: { used, max } });
        // 花費:thread 的累計 token 數,取與上次的差(Codex 不回報金額)
        const totalTokens = Number(u.total?.totalTokens) || 0;
        if (!sub && totalTokens > this.tokensSeen) {
          this.emit({ type: 'usage', spent: { tokens: totalTokens - this.tokensSeen } });
          this.tokensSeen = totalTokens;
        }
        return;
      }

      case 'turn/started':
        if (!sub) this.turnId = p.turn?.id ?? this.turnId;
        return;

      case 'item/started': {
        const it = p.item ?? {};
        if (this.onCollabItem(it)) return;
        const tool = describeItem(it);
        if (tool) {
          this.items.set(it.id, tool);
          emit({ type: 'tool', phase: 'start', name: tool.name, summary: tool.summary, detail: tool.detail, ...(tool.paths ? { paths: tool.paths } : {}) });
          if (sub || !this.approvals.size) emit({ type: 'state', state: 'working', detail: `${tool.name} · ${tool.summary}` });
        } else if (it.type === 'reasoning' && (sub || (!this.approvals.size && !this.interrupting))) {
          emit({ type: 'state', state: 'planning', detail: '思考中' });
        }
        return;
      }

      case 'item/completed': {
        const it = p.item ?? {};
        if (this.onCollabItem(it)) return;
        if (it.type === 'agentMessage') {
          if (typeof it.text === 'string' && it.text.trim()) emit({ type: 'message', role: 'agent', text: it.text.trim() });
          return;
        }
        if (it.type === 'userMessage' && sub) {
          const text = (it.content ?? []).map((c: Json) => c.text ?? '').join('').trim();
          if (text) emit({ type: 'message', role: 'user', text });
          return;
        }
        if (this.onImageItem(it, emit)) return;
        const tool = this.items.get(it.id);
        if (!tool) return;
        this.items.delete(it.id);
        const failed = it.status === 'failed' || it.status === 'declined';
        // MCP 工具的輸出在 result.content 的文字區塊裡,失敗時在 error.message
        const mcpText = it.type === 'mcpToolCall' ? [...(Array.isArray(it.result?.content) ? it.result.content : []).filter((b: Json) => b?.type === 'text' && typeof b.text === 'string').map((b: Json) => b.text), typeof it.error?.message === 'string' ? it.error.message : ''].filter(Boolean).join('\n') : '';
        const output = typeof it.aggregatedOutput === 'string' ? it.aggregatedOutput : it.type === 'fileChange' ? (it.changes ?? []).map((c: Json) => c.diff).join('\n') : mcpText;
        emit({ type: 'tool', phase: 'end', name: tool.name, summary: tool.summary, detail: output.slice(0, 4000), failed });
        // MCP 工具結果的內容區塊可能有圖片({ type: 'image', data, mimeType })
        if (it.type === 'mcpToolCall') {
          for (const b of Array.isArray(it.result?.content) ? it.result.content : []) {
            if (b?.type !== 'image' || typeof b.data !== 'string') continue;
            const path = saveImage(this.opts.agentId, b.data, String(b.mimeType ?? ''));
            if (path) emit({ type: 'image', path, caption: `${tool.name} · ${tool.summary}` });
          }
        }
        if (sub || (!this.interrupting && !this.approvals.size)) emit({ type: 'state', state: 'planning', detail: '思考中' });
        return;
      }

      case 'turn/completed': {
        const turn = p.turn ?? {};
        if (sub) {
          // 子代理的一個回合結束;子代理本身是否結束由 collab 項目決定
          emit({ type: 'state', state: turn.status === 'failed' ? 'error' : 'idle', detail: turn.status === 'failed' ? '回合失敗' : '回合完成' });
          return;
        }
        this.turnId = null;
        this.items.clear();
        for (const id of [...this.subThreads.keys()]) this.endSub(id, false);
        if (this.interrupting || turn.status === 'interrupted') {
          this.interrupting = false;
          this.emit({ type: 'message', role: 'agent', text: '(已中斷)' });
          this.emit({ type: 'state', state: 'idle', detail: '已中斷', outcome: 'interrupted' });
        } else if (turn.status === 'failed') {
          const reason = String(turn.error?.message ?? '回合失敗');
          this.emit({ type: 'error', message: reason.slice(0, 500) });
          this.emit({ type: 'state', state: 'error', detail: reason.slice(0, 60) });
        } else {
          this.emit({ type: 'state', state: 'idle', detail: '' });
        }
        return;
      }

      case 'item/agentMessage/delta':
        if (typeof p.delta === 'string' && p.delta) emit({ type: 'delta', text: p.delta });
        return;

      case 'turn/plan/updated':
        // Codex 的計畫清單;只取主 thread 的,子代理的計畫不列入任務面板
        if (!sub && Array.isArray(p.plan)) {
          this.emit({ type: 'plan', steps: p.plan.map((s: Json) => ({ text: String(s.step ?? '').slice(0, 160), status: s.status === 'completed' ? 'done' : s.status === 'inProgress' ? 'active' : 'pending' })) });
        }
        return;

      case 'error':
        // 會自動重試的錯誤只記錄,不改變狀態;最終結果由 turn/completed 決定
        if (!p.willRetry) emit({ type: 'error', message: String(p.error?.message ?? 'Codex 回報錯誤').slice(0, 500) });
        return;

      default:
        return;
    }
  }

  /** 處理與子代理有關的項目;回傳 true 表示已處理。 */
  private onCollabItem(it: Json): boolean {
    if (it.type === 'subAgentActivity') {
      const id = String(it.agentThreadId ?? '');
      if (!id) return true;
      if (it.kind === 'started') this.startSub(id, String(it.agentPath || '子代理').split('/').pop() || '子代理');
      else if (it.kind === 'completed' || it.kind === 'interrupted') this.endSub(id, false);
      return true;
    }
    if (it.type !== 'collabAgentToolCall') return false;
    if (it.tool === 'spawnAgent') {
      const name = String(it.prompt ?? '').trim().split('\n')[0].slice(0, 40) || '子代理';
      for (const id of it.receiverThreadIds ?? []) this.startSub(String(id), name);
    }
    for (const [id, st] of Object.entries(it.agentsStates ?? {}) as Array<[string, Json]>) {
      if (['completed', 'errored', 'shutdown', 'interrupted', 'notFound'].includes(st?.status)) this.endSub(id, st.status === 'errored');
    }
    return true;
  }

  private startSub(id: string, name: string): void {
    if (this.subThreads.has(id) || this.endedSubs.has(id)) return;
    this.subThreads.set(id, name);
    this.emit({ type: 'subagent', phase: 'start', subId: id, name });
    if (!this.approvals.size) this.emit({ type: 'state', state: 'working', detail: `子代理 · ${name}` });
  }

  private endSub(id: string, failed: boolean): void {
    const name = this.subThreads.get(id);
    if (name === undefined) return;
    this.subThreads.delete(id);
    this.endedSubs.add(id);
    this.emit({ type: 'subagent', phase: 'end', subId: id, name, failed });
  }
}

/** 把指令濃縮成一行:優先用 Codex 解析過的內層指令。 */
function describeCommand(p: Json): string {
  const inner = p.commandActions?.[0]?.command;
  return String(inner ?? p.command ?? '').replace(/\s+/g, ' ').slice(0, 100);
}

/** 把需要顯示成工具活動的 item 轉成名稱與摘要;其餘回傳 null。 */
function describeItem(it: Json): { name: string; summary: string; detail: string; paths?: string[] } | null {
  switch (it.type) {
    case 'commandExecution':
      return { name: 'Shell', summary: describeCommand(it), detail: String(it.command ?? '') };
    case 'fileChange': {
      const changes: Json[] = it.changes ?? [];
      const summary = changes.map(c => `${c.kind?.type ?? c.kind ?? '修改'} ${basename(String(c.path))}`).join(', ').slice(0, 100) || '修改檔案';
      // paths:完整的檔案路徑(協作流程的範圍合約用;明細裡的 diff 內容不能拿來猜路徑)
      return { name: 'Patch', summary, detail: changes.map(c => `${c.path}\n${c.diff ?? ''}`).join('\n\n').slice(0, 4000), paths: changes.map(c => String(c.path ?? '')).filter(Boolean) };
    }
    case 'mcpToolCall':
      return { name: 'MCP', summary: `${it.server ?? ''}/${it.tool ?? ''}`, detail: JSON.stringify(it.arguments ?? {}, null, 2) };
    case 'webSearch':
      return { name: 'WebSearch', summary: String(it.query ?? '').slice(0, 100), detail: '' };
    default:
      return null;
  }
}
