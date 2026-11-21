import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { deflateSync } from 'node:zlib';
import { attachmentKind, type AdapterEvent, type ApprovalDecision, type Backend, type Capability } from '../../shared/types';
import { saveImage } from '../media';
import { pathOnlyNote, withPaths, type Adapter, type AdapterSession, type StartOptions } from './adapter';

const TOOLS: Array<[name: string, summary: string]> = [
  ['Read', '讀取 src/index.ts'],
  ['Grep', '搜尋 "TODO"'],
  ['Edit', '修改 src/core.ts'],
  ['Bash', '執行 npm test'],
  ['Write', '建立 notes.md'],
  ['Glob', '列出 **/*.tsx'],
];
const RISKY: Array<[tool: string, summary: string]> = [
  ['Bash', '執行 git push origin main'],
  ['Write', '覆寫 package.json'],
  ['Bash', '執行 npm install left-pad'],
];

const ECHO = process.env.NEXUS_FAKE_ECHO === '1';
/** 產生一張 160×90 的漸層測試圖(PNG),模擬工具結果裡的圖片。 */
function testPng(): Buffer {
  const w = 160, h = 90;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = 20 + Math.round((x / w) * 60); raw[o + 1] = 120 + Math.round((y / h) * 100); raw[o + 2] = 200;
    }
  }
  const crc = (b: Buffer) => { let c = ~0; for (const v of b) { c ^= v; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type, 'ascii'), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const between = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * 假資料轉接器:不啟動任何 CLI,只依時間產生與真實轉接器相同形狀的事件。
 * 用來在接上真正的 CLI 之前驗證核心服務與畫面。
 */
export class FakeAdapter implements Adapter {
  constructor(readonly backend: Backend) {}

  async probe(): Promise<Capability> {
    return {
      backend: this.backend,
      available: true,
      simulated: true,
      version: null,
      approvals: true,
      interrupt: true,
      resume: true,
      fork: true,
      note: '假資料模式,尚未接上真正的 CLI',
      models: [],
      attachments: ['image', 'pdf'],
    };
  }

  start(opts: StartOptions, emit: (e: AdapterEvent) => void): AdapterSession {
    return new FakeSession(opts, emit);
  }
}

class FakeSession implements AdapterSession {
  private timers = new Set<NodeJS.Timeout>();
  private static used = 0.1;
  private context = 12000;
  private stopped = false;
  private busy = false;
  private lazySession = false;
  /** 測試用:會議腳本(見 runTurn 的「〔測試發言:…〕」)。 */
  private script = '';
  private waiting: { requestId: string; resume: (d: ApprovalDecision) => void } | null = null;
  private asking: { requestId: string; resume: (a: Record<string, string[]> | null) => void } | null = null;

  constructor(private opts: StartOptions, private emit: (e: AdapterEvent) => void) {
    // 模擬 CLI 啟動後回報 session 與待命狀態;分支時和新建一樣產生新的 session id
    // NEXUS_FAKE_FORK_LAZY=1 時模擬 Claude Code:分支的 session 要等第一句指令才回報
    const lazy = !opts.sessionId && opts.forkFrom !== null && process.env.NEXUS_FAKE_FORK_LAZY === '1';
    this.lazySession = lazy;
    // 測試用:NEXUS_FAKE_ECHO=1 時把收到的身分設定與實際送出的文字回吐成事件,驗收腳本才看得到
    if (ECHO) this.emit({ type: 'note', text: `[echo] persona:${opts.persona}` });
    // 模擬 CLI 啟動後回報 session 與待命狀態
    this.after(300, () => {
      if (!opts.sessionId && !lazy) this.emit({ type: 'session', sessionId: `fake-${randomUUID().slice(0, 8)}` });
      this.emit({ type: 'state', state: 'idle', detail: opts.sessionId ? '已續接' : opts.forkFrom ? '已分支' : '' });
    });
  }

  send(text: string, images: string[] = []): void {
    if (this.stopped || this.busy) return;
    if (ECHO) this.emit({ type: 'note', text: `[echo] send:${text}` });
    this.busy = true;
    if (this.lazySession) { this.lazySession = false; this.emit({ type: 'session', sessionId: `fake-${randomUUID().slice(0, 8)}` }); }
    // 模擬能內嵌圖片與 PDF 的後台:回報收到哪些附件,方便驗證附件流程
    const embed = images.filter(p => ['image', 'pdf'].includes(attachmentKind(p)) && existsSync(p));
    const rest = images.filter(p => !embed.includes(p));
    if (embed.length) this.emit({ type: 'note', text: `(模擬)已內嵌 ${embed.length} 個附件:${embed.map(p => basename(p)).join('、')}` });
    const note = pathOnlyNote('模擬後台', rest.map(path => ({ path, reason: existsSync(path) ? '只能內嵌圖片與 PDF' : '找不到檔案' })));
    if (note) this.emit(note);
    void this.runTurn(withPaths(text, rest)).finally(() => { this.busy = false; });
  }

  interrupt(): void {
    if (!this.busy) return;
    // 清掉計時器後,進行中的回合會停在原地不再繼續
    this.clearTimers();
    if (this.asking) { this.emit({ type: 'question_resolved', requestId: this.asking.requestId, answers: null }); this.asking = null; }
    if (this.waiting) {
      this.emit({ type: 'approval_resolved', requestId: this.waiting.requestId, decision: 'deny' });
      this.waiting = null;
    }
    this.busy = false;
    this.emit({ type: 'message', role: 'agent', text: '已中斷。' });
    this.emit({ type: 'state', state: 'idle', detail: '已中斷', outcome: 'interrupted' });
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    if (this.waiting?.requestId === requestId) this.settleApproval(decision);
  }

  answerQuestion(requestId: string, answers: Record<string, string[]> | null): void {
    if (this.asking?.requestId !== requestId) return;
    const a = this.asking;
    this.asking = null;
    a.resume(answers);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    this.waiting = null;
  }

  private async runTurn(_text: string): Promise<void> {
    this.emit({ type: 'state', state: 'planning', detail: '思考中' });
    // 【只給驗收測試用】會議的指令開頭固定是主控台的說明,用不上「圖片測試」。
    // 指令裡含「〔測試發言:名稱=第1輪|第2輪;名稱2=…〕」時,輪到「名稱」發言就約 0.9 秒後直接回覆對應那一輪的內容
    // (輪數取自指令裡的「現在是第 N 輪」,超過的用最後一段;「\n」會換成換行)。
    // 會議第二輪起的指令不再附主題,所以腳本記在這個 session 裡。
    const scriptMark = /〔測試發言:([^〕]*)〕/.exec(_text);
    if (scriptMark) this.script = scriptMark[1];
    const who = /輪到你「([^」]+)」發言/.exec(_text)?.[1];
    if (this.script && who) {
      const mine = this.script.split(';').map(s => s.split('=')).find(kv => kv[0].trim() === who);
      if (mine) {
        const round = Number(/現在是第 (\d+) 輪/.exec(_text)?.[1] ?? 1);
        const parts = mine.slice(1).join('=').split('|');
        const reply = (parts[Math.min(round, parts.length) - 1] ?? '').replace(/\\n/g, '\n');
        await this.wait(900);
        this.emit({ type: 'message', role: 'agent', text: reply });
        this.emit({ type: 'state', state: 'idle', detail: '' });
        return;
      }
    }
    // 【只給驗收測試用】指定這個回合回報的用量,讓儀表的數字可以預期:
    //   〔測試用量:{"windows":[{"label":"每週","used":0.3,"resetsAt":1790000000}],"spent":{"tokens":12000,"usd":0.05}}〕
    //   約 0.3 秒後回報用量(windows、spent 都可以省略)並回到待命,不經過其他隨機的步驟。
    const usageMark = /〔測試用量:(.*?)〕/s.exec(_text);
    if (usageMark) {
      let u: { windows?: Array<{ label: string; used: number; resetsAt?: number | null; group?: string; match?: string[] }>; spent?: { tokens: number; usd?: number } } = {};
      try { u = JSON.parse(usageMark[1]); } catch { /* 格式不對就當成沒有用量 */ }
      await this.wait(300);
      this.emit({ type: 'usage', ...(u.windows ? { windows: u.windows.map(w => ({ ...w, resetsAt: w.resetsAt ?? null })) } : {}), ...(u.spent ? { spent: u.spent } : {}) });
      this.emit({ type: 'message', role: 'agent', text: '用量已回報。' });
      this.emit({ type: 'state', state: 'idle', detail: '' });
      return;
    }
    // 〔測試執行:毫秒〕:停在「執行中」這麼久再完成(不回報用量);〔測試出錯〕:這個回合直接出錯
    const runMark = /〔測試執行:(\d+)〕/.exec(_text);
    if (runMark) {
      this.emit({ type: 'state', state: 'working', detail: '測試執行' });
      await this.wait(Number(runMark[1]));
      this.emit({ type: 'message', role: 'agent', text: '完成。' });
      this.emit({ type: 'state', state: 'idle', detail: '' });
      return;
    }
    if (_text.includes('〔測試出錯〕')) {
      await this.wait(300);
      this.emit({ type: 'error', message: '模擬錯誤:測試指定的失敗' });
      this.emit({ type: 'state', state: 'error', detail: '測試出錯' });
      return;
    }
    await this.wait(between(1500, 3200));
    // 指令開頭是「圖片測試」時:先模擬一個回傳圖片的工具結果,再把指令第二行以後的內容當成回覆,方便測試圖片顯示
    if (_text.startsWith('圖片測試')) {
      this.emit({ type: 'tool', phase: 'start', name: 'Screenshot', summary: '擷取畫面' });
      await this.wait(300);
      this.emit({ type: 'tool', phase: 'end', name: 'Screenshot', summary: '擷取畫面', detail: '[{"type":"image","media_type":"image/png"}]' });
      const path = saveImage(this.opts.agentId, testPng(), 'image/png');
      if (path) this.emit({ type: 'image', path, caption: 'Screenshot · 擷取畫面' });
      const reply = _text.split('\n').slice(1).join('\n') || '沒有內容。';
      for (let i = 0; i < reply.length; i += 12) { this.emit({ type: 'delta', text: reply.slice(i, i + 12) }); await this.wait(20); }
      this.emit({ type: 'message', role: 'agent', text: reply });
      this.emit({ type: 'state', state: 'idle', detail: '' });
      return;
    }
    // 指令裡有「程式碼」時回一段有排版的內容,方便測試回覆排版
    if (_text.includes('程式碼')) {
      const reply = ['## 範例', '', '這是 **粗體** 與 `行內程式碼`。', '', '- 第一點', '- 第二點', '', '```js', 'function hello(name) {', '  return "hi " + name;', '}', '```', '', '1. 步驟一', '2. 步驟二'].join('\n');
      for (let i = 0; i < reply.length; i += 8) { this.emit({ type: 'delta', text: reply.slice(i, i + 8) }); await this.wait(30); }
      this.emit({ type: 'message', role: 'agent', text: reply });
      this.emit({ type: 'state', state: 'idle', detail: '' });
      return;
    }
    // 指令裡有「提問」時模擬一次向使用者提問,方便測試作答畫面
    if (_text.includes('提問')) {
      const requestId = randomUUID();
      this.emit({ type: 'question', requestId, questions: [{ id: 'q1', header: '顏色', question: '要用哪種顏色?', multi: false, options: [{ label: '紅色', description: '暖色' }, { label: '藍色', description: '冷色' }] }] });
      this.emit({ type: 'state', state: 'awaiting', detail: '等你回答' });
      const answers = await new Promise<Record<string, string[]> | null>(resolve => { this.asking = { requestId, resume: resolve }; });
      this.emit({ type: 'question_resolved', requestId, answers });
      const reply = answers ? `收到你的回答:${Object.values(answers).flat().join('、')}。` : '你沒有回答,我自己決定。';
      for (const ch of reply.match(/.{1,3}/g) ?? []) { this.emit({ type: 'delta', text: ch }); await this.wait(90); }
      this.emit({ type: 'message', role: 'agent', text: reply });
      this.emit({ type: 'state', state: 'idle', detail: '' });
      return;
    }

    const steps = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < steps; i++) {
      if (this.opts.permissionMode === 'ask' && Math.random() < 0.3) {
        const [tool, summary] = pick(RISKY);
        const decision = await this.askApproval(tool, summary);
        if (decision === 'deny') {
          this.emit({ type: 'message', role: 'agent', text: `已取消「${summary}」。` });
          continue;
        }
        await this.runTool(tool, summary);
        continue;
      }
      // 測試用:NEXUS_FAKE_NO_ERRORS=1 時不模擬隨機失敗,讓需要回合跑完的驗收結果固定
      if (process.env.NEXUS_FAKE_NO_ERRORS !== '1' && Math.random() < 0.06) {
        this.emit({ type: 'error', message: '模擬錯誤:被限速(429)' });
        this.emit({ type: 'state', state: 'error', detail: '被限速' });
        return;
      }
      const [name, summary] = pick(TOOLS);
      await this.runTool(name, summary);
    }
    // 假資料的用量:每回合多用一點,方便看血量條
    FakeSession.used = Math.min(0.97, FakeSession.used + 0.07 + Math.random() * 0.06);
    this.context = Math.min(190000, this.context + 9000 + Math.round(Math.random() * 14000));
    this.emit({ type: 'usage', windows: [{ label: '5 小時', used: FakeSession.used, resetsAt: Math.round(Date.now() / 1000) + 3 * 3600 }, { label: '每週', used: FakeSession.used * 0.6, resetsAt: Math.round(Date.now() / 1000) + 4 * 86400 }], context: { used: this.context, max: 200000 }, spent: { tokens: 8000 + Math.round(Math.random() * 20000), usd: 0.004 + Math.random() * 0.02 } });
    this.emit({ type: 'message', role: 'agent', text: '完成。' });
    this.emit({ type: 'state', state: 'idle', detail: '' });
  }

  private async runTool(name: string, summary: string): Promise<void> {
    this.emit({ type: 'tool', phase: 'start', name, summary });
    this.emit({ type: 'state', state: 'working', detail: `${name} · ${summary}` });
    await this.wait(between(1400, 3000));
    this.emit({ type: 'tool', phase: 'end', name, summary });
  }

  private askApproval(tool: string, summary: string): Promise<ApprovalDecision> {
    const requestId = randomUUID();
    this.emit({ type: 'approval_request', requestId, tool, summary });
    this.emit({ type: 'state', state: 'awaiting', detail: `${tool} · ${summary}` });
    return new Promise(resolve => {
      this.waiting = {
        requestId,
        resume: decision => {
          this.emit({ type: 'approval_resolved', requestId, decision });
          resolve(decision);
        },
      };
    });
  }

  private settleApproval(decision: ApprovalDecision): void {
    const w = this.waiting;
    this.waiting = null;
    w?.resume(decision);
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => this.after(ms, resolve));
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => { this.timers.delete(t); if (!this.stopped) fn(); }, ms);
    this.timers.add(t);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
