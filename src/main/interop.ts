import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { BACKEND_LABEL, STATE_LABEL, type AgentInfo, type DispatchEntry, type Update } from '../shared/types';
import type { Core } from './core';
import { memorySearch, memoryWrite } from './memory-tools';
import { buildLinks, dispatchTitle } from '../shared/collab';

/**
 * 節點互相呼叫:主控台開一個只聽本機迴路的 MCP 伺服器(Streamable HTTP,單純的 JSON 回應),
 * 啟動每個節點的 CLI 時把它掛上去,agent 就多了三個工具:
 *   list_nodes  列出面板上其他節點
 *   ask_node    把一段指令交給另一個節點,等它這個回合結束後拿回答覆
 *   wait_reply  ask_node 等太久先返回時,用它繼續等
 *   start_meeting 召開會議:主控台主持,參與的節點輪流發言幾輪,最後把完整紀錄交回召開者
 *   meeting_say 會議中輪到主持人時,主持人用它發言(交給所有參與者,接著進行下一輪)或結束會議
 *   case_submit 主控台請節點撰寫判例時,節點用它提交敘述的章節(只有任務自己的節點能提交;見 cases.ts)
 *
 * 設計:
 * - 每個節點有自己的網址(路徑裡帶一組亂數權杖),伺服器由權杖得知是誰在呼叫;只聽 127.0.0.1。
 * - 只能呼叫面板上已有、沒有在執行的最上層節點(待命,或上一個回合出錯停下來的);不能呼叫自己、子代理、休眠或終端機模式的節點。
 * - 防止互相呼叫成迴圈:被呼叫的節點如果正在(直接或間接)等呼叫者,就拒絕;呼叫鏈最多 MAX_DEPTH 層。
 * - 是否要使用者同意,跟著呼叫方節點的權限模式:「自動」直接送出,「每次詢問」先在呼叫方節點上跳授權。
 * - ask_node 最多等 WAIT_MS 就先返回(各家 CLI 對工具呼叫的逾時不同,有的只有一分鐘),之後用 wait_reply 接著等。
 * - 會議(start_meeting):召開者是主持人,參與者是其他節點。主控台每一輪依序把「自己上次發言之後其他人說了什麼」交給下一位,每人一個回合。
 *   預設(host_turns)每一輪結束、還有下一輪時,start_meeting / wait_reply 會返回「輪到主持人發言」,主持人用 meeting_say 發言
 *   (下一輪的參與者會看到)或結束會議;同一輪所有參與者都表示沒有補充時也先交給主持人決定。主持人超過 MEETING_TURN_MS 沒有回應就散會。
 *   host_turns 為 false 時主持人不發言:所有人在同一輪都表示沒有補充,或輪數用完就結束。
 *   「每次詢問」模式的召開者只在開會時問使用者一次,整場放行。每則發言即時記在召開者的對話裡,使用者看得到全程;
 *   中斷召開者(或它的回合結束)就散會,正在發言的節點也一併中斷。
 * - 被呼叫的節點照自己的權限模式與額度上限執行;送給它的指令前面會加一行,說明是哪個節點呼叫的、答覆會交還給誰。
 */
const PORT = Number(process.env.NEXUS_INTEROP_PORT) || 47617;
const WAIT_MS = Number(process.env.NEXUS_INTEROP_WAIT_MS) || 45000;
const REQUEST_TTL = 30 * 60 * 1000;
const MAX_DEPTH = 3;
const MAX_PROMPT = 20000;
const MAX_REPLY = 30000;
export const INTEROP_SERVER = 'nexus';
export const INTEROP_TOOLS = ['list_nodes', 'ask_node', 'wait_reply', 'start_meeting', 'meeting_say', 'memory_search', 'memory_write', 'case_submit'];

/** 轉接器啟動 CLI 時用來掛上工具的資訊。 */
export interface InteropOptions {
  /** MCP 伺服器名稱(工具會以它為前綴)。 */
  name: string;
  /** 這個節點專用的 Streamable HTTP 網址。 */
  url: string;
  /** 內容是 { mcpServers: { nexus: { type: 'http', url } } } 的 JSON 檔,給只收檔案路徑的 CLI 用。 */
  configFile: string;
  tools: string[];
  /**
   * Antigravity(agy)專用:agy 不能用啟動參數直接掛 MCP 伺服器,要經「工作區外掛」。
   * dir 是放了 .agents/plugins.json 與外掛的資料夾(啟動時用 --add-dir 加進工作區),
   * settings 是放行這個伺服器工具的設定檔(--settings),server 是 agy 裡看到的伺服器名稱(外掛名_伺服器名)。
   */
  agy: { dir: string; settings: string; server: string } | null;
}

interface Pending {
  id: string;
  callerId: string;
  targetId: string;
  targetName: string;
  createdAt: number;
  /** 送出後有沒有看到被呼叫的節點開始執行;在那之前的「待命」不算回合結束。 */
  started: boolean;
  parts: string[];
  status: 'running' | 'done' | 'failed';
  error: string;
  waiters: Set<() => void>;
  /** 會議裡某位參與者的發言回合:屬於哪場會議(不記進分派紀錄,連線畫在會議上)。 */
  meetingId?: string;
  /** 指令的簡短標題(分派紀錄與連線標籤)。 */
  title?: string;
  /** 這筆呼叫在被呼叫節點上產生的任務 id。 */
  taskId?: string;
}

/** 一場會議:由主控台主持,參與者輪流發言。 */
interface Meeting {
  id: string;
  callerId: string;
  callerName: string;
  topic: string;
  participants: Array<{ id: string; name: string }>;
  rounds: number;
  createdAt: number;
  /** 會議紀錄;round 為 0 的是主控台的說明(略過、失敗、散會)。 */
  transcript: Array<{ round: number; name: string; text: string }>;
  status: 'running' | 'done' | 'failed';
  error: string;
  /** 正在發言的節點那一回合的請求。 */
  current: Pending | null;
  waiters: Set<() => void>;
  /** 每一輪之間是否輪到主持人發言。 */
  hostTurns: boolean;
  /** 正在等主持人發言(第 round 輪結束後);resolve(true) 表示結束會議。 */
  hostTurn: { round: number; quiet: boolean; resolve: (end: boolean) => void } | null;
  /** 主持人上次發言時的紀錄長度;輪到它時只給之後的新發言。 */
  hostSeen: number;
}

