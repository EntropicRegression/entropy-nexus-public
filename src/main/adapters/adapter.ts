import { basename } from 'node:path';
import type { AdapterEvent, ApprovalDecision, Backend, Capability, ExternalSession, PermissionMode } from '../../shared/types';

export interface StartOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  /** 空字串表示使用 CLI 的預設模型。 */
  model: string;
  /** 有值表示續接既有的 session。 */
  sessionId: string | null;
  /**
   * 分支來源:有值時從這個 session 分支出新的 session(此時 sessionId 為 null),
   * 轉接器要回報新 session 的 session 事件,不能回報來源的 id。只有 Capability.fork 為 true 的後台會收到。
   */
  forkFrom: string | null;
  /** 要讓 agent 知道的身分設定(節點名稱,加上所選角色的角色卡;可能有多行、引號,最長約 8000 字);空字串表示沒有。 */
  persona: string;
  /**
   * 節點互相呼叫的工具服務(主控台提供的 MCP 伺服器);有值時轉接器要在啟動 CLI 時掛上它,
   * 並讓這個伺服器的工具不必再經 CLI 自己的授權(要不要問使用者由主控台依節點的權限模式決定)。
   * null 表示這個功能關閉,或這個節點不適用(子代理)。
   */
  interop?: { name: string; url: string; configFile: string; tools: string[]; agy: { dir: string; settings: string; server: string } | null } | null;
  /** 只有 Antigravity 用:使用者的工具白名單(agy 的 permissions.allow 規則),啟動時合併進 --settings。見 shared/agy-allow.ts。 */
  agyAllow?: string[];
}

export type Emit = (e: AdapterEvent, subId?: string) => void;

/**
 * 沒辦法內嵌的附件:在文字後面附上「附件:<絕對路徑>」,讓模型自己用工具去讀。
 * 桌面與手機畫面送出時已經把附加的檔案列在指令裡,文字裡已有的路徑就不再重複。
 */
export function withPaths(text: string, paths: string[]): string {
  const missing = paths.filter(p => !text.includes(p));
  return missing.length ? `${text}\n\n${missing.map(p => `附件:${p}`).join('\n')}` : text;
}

/** 告訴使用者哪些附件只傳了路徑;沒有就回傳 null。 */
export function pathOnlyNote(backend: string, items: Array<{ path: string; reason: string }>): AdapterEvent | null {
  if (!items.length) return null;
  return { type: 'note', text: `${backend} 沒有直接看到這些附件,只把路徑寫進了指令(需要時它會自己用工具去讀):${items.map(i => `${basename(i.path)}(${i.reason})`).join('、')}` };
}

/** 一個執行中的 CLI session。 */
export interface AdapterSession {
  /**
   * images:附件路徑(名稱沿用舊稱,不限圖片;類型用 attachmentKind 由副檔名判斷)。
   * 能內嵌的交給模型看;不能內嵌的用 withPaths 把路徑寫進文字,並以 note 事件告訴使用者,不可默默略過。
   */
  send(text: string, images?: string[]): void;
  interrupt(): void;
  respondApproval(requestId: string, decision: ApprovalDecision): void;
  answerQuestion(requestId: string, answers: Record<string, string[]> | null): void;
  /** 結束行程但保留 session,之後可用 sessionId 續接。 */
  stop(): Promise<void>;
}

/**
 * 每家 CLI 一個轉接器。對核心服務提供同一組操作,
 * 並把 CLI 的輸出翻譯成 AdapterEvent 透過 emit 送回。
 */
export interface Adapter {
  readonly backend: Backend;
  /** 啟動時探測版本與支援的功能。 */
  probe(): Promise<Capability>;
  /**
   * emit 的第二個參數 subId:事件屬於某個子代理時帶上它的識別碼(與 subagent 事件的 subId 相同),
   * 核心服務會把事件記到對應的子節點上。
   */
  start(opts: StartOptions, emit: Emit): AdapterSession;
  /** 終端機模式用:以互動方式執行原生 CLI 並接回這個 session 的指令。 */
  terminalCommand?(sessionId: string | null, model: string): { file: string; args: string[] };
  /** 列出這家 CLI 留在本機的舊 session;不支援的轉接器不必實作。 */
  listSessions?(): Promise<ExternalSession[]>;
}
