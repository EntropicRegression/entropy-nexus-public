import { DatabaseSync } from 'node:sqlite';
import type { AdapterEvent, AgentInfo, AuditEntry, NexusEvent, QueuedPrompt, TaskInfo } from '../shared/types';

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
    `);
    // 舊版資料庫沒有 character 欄位
    const cols = this.db.prepare('PRAGMA table_info(agents)').all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'character')) this.db.exec("ALTER TABLE agents ADD COLUMN character TEXT NOT NULL DEFAULT ''");
    if (!cols.some(c => c.name === 'worktree')) this.db.exec('ALTER TABLE agents ADD COLUMN worktree TEXT');
    if (!cols.some(c => c.name === 'spent')) this.db.exec('ALTER TABLE agents ADD COLUMN spent TEXT');
    if (!cols.some(c => c.name === 'model')) this.db.exec("ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    // 排隊中的指令(JSON 陣列)與佇列暫停原因;舊版資料庫沒有這兩欄,讀出時當作空佇列
    if (!cols.some(c => c.name === 'queue')) this.db.exec('ALTER TABLE agents ADD COLUMN queue TEXT');
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
    this.db.prepare('UPDATE agents SET name = ?, character = ?, model = ? WHERE id = ?').run(a.name, a.character, a.model, a.id);
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
    const rows = this.db.prepare('SELECT data FROM tasks ORDER BY started_at DESC LIMIT ?').all(limit) as Array<{ data: string }>;
    return rows.reverse().map(r => JSON.parse(r.data) as TaskInfo);
  }

  deleteFinishedTasks(): void {
    this.db.exec('DELETE FROM tasks WHERE ended_at IS NOT NULL');
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