const MEETING_MAX_ROUNDS = 6;
const MEETING_MAX_PARTICIPANTS = 5;
const MEETING_TURN_MS = Number(process.env.NEXUS_MEETING_TURN_MS) || 15 * 60 * 1000;
const MEETING_STATEMENT_MAX = 6000;
/** 參與者覺得沒有要補充時,在發言最後寫這個記號;同一輪所有人都寫就提前結束。 */
const NOTHING_TO_ADD = '【無補充】';

type Json = Record<string, any>;

const TOOL_DEFS = [
  {
    name: 'list_nodes',
    description: '列出 Entropy Nexus 主控台面板上的其他節點(其他 AI agent,可能是 Claude Code、Codex 或 Antigravity)。回傳每個節點的名稱、後台、模型、目前狀態與工作目錄。要把工作交給別的節點之前,先用這個工具看有哪些節點、哪些正在待命。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_node',
    description: '把一段指令交給主控台面板上的另一個節點(另一個 AI agent),等它完成這個回合後取回它的答覆。適合請別家模型提供第二意見、看圖、審查或分工。對方看不到你的對話,所以 prompt 要寫完整:背景、要它做什麼、希望怎麼回覆;對方在它自己的工作目錄裡執行,需要它讀的檔案請給絕對路徑。只能呼叫正在待命的節點。對方如果要比較久,這個工具會先回傳 request_id,請接著呼叫 wait_reply 繼續等。',
    inputSchema: {
      type: 'object',
      properties: {
        node: { type: 'string', description: '目標節點的名稱或 id(用 list_nodes 查)。' },
        prompt: { type: 'string', description: '要交給對方的完整指令。' },
      },
      required: ['node', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_reply',
    description: 'ask_node、start_meeting 或 meeting_say 回傳「還在執行/進行中」時,用它繼續等結果。可以重複呼叫直到拿到結果(會議輪到你發言時也會返回)。',
    inputSchema: {
      type: 'object',
      properties: { request_id: { type: 'string', description: 'ask_node 或 start_meeting 回傳的 request_id。' } },
      required: ['request_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_meeting',
    description: '召開一場會議,讓主控台面板上的幾個節點(其他 AI agent)針對一個主題輪流發言、互相回應,進行多輪討論。你是主持人:由你提出主題,主控台每一輪依序把其他人的發言交給下一位參與者,討論結束後把完整的會議紀錄交還給你,由你整理結論回報給使用者。適合需要多方意見、互相質疑或逐步收斂的問題;只想問一個節點一個問題時請用 ask_node。參與者看不到你的對話,所以 topic 要寫完整:背景、要討論的問題、希望得到什麼樣的結論。預設每一輪結束(還有下一輪)時會輪到你發言:工具回傳「輪到你(主持人)發言」時,用 meeting_say 提問、回應或指定下一輪的重點,或結束會議。會議通常要幾分鐘,這個工具會先回傳 request_id,請接著呼叫 wait_reply 等到輪到你或會議結束。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '會議主題與背景說明(完整寫出,參與者只看得到這段)。' },
        participants: { type: 'array', items: { type: 'string' }, description: '參與節點的名稱或 id(用 list_nodes 查),1 到 5 個,不含你自己。' },
        rounds: { type: 'number', description: '最多討論幾輪(每輪每位參與者發言一次),1 到 6,預設 2。' },
        host_turns: { type: 'boolean', description: '每一輪之間是否輪到你(主持人)發言,預設 true。設為 false 時你不發言,所有參與者同一輪都表示沒有補充就提前結束。' },
      },
      required: ['topic', 'participants'],
      additionalProperties: false,
    },
  },
  {
    name: 'meeting_say',
    description: '會議中輪到你(主持人)發言時使用(start_meeting 或 wait_reply 回傳「輪到你(主持人)發言」之後)。text 是你的發言:提問、回應、追問或指定下一輪要討論的重點,會交給所有參與者,接著進行下一輪;end 設為 true 則結束會議並拿回完整的會議紀錄(可以同時附上 text 當結語)。之後同樣用 wait_reply 等到下一次輪到你或會議結束。',
    inputSchema: {
      type: 'object',
      properties: {
        request_id: { type: 'string', description: 'start_meeting 回傳的 request_id(m 開頭)。' },
        text: { type: 'string', description: '你的發言。' },
        end: { type: 'boolean', description: '設為 true 結束會議。' },
      },
      required: ['request_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'case_submit',
    description: '只在主控台請你「撰寫判例」時使用:把你剛完成的任務的解法,依固定格式提交成一份判例(寫進記憶庫,狀態先是「未確認」)。task_id 是主控台請求裡給的任務編號;只有承辦該任務的節點能提交,一個任務只能提交一次。耗時、失敗次數、改過的檔案等客觀欄位由主控台自動填,你只寫敘述的部分。',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任務編號(主控台請求裡給的)。' },
        案由: { type: 'string', description: '一句話描述問題。' },
        關鍵字: { type: 'array', items: { type: 'string' }, description: '3 到 6 個關鍵字。' },
        事實經過: { type: 'string', description: '遇到什麼狀況、錯誤訊息或症狀。' },
        爭點: { type: 'string', description: '真正要解決的問題是什麼。' },
        處理經過: { type: 'string', description: '試過哪些方法,哪些沒用、為什麼(走過的彎路)。' },
        結論: { type: 'string', description: '最後有效的解法:改了哪些檔案、哪些設定、哪些指令。' },
        理由: { type: 'string', description: '為什麼這樣能解決(根本原因)。' },
        適用範圍: { type: 'string', description: '適用條件,什麼情況下不適用。' },
        參照先例: { type: 'string', description: '相關的既有案號,用 [[案號]] 表示;沒有就寫「無」。' },
      },
      required: ['task_id', '案由', '關鍵字', '事實經過', '結論'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_search',
    description: '搜尋主控台的長期記憶:節點側寫(各節點的特長與解決問題的流程)、使用者已確認的判例(以前遇過的問題與解法)、專案知識、使用者偏好。開始一件不熟的工作、要決定交給哪個節點、或想知道「這個專案有什麼要注意的」「使用者偏好什麼」之前先查。範圍是全域加上你目前的專案(可用 project 指定別的專案);你自己的側寫與判例排在最前面。回傳每筆的路徑、種類、標題、狀態、更新日期與一小段摘要;標「可能過時」的(很久沒更新,或專案之後已改了很多)請先對照現況再採用。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '關鍵字,空白分隔(中文直接寫詞即可,不分大小寫)。' },
        kind: { type: 'string', enum: ['node', 'case', 'knowledge', 'preference'], description: '只查這個種類:node 節點側寫、case 判例、knowledge 專案知識、preference 使用者偏好。不填就全部查。' },
        node: { type: 'string', description: '只看和這個節點(名稱或 id)有關的記憶。' },
        project: { type: 'string', description: '指定專案(名稱或路徑);不填就是你目前的專案。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_write',
    description: '寫入長期記憶,只有總管節點可以用(其他節點會被拒絕)。kind 為 node:更新某個節點的特長,title 填節點名稱、content 寫它擅長什麼(簡短,第一行最重要,會顯示在總管守則裡);knowledge:寫一則專案知識(本專案踩過的坑、慣例、設定),title 是標題,同標題會取代內容;preference:寫一則使用者偏好(跨專案適用)。只寫日後真的用得到、講得清楚的事;不要寫金鑰、密碼或權杖(看起來像的會被自動遮罩)。專案知識每個專案有數量上限,超過時請整理合併。判例不能用這個工具寫,請用 case_submit。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['node', 'knowledge', 'preference'], description: 'node 節點特長、knowledge 專案知識、preference 使用者偏好。' },
        title: { type: 'string', description: 'node 時是節點名稱;其餘是這則記憶的標題。' },
        content: { type: 'string', description: '內容(Markdown)。' },
        project: { type: 'string', description: 'knowledge 用:指定專案名稱;不填就是你目前的專案。' },
      },
      required: ['kind', 'title', 'content'],
      additionalProperties: false,
    },
  },
];

export class Interop {
  private core: Core | null = null;
  private server: Server | null = null;
  private dir: string;
  private tokens = new Map<string, string>();
  private byAgent = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private meetings = new Map<string, Meeting>();
  private enabled = process.env.NEXUS_INTEROP !== '0';
  error = '';
  /** 判例提交(case_submit);由 index.ts 接上判例服務。callerId 是權杖對應的節點,判例服務據此檢查是不是任務自己的節點。 */
  caseSubmit: ((callerId: string, args: Record<string, unknown>) => Promise<string>) | null = null;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'interop');
    try {
      mkdirSync(this.dir, { recursive: true });
      // 上次留下的設定檔裡的權杖已經失效,清掉
      rmSync(this.dir, { recursive: true, force: true });
      mkdirSync(this.dir, { recursive: true });
    } catch { /* 清不掉不影響運作 */ }
  }

  attach(core: Core): void {
    this.core = core;
    if (!this.enabled) return;
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => { try { res.writeHead(500).end(); } catch { /* 連線已斷 */ } }); });
    server.on('error', err => { this.error = `節點互相呼叫的工具服務無法在 127.0.0.1:${PORT} 聆聽:${err.message}`; this.server = null; });
    server.listen(PORT, '127.0.0.1');
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    for (const m of this.meetings.values()) this.endMeeting(m, 'failed', '主控台結束');
    for (const p of this.pending.values()) this.finish(p, 'failed', '主控台結束');
  }

  /** 啟動節點的 CLI 時掛上工具用的資訊;功能關閉或服務沒起來時回傳 null。每個節點固定一組權杖。 */
  optionsFor(agentId: string): InteropOptions | null {
    if (!this.enabled || this.error) return null;
    let token = this.byAgent.get(agentId);
    if (!token) {
      token = randomBytes(24).toString('hex');
      this.byAgent.set(agentId, token);
      this.tokens.set(token, agentId);
    }
    const url = `http://127.0.0.1:${PORT}/mcp/${token}`;
    const configFile = join(this.dir, `${agentId.replace(/[^\w-]/g, '')}.json`);
    try { writeFileSync(configFile, JSON.stringify({ mcpServers: { [INTEROP_SERVER]: { type: 'http', url } } })); } catch { return null; }
    return { name: INTEROP_SERVER, url, configFile, tools: INTEROP_TOOLS, agy: this.agyPlugin(agentId, url) };
  }

  /**
   * agy 的工作區外掛(以 agy 1.5.10 實測):<dir>/.agents/plugins.json 指向 .agents/plugins,
   * 裡面的外掛 nexus 帶一份 mcp_config.json;agy 裡的伺服器名稱是「外掛名_伺服器名」。
   * 無視窗模式會自動拒絕需要權限的工具,所以另外用 --settings 放行這個伺服器的工具。
   */
  private agyPlugin(agentId: string, url: string): InteropOptions['agy'] {
    try {
      const dir = join(this.dir, 'agy', agentId.replace(/[^\w-]/g, ''));
      const plugin = join(dir, '.agents', 'plugins', INTEROP_SERVER);
      mkdirSync(plugin, { recursive: true });
      writeFileSync(join(dir, '.agents', 'plugins.json'), JSON.stringify({ entries: [{ path: '.agents/plugins' }] }));
      writeFileSync(join(plugin, 'plugin.json'), JSON.stringify({ name: INTEROP_SERVER, version: '1.0.0', description: 'Entropy Nexus:呼叫主控台面板上的其他節點' }));
      writeFileSync(join(plugin, 'mcp_config.json'), JSON.stringify({ mcpServers: { tools: { url } } }));
      const server = `${INTEROP_SERVER}_tools`;
      const settings = join(dir, 'settings.json');
      writeFileSync(settings, JSON.stringify({ permissions: { allow: [`mcp(${server}/*)`] } }));
      return { dir, settings, server };
    } catch {
      return null;
    }
  }

  /** 核心服務的每一筆更新都經過這裡:收集被呼叫節點的回覆,並在它的回合結束時交還給呼叫者。 */
  onUpdate(u: Update): void {
    // 會議的召開者回合結束(被中斷、出錯、休眠)或被終止:散會
    if (this.meetings.size) {
      const gone = u.removedId ?? (u.event?.type === 'state' && ['idle', 'error', 'lost', 'sleeping'].includes(u.event.state) ? u.event.agentId : null);
      if (gone) for (const m of this.meetings.values()) if (m.status === 'running' && m.callerId === gone) this.endMeeting(m, 'failed', '召開會議的節點已經停下來,會議中止');
    }
    if (!this.pending.size) return;
    if (u.removedId) {
      for (const p of this.pending.values()) if (p.status === 'running' && p.targetId === u.removedId) this.finish(p, 'failed', '節點已被終止');
      this.byAgent.delete(u.removedId);
    }
    const e = u.event;
    if (!e) return;
    for (const p of this.pending.values()) {
      if (p.status !== 'running' || p.targetId !== e.agentId) continue;
      if (e.type === 'message' && e.role === 'agent') { if (p.started) p.parts.push(e.text); }
      else if (e.type === 'error' && !p.started) this.finish(p, 'failed', e.message);
      else if (e.type === 'state') {
        if (e.state === 'planning' || e.state === 'working' || e.state === 'awaiting') p.started = true;
        else if (e.state === 'idle' && p.started) this.finish(p, 'done', '');
        else if ((e.state === 'error' || e.state === 'lost') && p.started) this.finish(p, 'failed', e.detail || STATE_LABEL[e.state]);
        else if (e.state === 'sleeping') this.finish(p, 'failed', '節點進入休眠');
      }
    }
  }

  private finish(p: Pending, status: 'done' | 'failed' | 'timeout', error: string): void {
    if (p.status !== 'running') return;
    p.status = status === 'timeout' ? 'failed' : status;
    p.error = error;
    if (!p.meetingId) this.core?.recordDispatch(this.dispatchOf(p, status));
    this.publish();
    for (const w of p.waiters) w();
    p.waiters.clear();
  }

  /** 這筆呼叫在分派紀錄裡的樣子。 */
  private dispatchOf(p: Pending, status: 'running' | 'done' | 'failed' | 'timeout'): DispatchEntry {
    const name = (id: string, fallback: string) => this.agents().find(a => a.id === id)?.name ?? fallback;
    return {
      id: p.id, startedAt: p.createdAt, endedAt: status === 'running' ? null : Date.now(), fromId: p.callerId, fromName: name(p.callerId, '(已移除)'),
      toId: p.targetId, toName: p.targetName, title: p.title ?? '', status, ...(p.taskId ? { taskId: p.taskId } : {}),
    };
  }

  /** 把進行中的呼叫與會議整理成連線,推送給畫面(內容沒變時核心服務不會重複推送)。 */
  private publish(): void {
    this.core?.setLinks(buildLinks(
      [...this.pending.values()].map(p => ({ id: p.id, callerId: p.callerId, targetId: p.targetId, status: p.status, createdAt: p.createdAt, meetingId: p.meetingId, label: p.title })),
      [...this.meetings.values()].map(m => ({ id: m.id, callerId: m.callerId, participantIds: m.participants.map(x => x.id), status: m.status, createdAt: m.createdAt, topic: m.topic, currentTargetId: m.current?.status === 'running' ? m.current.targetId : null })),
    ));
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, p] of this.pending) {
      if (p.status === 'running' && now - p.createdAt > REQUEST_TTL) this.finish(p, 'timeout', '等候超過 30 分鐘');
      if (p.status !== 'running' && now - p.createdAt > REQUEST_TTL + 10 * 60 * 1000) this.pending.delete(id);
    }
    for (const [id, m] of this.meetings) if (m.status !== 'running' && now - m.createdAt > 3 * 60 * 60 * 1000) this.meetings.delete(id);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 只接受以本機位址為主機名稱的請求,避免其他網站透過瀏覽器轉送請求進來
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    const m = /^\/mcp\/([0-9a-f]{48})$/.exec((req.url ?? '').split('?')[0]);
    const callerId = m ? this.tokens.get(m[1]) : undefined;
    if ((host !== '127.0.0.1' && host !== 'localhost') || !callerId) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 512 * 1024) { res.writeHead(413).end(); return; } chunks.push(c as Buffer); }
    let msg: unknown;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    const list = (Array.isArray(msg) ? msg : [msg]) as Json[];
    const out = (await Promise.all(list.map(x => this.rpc(callerId, x)))).filter(Boolean);
    if (!out.length) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
  }

  private async rpc(callerId: string, msg: Json): Promise<Json | null> {
    const { id, method, params } = msg ?? {};
    if (id === undefined || id === null) return null;
    const ok = (result: Json) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return ok({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'entropy-nexus', version: '1' } });
    if (method === 'ping') return ok({});
    if (method === 'tools/list') return ok({ tools: TOOL_DEFS });
    if (method === 'tools/call') {
      const text = (t: string, isError = false) => ok({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
      try {
        const args: Json = params?.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        if (params?.name === 'list_nodes') return text(this.listNodes(callerId));
        // 模型偶爾會把參數名稱寫成別的(實測 Codex 發生過),常見的別名一併接受
        const pick = (...keys: string[]) => { for (const k of keys) if (typeof args[k] === 'string' && args[k].trim()) return args[k] as string; return ''; };
        if (params?.name === 'ask_node') {
          const node = pick('node', 'name', 'target', 'node_id', 'nodeId', 'node_name', 'id');
          const prompt = pick('prompt', 'message', 'question', 'text', 'instruction', 'instructions', 'query', 'content', 'task');
          if (!node || !prompt) throw new Error(`ask_node 需要兩個字串參數:node(目標節點的名稱或 id)與 prompt(要交給對方的完整指令)。這次收到的參數是:${JSON.stringify(Object.keys(args))}。請用正確的參數名稱再呼叫一次。`);
          return text(await this.askNode(callerId, node, prompt));
        }
        if (params?.name === 'wait_reply') return text(await this.waitReply(callerId, pick('request_id', 'requestId', 'id')));
        if (params?.name === 'start_meeting') {
          const topic = pick('topic', 'subject', 'prompt', 'agenda', 'question', 'message');
          const raw = args.participants ?? args.nodes ?? args.members ?? args.attendees;
          const names = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,、,\n]/) : []).map((x: unknown) => String(x).trim()).filter(Boolean);
          if (!topic || !names.length) throw new Error(`start_meeting 需要 topic(字串:會議主題與背景)與 participants(字串陣列:參與節點的名稱或 id)。這次收到的參數是:${JSON.stringify(Object.keys(args))}。請用正確的參數再呼叫一次。`);
          const hostTurns = ![false, 'false'].includes(args.host_turns ?? args.hostTurns);
          return text(await this.startMeeting(callerId, topic, names, Number(args.rounds ?? args.max_rounds ?? 2), hostTurns));
        }
        if (params?.name === 'meeting_say') {
          const rid = pick('request_id', 'requestId', 'meeting_id', 'id');
          const say = pick('text', 'message', 'statement', 'content', 'prompt');
          const end = args.end === true || args.end === 'true';
          if (!rid || (!say && !end)) throw new Error(`meeting_say 需要 request_id(start_meeting 回傳的 m 開頭識別碼),以及 text(你的發言)或 end: true(結束會議)。這次收到的參數是:${JSON.stringify(Object.keys(args))}。`);
          return text(await this.meetingSay(callerId, rid, say, end));
        }
        if (params?.name === 'case_submit') {
          if (!this.caseSubmit) throw new Error('判例功能沒有啟用。');
          return text(await this.caseSubmit(callerId, args));
        }
        if (params?.name === 'memory_search' || params?.name === 'memory_write') {
          const deps = this.core?.memoryDeps();
          const caller = this.core?.memoryCaller(callerId);
          if (!deps || !caller) throw new Error('記憶庫現在不能用。');
          const s = (...keys: string[]) => pick(...keys);
          if (params.name === 'memory_search') return text(await memorySearch(deps, caller, { query: s('query', 'q', 'keywords', 'text'), kind: s('kind', 'type'), node: s('node', 'node_name'), project: s('project') }));
          return text(await memoryWrite(deps, caller, { kind: s('kind', 'type'), title: s('title', 'name'), content: s('content', 'text', 'body'), project: s('project') }));
        }
        return text(`沒有這個工具:${String(params?.name)}`, true);
      } catch (err) {
        return text(String((err as Error)?.message ?? err).slice(0, 1000), true);
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${String(method)}` } };
  }

  private agents(): AgentInfo[] {
    return this.core?.snapshot().agents ?? [];
  }

  private describe(a: AgentInfo): string {
    return `${a.name}(${BACKEND_LABEL[a.backend]}${a.model ? ` · ${a.model}` : ''})`;
  }

  private listNodes(callerId: string): string {
    const peers = this.agents().filter(a => !a.parentId && a.id !== callerId);
    if (!peers.length) return '面板上沒有其他節點。';
    const lines = peers.map(a => {
      const ready = (a.state === 'idle' || a.state === 'error') && !a.terminal;
      return `- 名稱:${a.name} | id:${a.id} | 後台:${BACKEND_LABEL[a.backend]}${a.model ? ` | 模型:${a.model}` : ''} | 狀態:${a.terminal ? '終端機模式' : STATE_LABEL[a.state]}${ready ? '(可以呼叫)' : '(現在不能呼叫)'} | 工作目錄:${a.cwd}`;
    });
    return `面板上的其他節點(只有「待命」的可以用 ask_node 呼叫):\n${lines.join('\n')}`;
  }

  /** 找出目標節點:先比對 id,再比對名稱(不分大小寫);名稱重複時要求改用 id。 */
  private resolve(callerId: string, node: string): AgentInfo {
    const peers = this.agents().filter(a => !a.parentId && a.id !== callerId);
    const key = node.trim();
    const hit = peers.find(a => a.id === key);
    if (hit) return hit;
    const named = peers.filter(a => a.name.toLowerCase() === key.toLowerCase());
    if (named.length === 1) return named[0];
    if (named.length > 1) throw new Error(`有 ${named.length} 個節點都叫「${key}」,請改用 id 指定:${named.map(a => a.id).join('、')}`);
    throw new Error(`找不到節點「${key}」。請先用 list_nodes 看有哪些節點(不能呼叫自己或子代理)。`);
  }

  private checkReady(target: AgentInfo): void {
    if (target.terminal) throw new Error(`節點「${target.name}」在終端機模式,現在不能呼叫。`);
    if (target.state === 'sleeping' || target.state === 'lost') throw new Error(`節點「${target.name}」${STATE_LABEL[target.state]},要先由使用者喚醒才能呼叫。`);
    // 上一個回合出錯停下來的節點可以再接新指令(和使用者手動送指令一樣)
    if (target.state !== 'idle' && target.state !== 'error') throw new Error(`節點「${target.name}」正在忙(${STATE_LABEL[target.state]}),請稍後再試,或改找別的節點。`);
  }

  private async askNode(callerId: string, node: string, prompt: string): Promise<string> {
    const core = this.core!;
    this.prune();
    const caller = this.agents().find(a => a.id === callerId);
    if (!caller) throw new Error('呼叫者不是面板上的節點。');
    if (!prompt.trim()) throw new Error('prompt 不能是空的。');
    if (prompt.length > MAX_PROMPT) throw new Error(`prompt 太長(上限 ${MAX_PROMPT} 字)。`);
    const target = this.resolve(callerId, node);
    this.checkReady(target);
    // 迴圈與深度:沿著「誰在等誰」往上走
    const waitingOn = new Map<string, string>();
    for (const p of this.pending.values()) if (p.status === 'running') waitingOn.set(p.targetId, p.callerId);
    let depth = 1;
    for (let cur: string | undefined = callerId; cur; cur = waitingOn.get(cur)) {
      if (cur === target.id) throw new Error(`節點「${target.name}」正在等你(或等著呼叫你的節點)的答覆,不能反過來呼叫它。`);
      if (++depth > MAX_DEPTH + 1) throw new Error(`節點互相呼叫最多 ${MAX_DEPTH} 層,不能再往下呼叫。請自己完成,或把結果回報給呼叫你的節點。`);
    }
    // 是否要使用者同意,跟著呼叫方節點的權限模式
    if (caller.permissionMode !== 'auto') {
      const decision = await core.requestApproval(callerId, '呼叫節點', `${this.describe(target)}:${prompt.replace(/\s+/g, ' ').slice(0, 100)}`, `要把下面的指令交給節點 ${this.describe(target)}(工作目錄 ${target.cwd},權限模式:${target.permissionMode === 'auto' ? '自動' : '每次詢問'}):\n\n${prompt}`);
      if (decision === 'deny') throw new Error('使用者拒絕了這次呼叫。');
      // 等待授權的期間對方可能已經開始做別的事
      const again = this.agents().find(a => a.id === target.id);
      if (!again) throw new Error(`節點「${target.name}」已經不在了。`);
      this.checkReady(again);
    }
    const p: Pending = { id: randomUUID().slice(0, 8), callerId, targetId: target.id, targetName: target.name, createdAt: Date.now(), started: false, parts: [], status: 'running', error: '', waiters: new Set(), title: dispatchTitle(prompt) };
    this.pending.set(p.id, p);
    core.recordDispatch(this.dispatchOf(p, 'running'));
    this.publish();
    // 讓被呼叫的 agent 自己也知道是誰找它、答覆會交給誰(這一行會送進 CLI,對話裡也看得到)
    const header = `(主控台:這則指令來自節點「${caller.name}」(${BACKEND_LABEL[caller.backend]}${caller.model ? ` · ${caller.model}` : ''}),不是使用者直接下的;你這個回合的答覆會交還給它。)`;
    try {
      await core.send(target.id, `${header}

${prompt}`, [], 'user', 'interop', { id: caller.id, name: caller.name });
      // 記下這次交辦產生的任務,分派紀錄才查得到花費
      const taskId = core.currentTaskId(target.id);
      if (taskId && p.status === 'running') { p.taskId = taskId; core.recordDispatch(this.dispatchOf(p, 'running')); }
      else if (taskId) p.taskId = taskId;
    } catch (err) {
      this.finish(p, 'failed', String((err as Error)?.message ?? err));
    }
    return this.await(p);
  }

  private async waitReply(callerId: string, requestId: string): Promise<string> {
    this.prune();
    const meeting = this.meetings.get(requestId.trim());
    if (meeting && meeting.callerId === callerId) return this.awaitMeeting(meeting);
    const p = this.pending.get(requestId.trim());
    if (!p || p.callerId !== callerId) throw new Error(`找不到 request_id「${requestId}」(可能已經過期,或不是你發出的)。`);
    return this.await(p);
  }

  /** 等到對方回合結束,或等滿 WAIT_MS 先返回。 */
  private async await(p: Pending): Promise<string> {
    if (p.status === 'running') {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); p.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, WAIT_MS);
        p.waiters.add(done);
      });
    }
    if (p.status === 'running') return `節點「${p.targetName}」還在執行(已經 ${Math.round((Date.now() - p.createdAt) / 1000)} 秒)。request_id:${p.id}\n請呼叫 wait_reply,帶上這個 request_id 繼續等它的答覆。`;
    const reply = p.parts.join('\n\n').slice(-MAX_REPLY).trim();
    if (p.status === 'failed') throw new Error(`節點「${p.targetName}」沒有完成:${p.error}${reply ? `\n它在停下來之前的回覆:\n${reply}` : ''}`);
    return reply ? `節點「${p.targetName}」的答覆:\n\n${reply}` : `節點「${p.targetName}」完成了這個回合,但沒有留下文字答覆。`;
  }

  // ---------- 會議

  private async startMeeting(callerId: string, topic: string, names: string[], rounds: number, hostTurns: boolean): Promise<string> {
    const core = this.core!;
    this.prune();
    const caller = this.agents().find(a => a.id === callerId);
    if (!caller) throw new Error('呼叫者不是面板上的節點。');
    if (topic.length > MAX_PROMPT) throw new Error(`topic 太長(上限 ${MAX_PROMPT} 字)。`);
    if ([...this.meetings.values()].some(m => m.status === 'running' && m.callerId === callerId)) throw new Error('你召開的上一場會議還在進行,請先用 wait_reply 等它結束。');
    const members: AgentInfo[] = [];
    for (const n of names) { const a = this.resolve(callerId, n); if (!members.some(x => x.id === a.id)) members.push(a); }
    if (members.length > MEETING_MAX_PARTICIPANTS) throw new Error(`一場會議最多 ${MEETING_MAX_PARTICIPANTS} 個參與節點。`);
    for (const a of members) this.checkReady(a);
    const total = Math.min(MEETING_MAX_ROUNDS, Math.max(1, Math.round(Number.isFinite(rounds) ? rounds : 2)));
    // 迴圈與深度:和 ask_node 相同
    const waitingOn = new Map<string, string>();
    for (const p of this.pending.values()) if (p.status === 'running') waitingOn.set(p.targetId, p.callerId);
    let depth = 1;
    for (let cur: string | undefined = callerId; cur; cur = waitingOn.get(cur)) {
      const hit = members.find(a => a.id === cur);
      if (hit) throw new Error(`節點「${hit.name}」正在等你(或等著呼叫你的節點)的答覆,不能找它開會。`);
      if (++depth > MAX_DEPTH + 1) throw new Error(`節點互相呼叫最多 ${MAX_DEPTH} 層,不能再往下召開會議。`);
    }
    const who = members.map(a => this.describe(a)).join('、');
    // 「每次詢問」模式:開會時問一次,整場放行
    if (caller.permissionMode !== 'auto') {
      const decision = await core.requestApproval(callerId, '召開會議', `${members.map(a => a.name).join('、')}(最多 ${total} 輪):${topic.replace(/\s+/g, ' ').slice(0, 80)}`, `要召開一場會議,參與的節點:${who}。最多 ${total} 輪,每輪每個節點發言一次(各算一個回合,會用到它們的額度)${hostTurns ? ',每輪之間由召開者主持發言' : ''};允許後整場會議不再逐次詢問。\n\n主題:\n${topic}`);
      if (decision === 'deny') throw new Error('使用者拒絕召開這場會議。');
    }
    const m: Meeting = { id: `m${randomUUID().slice(0, 7)}`, callerId, callerName: caller.name, topic, participants: members.map(a => ({ id: a.id, name: a.name })), rounds: total, createdAt: Date.now(), transcript: [], status: 'running', error: '', current: null, waiters: new Set(), hostTurns, hostTurn: null, hostSeen: 0 };
    this.meetings.set(m.id, m);
    this.publish();
    core.note(callerId, `會議開始(${m.id}):參與者 ${who};最多 ${total} 輪${hostTurns ? ',每輪之間輪到主持人發言' : ''}。中斷這個節點就會散會。`);
    void this.runMeeting(m, `${caller.name}(${BACKEND_LABEL[caller.backend]}${caller.model ? ` · ${caller.model}` : ''})`).catch(err => this.endMeeting(m, 'failed', String((err as Error)?.message ?? err)));
    return this.awaitMeeting(m);
  }

  /** 主持會議:每一輪依序請參與者發言。 */
  private async runMeeting(m: Meeting, host: string): Promise<void> {
    const core = this.core!;
    const roster = m.participants.map(x => x.name).join('、');
    const hostNote = m.hostTurns ? `主持人「${m.callerName}」會在每一輪之間發言(追問、回應或指定下一輪的重點),它的發言也會轉給你。` : '';
    // 每位參與者已經看過紀錄的哪裡(自己的 session 記得之前的內容,只給新的)
    const seen = new Map<string, number>();
    for (let round = 1; round <= m.rounds && m.status === 'running'; round++) {
      let spoke = 0, nothing = 0;
      for (const part of m.participants) {
        if (m.status !== 'running') return;
        const agent = this.agents().find(a => a.id === part.id);
        let skip = '';
        if (!agent) skip = '節點已經不在了';
        else try { this.checkReady(agent); } catch (err) { skip = String((err as Error).message).replace(/^節點「[^」]*」/, ''); }
        if (skip) { this.record(m, 0, part.name, `(第 ${round} 輪略過:${skip})`); continue; }
        const news = m.transcript.slice(seen.get(part.id) ?? 0).filter(t => t.round > 0 && t.name !== part.name);
        seen.set(part.id, m.transcript.length);
        const prompt = [
          `(主控台:這是一場由節點「${host}」召開的會議,不是使用者直接下的指令。參與者:${roster}。現在是第 ${round} 輪(最多 ${m.rounds} 輪),輪到你「${part.name}」發言;你的發言會記入會議紀錄,交給其他參與者與主持人。${hostNote})`,
          round === 1 || !seen.has(`${part.id}:topic`) ? `【主題】\n${m.topic}` : '',
          news.length ? `【你上次發言之後,其他人的發言】\n${news.map(t => `◆ ${t.name}(第 ${t.round} 輪):\n${t.text}`).join('\n\n')}` : round === 1 ? '【目前還沒有人發言,由你先開始】' : '【你上次發言之後,沒有新的發言】',
          `【請你發言】針對主題與其他人的發言提出你的看法:同意什麼、不同意什麼、有什麼補充或疑問。請直接講重點,不要客套,也不要重複別人說過的內容。這是討論,除非主題明確要求,否則不要修改檔案。如果你認為已經沒有需要補充的,請在發言最後單獨一行寫「${NOTHING_TO_ADD}」。`,
        ].filter(Boolean).join('\n\n');
        seen.set(`${part.id}:topic`, 1);
        const p: Pending = { id: randomUUID().slice(0, 8), callerId: m.callerId, targetId: part.id, targetName: part.name, createdAt: Date.now(), started: false, parts: [], status: 'running', error: '', waiters: new Set(), meetingId: m.id };
        this.pending.set(p.id, p);
        m.current = p;
        this.publish();
        try { await core.send(part.id, prompt, [], 'user', 'interop', { id: m.callerId, name: m.callerName, meeting: true }); } catch (err) { this.finish(p, 'failed', String((err as Error)?.message ?? err)); }
        // 等這位講完;太久就中斷它,換下一位
        if (p.status === 'running') await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); p.waiters.delete(done); resolve(); };
          const timer = setTimeout(() => { core.interrupt(part.id); this.finish(p, 'failed', `發言超過 ${Math.round(MEETING_TURN_MS / 60000)} 分鐘`); }, MEETING_TURN_MS);
          p.waiters.add(done);
        });
        m.current = null;
        this.publish();
        if (m.status !== 'running') return;
        const said = p.parts.join('\n\n').trim();
        if (p.status === 'failed') { this.record(m, 0, part.name, `(第 ${round} 輪沒有完成發言:${p.error})${said ? `\n${said.slice(-MEETING_STATEMENT_MAX)}` : ''}`); continue; }
        spoke++;
        if (said.includes(NOTHING_TO_ADD)) nothing++;
        this.record(m, round, part.name, said.slice(-MEETING_STATEMENT_MAX) || '(沒有文字發言)');
      }
      if (!spoke) { this.endMeeting(m, 'failed', '這一輪沒有任何參與者完成發言'); return; }
      // 還有下一輪:交給主持人發言或結束(所有人都沒有補充時也由主持人決定)
      if (m.hostTurns && round < m.rounds) {
        const end = await this.hostTurn(m, round, nothing === spoke);
        if (m.status !== 'running') return;
        if (end) break;
        continue;
      }
      if (nothing === spoke) { this.record(m, 0, '主控台', `第 ${round} 輪所有人都表示沒有補充,提前結束。`); break; }
    }
    this.endMeeting(m, 'done', '');
  }

  /** 第 round 輪結束,等主持人用 meeting_say 發言;回傳是否結束會議。太久沒回應就結束。 */
  private hostTurn(m: Meeting, round: number, quiet: boolean): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => {
        if (m.hostTurn?.round !== round) return;
        this.record(m, 0, '主控台', `主持人超過 ${Math.round(MEETING_TURN_MS / 60000)} 分鐘沒有發言,會議結束。`);
        m.hostTurn.resolve(true);
      }, MEETING_TURN_MS);
      m.hostTurn = { round, quiet, resolve: end => { clearTimeout(timer); m.hostTurn = null; resolve(end); } };
      this.core?.note(m.callerId, `【會議 ${m.id}】第 ${round} 輪結束,輪到主持人發言。`);
      for (const w of m.waiters) w();
      m.waiters.clear();
    });
  }

  private async meetingSay(callerId: string, requestId: string, text: string, end: boolean): Promise<string> {
    this.prune();
    const m = this.meetings.get(requestId.trim());
    if (!m || m.callerId !== callerId) throw new Error(`找不到會議「${requestId}」(可能已經過期,或不是你召開的)。`);
    if (m.status !== 'running') return this.awaitMeeting(m);
    const turn = m.hostTurn;
    if (!turn) throw new Error('現在還沒輪到主持人發言(參與者還在發言)。請用 wait_reply 等到工具回傳「輪到你(主持人)發言」。');
    const said = text.trim();
    if (said.length > MAX_PROMPT) throw new Error(`發言太長(上限 ${MAX_PROMPT} 字)。`);
    if (said) this.record(m, turn.round, `${m.callerName}(主持人)`, said);
    if (end) this.record(m, 0, '主控台', '主持人結束了會議。');
    // 自己的發言不必再回給自己
    m.hostSeen = m.transcript.length;
    turn.resolve(end);
    return this.awaitMeeting(m);
  }

  /** 輪到主持人時回給它的內容:上次發言之後的新發言,以及怎麼繼續。 */
  private hostTurnText(m: Meeting): string {
    const turn = m.hostTurn!;
    let news = m.transcript.slice(m.hostSeen).map(t => (t.round > 0 ? `◆ ${t.name}(第 ${t.round} 輪):\n${t.text}` : `〔${t.name === '主控台' ? '' : `${t.name}:`}${t.text}〕`)).join('\n\n');
    if (news.length > MAX_REPLY) news = `(太長,只保留最後一段)\n${news.slice(-MAX_REPLY)}`;
    return [
      `會議第 ${turn.round} 輪結束(最多 ${m.rounds} 輪),輪到你(主持人)發言。request_id:${m.id}${turn.quiet ? '\n這一輪所有參與者都表示沒有補充。' : ''}`,
      `【你上次發言之後的新發言】\n${news || '(沒有新的發言)'}`,
      `請呼叫 meeting_say,帶上 request_id「${m.id}」:\n- text:你的發言(提問、回應、追問或指定下一輪的重點),會交給所有參與者,接著進行第 ${turn.round + 1} 輪;\n- 或 end 設為 true:結束會議,拿回完整的會議紀錄。\n${Math.round(MEETING_TURN_MS / 60000)} 分鐘內沒有回應,會議會自動結束。`,
    ].join('\n\n');
  }

  /** 記一則發言,並即時顯示在召開者的對話裡。 */
  private record(m: Meeting, round: number, name: string, text: string): void {
    m.transcript.push({ round, name, text });
    this.core?.note(m.callerId, round > 0 ? `【會議 ${m.id}|第 ${round} 輪|${name}】\n${text}` : `【會議 ${m.id}】${name === '主控台' ? '' : `${name} `}${text}`);
  }

  private endMeeting(m: Meeting, status: 'done' | 'failed', error: string): void {
    if (m.status !== 'running') return;
    m.status = status;
    m.error = error;
    // 散會時正在發言的節點一併中斷
    const cur = m.current;
    if (cur && cur.status === 'running') { this.core?.interrupt(cur.targetId); this.finish(cur, 'failed', '會議中止'); }
    m.current = null;
    m.hostTurn?.resolve(true);
    this.publish();
    this.core?.note(m.callerId, status === 'done' ? `會議結束(${m.id}),共 ${m.transcript.filter(t => t.round > 0).length} 則發言。` : `會議中止(${m.id}):${error}`);
    for (const w of m.waiters) w();
    m.waiters.clear();
  }

  private async awaitMeeting(m: Meeting): Promise<string> {
    if (m.status === 'running' && !m.hostTurn) {
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); m.waiters.delete(done); resolve(); };
        const timer = setTimeout(done, WAIT_MS);
        m.waiters.add(done);
      });
    }
    if (m.status === 'running' && m.hostTurn) return this.hostTurnText(m);
    const said = m.transcript.filter(t => t.round > 0).length;
    if (m.status === 'running') return `會議進行中(已經 ${Math.round((Date.now() - m.createdAt) / 1000)} 秒,目前 ${said} 則發言${m.current ? `,正在發言:${m.current.targetName}` : ''})。request_id:${m.id}\n請呼叫 wait_reply,帶上這個 request_id 繼續等會議結束;結束後會拿到完整的會議紀錄。`;
    let log = m.transcript.map(t => (t.round > 0 ? `◆ ${t.name}(第 ${t.round} 輪):\n${t.text}` : `〔${t.name === '主控台' ? '' : `${t.name}:`}${t.text}〕`)).join('\n\n');
    if (log.length > MAX_REPLY) log = `(紀錄太長,只保留最後一段)\n${log.slice(-MAX_REPLY)}`;
    const head = `會議${m.status === 'done' ? '結束' : `中止:${m.error}`}。參與者:${m.participants.map(x => x.name).join('、')};共 ${said} 則發言。`;
    return `${head}\n\n【會議紀錄】\n${log || '(沒有發言)'}\n\n請依這份紀錄整理出結論、各方的分歧與建議的下一步,回報給使用者。`;
  }
}
