import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { ExternalSession } from '../shared/types';

/**
 * 列出各家 CLI 留在這台電腦上的舊 session,讓使用者挑一個接回來。
 * 這裡只讀取 CLI 自己的紀錄來列清單(標題、工作目錄、時間),不讀也不碰任何登入憑證;
 * 真正接回對話仍是啟動官方 CLI 並帶上 session 編號。
 */
const LIMIT = 60;
const short = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

/** Claude Code:每個 session 是 ~/.claude/projects/<專案>/<session id>.jsonl。 */
export function listClaudeSessions(): ExternalSession[] {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return [];
  const files: Array<{ path: string; id: string; mtime: number }> = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    let names: string[] = [];
    try { names = readdirSync(join(root, dir.name)); } catch { continue; }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
      const path = join(root, dir.name, name);
      try { files.push({ path, id: name.slice(0, -6), mtime: statSync(path).mtimeMs }); } catch { /* 檔案剛被移走 */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: ExternalSession[] = [];
  const buf = Buffer.alloc(160 * 1024);
  for (const f of files.slice(0, LIMIT * 2)) {
    if (out.length >= LIMIT) break;
    let head = '';
    try {
      const fd = openSync(f.path, 'r');
      try { head = buf.toString('utf8', 0, readSync(fd, buf, 0, buf.length, 0)); } finally { closeSync(fd); }
    } catch { continue; }
    let cwd = '', title = '';
    for (const line of head.split('\n')) {
      let j: any;
      try { j = JSON.parse(line); } catch { continue; }
      if (!cwd && typeof j.cwd === 'string') cwd = j.cwd;
      if (!title && j.type === 'user' && !j.isSidechain) {
        const c = j.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join(' ') : '';
        // 去掉系統自動夾帶的標記區塊,留下使用者真正打的字
        title = short(text.replace(/<([a-z-]+)[^>]*>[\s\S]*?<\/\1>/gi, ' '), 140) || short(text, 140);
      }
      if (cwd && title) break;
    }
    if (!cwd) continue;
    out.push({ sessionId: f.id, title: title || '(沒有文字內容)', cwd, updatedAt: f.mtime, suggestedName: '' });
  }
  return out;
}

/** Codex:向 app-server 要對話清單。 */
export function listCodexSessions(bin: string): Promise<ExternalSession[]> {
  return new Promise(resolve => {
    let done = false;
    const child = spawn(bin, ['app-server'], { windowsHide: true });
    const finish = (list: ExternalSession[]) => { if (done) return; done = true; clearTimeout(timer); try { child.stdin.end(); child.kill(); } catch { /* 已結束 */ } resolve(list); };
    const timer = setTimeout(() => finish([]), 12000);
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: any;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ method: 'thread/list', id: 2, params: { limit: LIMIT } })}\n`);
        if (m.id === 2) {
          const data: any[] = Array.isArray(m.result?.data) ? m.result.data : [];
          finish(data
            // 子代理的 thread 與暫時性的 thread 不列出
            .filter(t => !t.parentThreadId && !t.ephemeral && typeof t.id === 'string' && typeof t.cwd === 'string')
            .map(t => ({
              sessionId: t.id,
              title: short(String(t.name || t.preview || ''), 140) || '(沒有文字內容)',
              cwd: t.cwd,
              updatedAt: (Number(t.updatedAt) || Number(t.createdAt) || 0) * 1000,
              suggestedName: short(String(t.name || t.agentNickname || ''), 24),
            })));
        }
      }
    });
    child.stdin.on('error', () => finish([]));
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));
    child.stdin.write(`${JSON.stringify({ method: 'initialize', id: 1, params: { clientInfo: { name: 'entropy-nexus', title: 'Entropy Nexus', version: '0.1.0' }, capabilities: null } })}\n`);
  });
}

/** Antigravity:對話摘要存在它自己的 SQLite 檔;以唯讀方式開啟。格式沒有官方文件,讀不到就回傳空清單。 */
export function listAntigravitySessions(): ExternalSession[] {
  const file = join(homedir(), '.gemini', 'antigravity-cli', 'conversation_summaries.db');
  if (!existsSync(file)) return [];
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const cols = (db.prepare('PRAGMA table_info(conversation_summaries)').all() as Array<{ name: string }>).map(c => c.name);
    const has = (c: string) => cols.includes(c);
    if (!has('conversation_id') || !has('workspace_uris')) return [];
    const parents = new Set<string>();
    try { for (const r of db.prepare('SELECT conversation_id FROM conversation_parents').all() as Array<{ conversation_id: string }>) parents.add(r.conversation_id); } catch { /* 沒有這張表 */ }
    const rows = db.prepare(`SELECT conversation_id, workspace_uris, ${has('title') ? 'title' : "''"} AS title, ${has('preview') ? 'preview' : "''"} AS preview, ${has('agent_name') ? 'agent_name' : "''"} AS agent_name, ${has('last_modified_time') ? 'last_modified_time' : "''"} AS modified FROM conversation_summaries ORDER BY modified DESC LIMIT ?`).all(LIMIT * 2) as Array<Record<string, unknown>>;
    const out: ExternalSession[] = [];
    for (const r of rows) {
      const id = String(r.conversation_id ?? '');
      if (!id || parents.has(id)) continue;
      const uri = /file:\/\/[^"',\]\s]+/.exec(String(r.workspace_uris ?? ''))?.[0];
      let cwd = '';
      try { if (uri) cwd = fileURLToPath(uri); } catch { /* 不是合法的路徑 */ }
      if (!cwd) continue;
      out.push({
        sessionId: id,
        title: short(String(r.title || r.preview || ''), 140) || '(沒有文字內容)',
        cwd,
        updatedAt: Date.parse(String(r.modified).replace(' ', 'T')) || 0,
        suggestedName: short(String(r.agent_name || ''), 24),
      });
      if (out.length >= LIMIT) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* 已關閉 */ }
  }
}
