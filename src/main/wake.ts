/**
 * 跨 app 喚醒網址:entropy-nexus://wake?node=<節點ID>(記憶庫管理 app 用)。純函式、不依賴 Electron,單元測試可以直接載入。
 * 網址只帶節點 ID;是否接回由主控台一定先跳確認、使用者同意後才做。不開任何本機 HTTP 端點。
 */
import type { Backend, OpenOldSessionInput } from '../shared/types';

export const WAKE_PROTOCOL = 'entropy-nexus';

export type WakeParse = { ok: true; node: string } | { ok: false; reason: string };

/** 節點 id 只接受英數字、底線、連字號(主控台自己產生的 id 都符合),長度 1 到 64。 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 解析並驗證一個喚醒網址。 */
export function parseWakeUrl(raw: string): WakeParse {
  let u: URL;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, reason: '網址格式不正確' }; }
  if (u.protocol !== `${WAKE_PROTOCOL}:`) return { ok: false, reason: '不是主控台的網址' };
  // entropy-nexus://wake?... 的 host 是 wake;容許結尾斜線
  if (u.hostname.toLowerCase() !== 'wake' || !/^\/*$/.test(u.pathname)) return { ok: false, reason: '不支援這個動作' };
  const nodes = u.searchParams.getAll('node');
  if (nodes.length !== 1 || !ID_RE.test(nodes[0])) return { ok: false, reason: '節點 ID 不正確' };
  return { ok: true, node: nodes[0] };
}

/** 已終止節點的資料(主控台資料庫裡的那一筆)。 */
export interface RemovedNode { id: string; name: string; backend: Backend; sessionId: string | null; cwd: string; character: string; model: string }

/**
 * 可不可以接回:主控台資料庫的已終止節點清單裡找得到(不在面板上)、有 sessionId、工作目錄還在。
 * 統計檔的「可接回」與喚醒網址(wakeTargetOf)用同一個判斷,寶庫顯示喚醒按鈕的節點,喚醒時一定接得回。
 * 只存在於封存檔的節點(資料庫沒有這一筆)不算:接回會變成新的節點 ID。
 */
export function canResume(node: { sessionId: string | null; cwd: string }, inRemovedList: boolean, dirExists: (p: string) => boolean): boolean {
  return inRemovedList && !!node.sessionId && !!node.cwd && dirExists(node.cwd);
}

export type WakeTarget =
  | { kind: 'board'; name: string }
  | { kind: 'removed'; name: string; input: OpenOldSessionInput }
  | { kind: 'unavailable'; name: string; reason: string }
  | null;

/** 喚醒網址的對象:在面板上、可以接回、找得到但接不回(附原因)、或找不到(null)。 */
export function wakeTargetOf(id: string, live: ReadonlyArray<{ id: string; name: string; parentId: string | null }>, removed: readonly RemovedNode[], dirExists: (p: string) => boolean): WakeTarget {
  const on = live.find(a => a.id === id && !a.parentId);
  if (on) return { kind: 'board', name: on.name };
  const a = removed.find(x => x.id === id);
  if (!a) return null;
  if (!canResume(a, true, dirExists)) return { kind: 'unavailable', name: a.name, reason: !a.sessionId ? '沒有可以接回的對話' : '原本的工作目錄已經不存在' };
  return { kind: 'removed', name: a.name, input: { backend: a.backend, sessionId: a.sessionId!, cwd: a.cwd, agentId: a.id, name: a.name, character: a.character, model: a.model } };
}

/** 從命令列參數(Windows 第二個執行個體)找出喚醒網址;沒有就是 null。 */
export function findWakeUrl(argv: string[]): string | null {
  return argv.find(a => typeof a === 'string' && a.toLowerCase().startsWith(`${WAKE_PROTOCOL}://`)) ?? null;
}
