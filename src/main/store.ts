import { DatabaseSync } from 'node:sqlite';
import type { AdapterEvent, AgentInfo, AuditEntry, Backend, NexusEvent, QueuedPrompt, TaskInfo } from '../shared/types';
import type { DispatchEntry, MemoryEntry } from '../shared/types';
import type { QuotaBaseline, SpendRow } from '../shared/dashboard';

function parseJson<T>(v: unknown): T | null {
  if (typeof v !== 'string' || !v) return null;
  try { return JSON.parse(v) as T; } catch { return null; }
}

function parseQueue(v: unknown): QueuedPrompt[] {
  const list = parseJson<QueuedPrompt[]>(v);
  return Array.isArray(list) ? list.filter(q => q && typeof q.id === 'string' && typeof q.text === 'string').map(q => ({ ...q, images: Array.isArray(q.images) ? q.images : [] })) : [];
}

/** 事件資料庫。畫面上的一切都是這份資料的呈現,重開後由這裡還原。 */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        backend TEXT NOT NULL,
        cwd TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        session_id TEXT,
        state TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        removed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_agent ON events (agent_id, seq);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        device TEXT NOT NULL,
        role TEXT NOT NULL,
        action TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        ok INTEGER NOT NULL
      );
      -- 總覽儀表:每天、每個後台、每個節點的花費累計
      CREATE TABLE IF NOT EXISTS spend_daily (
        date TEXT NOT NULL,
        backend TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        agent_name TEXT NOT NULL DEFAULT '',
        tokens INTEGER NOT NULL DEFAULT 0,
        usd REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (date, backend, agent_id)
      );
      -- 總覽儀表:各後台每天的每週額度起點(今天的用量 = last − base)
      CREATE TABLE IF NOT EXISTS quota_baseline (
        date TEXT NOT NULL,
        backend TEXT NOT NULL,
        base REAL NOT NULL,
        last REAL NOT NULL,
        resets_at INTEGER,
        warned INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, backend)
      );
      -- 總覽儀表:每個任務是哪一天交辦的、最後的狀態;任務面板清除已結束的任務後,今天的統計仍然算得出來
      CREATE TABLE IF NOT EXISTS task_daily (id TEXT PRIMARY KEY, date TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_daily_date ON task_daily (date);
      -- 分派紀錄:節點用 ask_node 交辦給其他節點的每一筆(保留 30 天)
      CREATE TABLE IF NOT EXISTS dispatch_log (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS dispatch_log_started ON dispatch_log (started_at);
      -- 記憶庫索引:memory-vault 資料夾裡每個 .md 檔一筆;檔案才是正本,這張表隨時可以由掃描重建
      CREATE TABLE IF NOT EXISTS memory_index (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        project_id TEXT NOT NULL DEFAULT '',
        node_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '',
        subtype TEXT NOT NULL DEFAULT '',
        supersedes TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS memory_project ON memory_index (project_id);
    `);
    // 記憶索引新增 subtype、supersedes 欄位:舊表補欄位後清空,下次掃描時整個重建(索引隨時可由檔案重建)
    const memCols = this.db.prepare('PRAGMA table_info(memory_index)').all() as Array<{ name: string }>;
    if (!memCols.some(c => c.name === 'subtype')) {
      this.db.exec("ALTER TABLE memory_index ADD COLUMN subtype TEXT NOT NULL DEFAULT ''");
      this.db.exec("ALTER TABLE memory_index ADD COLUMN supersedes TEXT NOT NULL DEFAULT ''");
      this.db.exec('DELETE FROM memory_index');
    }
    // 舊版資料庫沒有 character 欄位
    const cols = this.db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'character')) this.db.exec("ALTER TABLE agents ADD COLUMN character TEXT NOT NULL DEFAULT ''");
    if (!cols.some(c => c.name === 'worktree')) this.db.exec('ALTER TABLE agents ADD COLUMN worktree TEXT');
    if (!cols.some(c => c.name === 'spent')) this.db.exec('ALTER TABLE agents ADD COLUMN spent TEXT');
    if (!cols.some(c => c.name === 'model')) this.db.exec("ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    // 排隊中的指令(JSON 陣列)與佇列暫停原因;舊版資料庫沒有這兩欄,讀出時當作空佇列
    if (!cols.some(c => c.name === 'queue')) this.db.exec('ALTER TABLE agents ADD COLUMN queue TEXT');
    // 任務面板「清除已結束」只是隱藏(cleared = 1),任務紀錄仍保留給節點統計使用
    const taskCols = this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!taskCols.some(c => c.name === 'cleared')) this.db.exec('ALTER TABLE tasks ADD COLUMN cleared INTEGER NOT NULL DEFAULT 0');
    if (!cols.some(c => c.name === 'queue_paused')) this.db.exec('ALTER TABLE agents ADD COLUMN queue_paused TEXT');
  }

  loadAgents(): AgentInfo[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE removed_at IS NULL ORDER BY created_at').all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      name: r.name as string,
      character: (r.character as string | null) ?? '',
      model: (r.model as string | null) ?? '',
      context: null,
      parentId: null,
      backend: r.backend as AgentInfo['backend'],
      cwd: r.cwd as string,
      permissionMode: r.permission_mode as AgentInfo['permissionMode'],
      sessionId: (r.session_id as string | null) ?? null,
      state: r.state as AgentInfo['state'],
      detail: r.detail as string,
      pendingApproval: null,
      pendingQuestion: null,
      worktree: parseJson(r.worktree),
      spent: parseJson(r.spent) ?? { tokens: 0, usd: 0 },
      terminal: false,
      simulated: false,
      createdAt: Number(r.created_at),
      queued: parseQueue(r.queue),
      queuePaused: (r.queue_paused as string | null) ?? null,
    }));
  }

  /** 已終止但還留著 session 的節點,最近終止的排前面。名稱、角色、模型都還在,可以復原。 */
  loadRemovedAgents(): Array<{ agent: AgentInfo; removedAt: number }> {
    const rows = this.db.prepare('SELECT * FROM agents WHERE removed_at IS NOT NULL AND session_id IS NOT NULL ORDER BY removed_at DESC LIMIT 200').all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      removedAt: Number(r.removed_at),
      agent: {
        id: r.id as string,
        name: r.name as string,
        character: (r.character as string | null) ?? '',
        model: (r.model as string | null) ?? '',
        context: null,
        parentId: null,
        backend: r.backend as AgentInfo['backend'],
        cwd: r.cwd as string,
        permissionMode: r.permission_mode as AgentInfo['permissionMode'],
        sessionId: r.session_id as string,
        state: 'sleeping',
        detail: '',
        pendingApproval: null,
      pendingQuestion: null,
      worktree: parseJson(r.worktree),
      spent: parseJson(r.spent) ?? { tokens: 0, usd: 0 },
      terminal: false,
        simulated: false,
        createdAt: Number(r.created_at),
        queued: [],
        queuePaused: null,
      },
    }));
  }

  updateAgentMeta(a: AgentInfo): void {
    this.db.prepare('UPDATE agents SET name = ?, character = ?, model = ?, permission_mode = ? WHERE id = ?').run(a.name, a.character, a.model, a.permissionMode, a.id);
  }

  restoreAgent(id: string, name: string): void {
    this.db.prepare('UPDATE agents SET removed_at = NULL, name = ? WHERE id = ?').run(name, id);
  }

  firstUserMessage(agentId: string): string {
    const rows = this.db.prepare("SELECT payload FROM events WHERE agent_id = ? AND type = 'message' ORDER BY seq LIMIT 6").all(agentId) as Array<{ payload: string }>;
    for (const r of rows) {
      try { const p = JSON.parse(r.payload); if (p.role === 'user') return String(p.text); } catch { /* 略過壞掉的紀錄 */ }
    }
    return '';
  }

  insertAgent(a: AgentInfo): void {
    this.db.prepare('INSERT INTO agents (id, name, character, model, worktree, backend, cwd, permission_mode, session_id, state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.name, a.character, a.model, a.worktree ? JSON.stringify(a.worktree) : null, a.backend, a.cwd, a.permissionMode, a.sessionId, a.state, a.detail, a.createdAt);
  }

  updateAgent(a: AgentInfo): void {
    this.db.prepare('UPDATE agents SET session_id = ?, state = ?, detail = ?, spent = ? WHERE id = ?').run(a.sessionId, a.state, a.detail, JSON.stringify(a.spent), a.id);
  }

  /** 轉移工作區:更新節點的工作目錄與獨立工作區資訊。 */
  updateAgentPlace(a: AgentInfo): void {
    this.db.prepare('UPDATE agents SET cwd = ?, worktree = ? WHERE id = ?').run(a.cwd, a.worktree ? JSON.stringify(a.worktree) : null, a.id);
  }

  updateQueue(a: AgentInfo): void {
    this.db.prepare('UPDATE agents SET queue = ?, queue_paused = ? WHERE id = ?').run(a.queued.length ? JSON.stringify(a.queued) : null, a.queuePaused, a.id);
  }

  markRemoved(id: string): void {
    this.db.prepare('UPDATE agents SET removed_at = ? WHERE id = ?').run(Date.now(), id);
  }

  appendEvent(agentId: string, e: AdapterEvent): NexusEvent {
    const ts = Date.now();
    const res = this.db.prepare('INSERT INTO events (agent_id, ts, type, payload) VALUES (?, ?, ?, ?)').run(agentId, ts, e.type, JSON.stringify(e));
    return { ...e, seq: Number(res.lastInsertRowid), agentId, ts };
  }

  /**
   * 分支對話用:把一個節點到目前為止的對話相關事件(訊息、工具、授權、提問、說明、錯誤)複製給另一個節點。
   * 狀態、session、用量、計畫、子代理事件不複製,以免影響新節點的狀態與任務。保留原本的時間,回傳複製的筆數。
   */
  copyConversation(fromId: string, toId: string): number {
    const res = this.db.prepare(`INSERT INTO events (agent_id, ts, type, payload) SELECT ?, ts, type, payload FROM events
      WHERE agent_id = ? AND type IN ('message', 'tool', 'approval_request', 'approval_resolved', 'question', 'question_resolved', 'note', 'error') ORDER BY seq`).run(toId, fromId);
    return Number(res.changes);
  }

  recentEvents(limit: number): NexusEvent[] {
    const rows = this.db.prepare('SELECT seq, agent_id, ts, payload FROM events ORDER BY seq DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(r => ({
      ...(JSON.parse(r.payload as string) as AdapterEvent),
      seq: Number(r.seq),
      agentId: r.agent_id as string,
      ts: Number(r.ts),
    }));
  }

  agentEvents(agentId: string, limit: number): NexusEvent[] {
    const rows = this.db.prepare('SELECT seq, agent_id, ts, payload FROM events WHERE agent_id = ? ORDER BY seq DESC LIMIT ?').all(agentId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(r => ({
      ...(JSON.parse(r.payload as string) as AdapterEvent),
      seq: Number(r.seq),
      agentId: r.agent_id as string,
      ts: Number(r.ts),
    }));
  }

  saveTask(t: TaskInfo): void {
    this.db.prepare('INSERT INTO tasks (id, started_at, ended_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = excluded.ended_at, data = excluded.data')
      .run(t.id, t.startedAt, t.endedAt, JSON.stringify(t));
  }

  loadTasks(limit: number): TaskInfo[] {
    const rows = this.db.prepare('SELECT data FROM tasks WHERE cleared = 0 ORDER BY started_at DESC LIMIT ?').all(limit) as Array<{ data: string }>;
    return rows.reverse().map(r => JSON.parse(r.data) as TaskInfo);
  }

  /** 任務面板「清除已結束」:只隱藏,不刪除,節點統計還要用。 */
  deleteFinishedTasks(): void {
    this.db.exec('UPDATE tasks SET cleared = 1 WHERE ended_at IS NOT NULL');
  }

  /** 節點統計用:包含被清除的任務,只取 since 之後交辦的(最多 limit 筆,新的優先)。 */
  loadTasksForStats(since: number, limit = 5000): TaskInfo[] {
    const rows = this.db.prepare('SELECT data FROM tasks WHERE started_at >= ? ORDER BY started_at DESC LIMIT ?').all(since, limit) as Array<{ data: string }>;
    return rows.map(r => JSON.parse(r.data) as TaskInfo);
  }

  /** 超過這個時間的任務紀錄直接刪掉(統計只看近期)。 */
  pruneTasks(before: number): void {
    this.db.prepare('DELETE FROM tasks WHERE started_at < ? AND ended_at IS NOT NULL').run(before);
  }

  memoryAll(): MemoryEntry[] {
    const rows = this.db.prepare('SELECT * FROM memory_index ORDER BY path').all() as Array<Record<string, unknown>>;
    return rows.map(r => ({
      path: String(r.path), kind: String(r.kind) as MemoryEntry['kind'], scope: String(r.scope) as MemoryEntry['scope'], projectId: String(r.project_id), nodeId: String(r.node_id),
      title: String(r.title), updatedAt: Number(r.updated_at), mtime: Number(r.mtime), size: Number(r.size), status: String(r.status),
      subtype: String(r.subtype ?? ''), supersedes: String(r.supersedes ?? ''),
    }));
  }

  memoryPut(e: MemoryEntry): void {
    this.db.prepare(`INSERT INTO memory_index (path, kind, scope, project_id, node_id, title, updated_at, mtime, size, status, subtype, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, scope = excluded.scope, project_id = excluded.project_id, node_id = excluded.node_id, title = excluded.title,
        updated_at = excluded.updated_at, mtime = excluded.mtime, size = excluded.size, status = excluded.status, subtype = excluded.subtype, supersedes = excluded.supersedes`)
      .run(e.path, e.kind, e.scope, e.projectId, e.nodeId, e.title, e.updatedAt, e.mtime, e.size, e.status, e.subtype, e.supersedes);
  }

  memoryDelete(path: string): void {
    this.db.prepare('DELETE FROM memory_index WHERE path = ?').run(path);
  }

  /** 把一筆花費加進當天的累計(同一天、同一個後台、同一個節點一筆);節點名稱記最新的。 */
  addSpend(date: string, backend: Backend, agentId: string, agentName: string, tokens: number, usd: number): void {
    this.db.prepare(`INSERT INTO spend_daily (date, backend, agent_id, agent_name, tokens, usd) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, backend, agent_id) DO UPDATE SET tokens = tokens + excluded.tokens, usd = usd + excluded.usd, agent_name = excluded.agent_name`)
      .run(date, backend, agentId, agentName, Math.max(0, Math.round(tokens)), Math.max(0, usd));
  }

  /** from(含)之後每天的花費,依日期排序。 */
  spendSince(from: string): SpendRow[] {
    const rows = this.db.prepare('SELECT * FROM spend_daily WHERE date >= ? ORDER BY date, backend, agent_id').all(from) as Array<Record<string, unknown>>;
    return rows.map(r => ({ date: String(r.date), backend: r.backend as Backend, agentId: String(r.agent_id), agentName: String(r.agent_name), tokens: Number(r.tokens), usd: Number(r.usd) }));
  }

  /** 某個後台最近一天的額度起點紀錄;還沒有任何紀錄時是 null。 */
  latestBaseline(backend: Backend): QuotaBaseline | null {
    const r = this.db.prepare('SELECT * FROM quota_baseline WHERE backend = ? ORDER BY date DESC LIMIT 1').get(backend) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { date: String(r.date), backend, base: Number(r.base), last: Number(r.last), resetsAt: r.resets_at === null ? null : Number(r.resets_at), warned: Number(r.warned) === 1 };
  }

  saveBaseline(b: QuotaBaseline): void {
    this.db.prepare(`INSERT INTO quota_baseline (date, backend, base, last, resets_at, warned) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, backend) DO UPDATE SET base = excluded.base, last = excluded.last, resets_at = excluded.resets_at, warned = excluded.warned`)
      .run(b.date, b.backend, b.base, b.last, b.resetsAt, b.warned ? 1 : 0);
  }

  /** 記下任務是哪一天交辦的與目前的狀態(任務每次更新都會呼叫;日期以第一次記下的為準)。 */
  recordTask(id: string, date: string, agentId: string, status: string): void {
    this.db.prepare('INSERT INTO task_daily (id, date, agent_id, status) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status').run(id, date, agentId, status);
  }

  /** 某一天交辦的任務(節點與狀態)。 */
  tasksOn(date: string): Array<{ agentId: string; status: string }> {
    const rows = this.db.prepare('SELECT agent_id, status FROM task_daily WHERE date = ?').all(date) as Array<Record<string, unknown>>;
    return rows.map(r => ({ agentId: String(r.agent_id), status: String(r.status) }));
  }

  /** 儀表的每日紀錄只保留一段時間(before 之前的日期刪掉)。 */
  pruneDaily(before: string): void {
    this.db.prepare('DELETE FROM spend_daily WHERE date < ?').run(before);
    this.db.prepare('DELETE FROM quota_baseline WHERE date < ?').run(before);
    this.db.prepare('DELETE FROM task_daily WHERE date < ?').run(before);
  }

  saveDispatch(d: DispatchEntry): void {
    this.db.prepare('INSERT INTO dispatch_log (id, started_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(d.id, d.startedAt, JSON.stringify(d));
  }

  /** 最近的分派紀錄,新的在前。 */
  loadDispatches(limit: number): DispatchEntry[] {
    const rows = this.db.prepare('SELECT data FROM dispatch_log ORDER BY started_at DESC, id DESC LIMIT ?').all(limit) as Array<{ data: string }>;
    return rows.map(r => parseJson<DispatchEntry>(r.data)).filter((d): d is DispatchEntry => !!d && typeof d.id === 'string');
  }

  pruneDispatches(before: number): void {
    this.db.prepare('DELETE FROM dispatch_log WHERE started_at < ?').run(before);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  agentEventsBetween(agentId: string, from: number, to: number): NexusEvent[] {
    const rows = this.db.prepare('SELECT seq, agent_id, ts, payload FROM events WHERE agent_id = ? AND ts >= ? AND ts <= ? ORDER BY seq').all(agentId, from, to) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      ...(JSON.parse(r.payload as string) as AdapterEvent),
      seq: Number(r.seq),
      agentId: r.agent_id as string,
      ts: Number(r.ts),
    }));
  }

  /** 遠端裝置的操作紀錄。 */
  addAudit(e: Omit<AuditEntry, 'id'>): void {
    this.db.prepare('INSERT INTO audit (ts, device_id, device, role, action, agent_id, agent_name, detail, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.ts, e.deviceId, e.device, e.role, e.action, e.agentId, e.agentName, e.detail, e.ok ? 1 : 0);
  }

  listAudit(limit: number): AuditEntry[] {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: Number(r.id), ts: Number(r.ts), deviceId: String(r.device_id), device: String(r.device), role: String(r.role) as AuditEntry['role'],
      action: String(r.action), agentId: String(r.agent_id), agentName: String(r.agent_name), detail: String(r.detail), ok: Number(r.ok) === 1,
    }));
  }

  /** 操作紀錄只保留一段時間。 */
  pruneAudit(before: number): void {
    this.db.prepare('DELETE FROM audit WHERE ts < ?').run(before);
  }

  close(): void {
    this.db.close();
  }
}
