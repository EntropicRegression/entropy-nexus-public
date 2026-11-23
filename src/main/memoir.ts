import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { MEMOIR_PROMPT_LEAD } from '../shared/memory-draft.ts';
import { fileName, folderName, maskLocalPaths } from './meeting-record.ts';
import { maskSecrets, safeName, writeMemory, type MetaValue, type WriteResult } from './memory-write.ts';

/**
 * 回憶錄(規格見 docs/記憶設計討論.md「第六輪:回憶錄」):節點用第一人稱回顧自己的經歷,一章一個檔案。
 *
 * - 路徑:memoirs/<節點名>-<節點ID 前 8 碼>/<YYYY-MM-DD>-<標題>.md(日期是寫入當天的本機日期);同名加 -2、-3,不覆蓋舊檔。
 *   檔名與資料夾名稱沿用會議紀錄的 fileName / folderName(safeName 之外再去掉 [ ] # ^ |,資料夾開頭的 _ 與 . 也去掉),
 *   另外去掉不可見的格式字元(Unicode Cf),截斷時不切開代理對。
 * - 檔頭只有單行欄位:種類、節點ID、節點、後台、標題、涵蓋期間、範圍、更新時間、狀態;字串值一律用雙引號(writeMemory 的 quoteStrings)。
 *   節點ID、節點、後台由主控台依提交者身分填寫,節點在參數裡填的一律忽略(不能替別的節點寫)。
 * - 正文必須有「## 來源」與「## 不確定之處」兩個章節,內容不能是空的(可以寫「無」);缺了或空的就拒收,請節點補上重寫。
 * - 涵蓋期間:ISO 日期區間「YYYY-MM-DD/YYYY-MM-DD」或只寫起日;日期要合法、起日不晚於迄日。
 * - 標題與正文裡的本機絕對路徑換成「[本機路徑已隱藏]」(maskLocalPaths);金鑰由 writeMemory 遮罩,檔名用的標題這裡先遮一次。
 * - 狀態一律「未確認」;只有使用者在記憶庫管理 app 改成「已確認」後,節點才查得到(memory-tools 的 statusVisible)。
 *
 * 純函式加一個寫檔函式與刪除前的等待流程,不依賴 Electron;請求、每日上限、身分檢查在 memory-draft.ts 的 DraftService。
 */

export const MEMOIR_DIR = 'memoirs';
/** 同一個節點同一天最多寫幾份回憶錄。 */
export const MEMOIR_DAILY_CAP = 3;
export const MEMOIR_TITLE_MAX = 80;
/** 正文超過這麼多字直接拒收(截斷可能剛好切掉固定章節)。 */
export const MEMOIR_CONTENT_MAX = 12000;
/** 正文必須有的章節(順序不限)。 */
export const MEMOIR_SECTIONS = ['來源', '不確定之處'] as const;

const pad = (n: number) => String(n).padStart(2, '0');
export const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localStamp = (d: Date) => `${localDay(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).trim();

/** YYYY-MM-DD 是不是真的存在的日期(2026-02-30 不算)。 */
function validDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** 解析涵蓋期間;格式不對、日期不存在、起日晚於迄日都丟出說明。回傳寫進檔頭的文字(「起/迄」或只有起日)。 */
export function parsePeriod(raw: unknown): string {
  const t = str(raw).replace(/\s*\/\s*/g, '/');
  const help = '涵蓋期間(period)要寫 ISO 日期區間,例如 2026-11-16/2026-11-17;只有一天可以只寫起日 2026-11-16。';
  if (!t) throw new Error(`回憶錄需要 period 參數。${help}`);
  const m = /^(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(t);
  if (!m) throw new Error(`涵蓋期間「${t.slice(0, 40)}」的格式不對。${help}`);
  const [, from, to] = m;
  if (!validDay(from) || (to && !validDay(to))) throw new Error(`涵蓋期間「${t}」裡有不存在的日期。${help}`);
  if (to && from > to) throw new Error(`涵蓋期間「${t}」的起日晚於迄日。${help}`);
  return to ? `${from}/${to}` : from;
}

/** 不可見的格式字元(Unicode Cf:零寬字元、U+202E 方向覆寫、U+FEFF 等),標題與檔名一律去掉。 */
const INVISIBLE = /\p{Cf}/gu;
/** 結尾剩下的半個代理對(依 UTF-16 長度截斷時可能出現)。 */
const LONE_HIGH = /[\uD800-\uDBFF]$/;

/** 標題整理:去掉不可見字元、空白單行化,依字元(code point)截斷,不會切開代理對。 */
export function cleanTitle(s: unknown, max = MEMOIR_TITLE_MAX): string {
  return Array.from(str(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim();
}

/** 檔名用:去掉不可見字元後套 fileName;safeName 依 UTF-16 長度截斷,結尾若剩半個代理對就去掉。 */
const memoirFileName = (s: string) => fileName(s.replace(INVISIBLE, '')).replace(LONE_HIGH, '').replace(/[. ]+$/, '') || '未命名';
const memoirFolderName = (s: string) => folderName(s.replace(INVISIBLE, '')).replace(LONE_HIGH, '').replace(/[. ]+$/, '') || '未命名';

/**
 * 二級標題的名稱(不是二級標題回傳 null)。依 CommonMark 的 ATX 標題:前面可以有 0 到 3 個空白,結尾可以有一串 #;
 * 另外寬鬆接受標題名後面的冒號(半形、全形)與整個包在粗體(** 或 __)裡的寫法。
 */
function h2Name(line: string): string | null {
  const m = /^ {0,3}##(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  if (!m) return null;
  let name = (m[1] ?? '').replace(/^#+$/, '').trim();
  for (let i = 0; i < 2; i++) {
    name = name.replace(/[:：]\s*$/, '').trim();
    const b = /^(\*\*|__)(.*)\1$/.exec(name);
    if (b) name = b[2].trim();
  }
  return name;
}

/** 一級或二級標題(到這裡為止算前一個章節的內容);三級以下的標題算章節內容。 */
const isH1orH2 = (line: string) => /^ {0,3}#{1,2}(?:[ \t]|$)/.test(line);

/**
 * 檢查固定章節:missing 是缺少的章節,empty 是有標題但內容是空的章節(內容可以寫「無」,不能空白)。
 * 程式碼圍欄依 CommonMark 配對(``` 只能由至少一樣長的 ``` 關閉,~~~ 同理,前面最多 3 個空白),圍欄內的 ## 不算標題;
 * HTML 註解(<!-- … -->,可以跨行)裡的內容不算標題,也不算章節內容。同一個章節出現多次時,內容合起來算。
 */
export function checkSections(body: string): { missing: string[]; empty: string[] } {
  const content = new Map<string, string>();
  let current: string | null = null;
  let fence: { ch: string; len: number } | null = null;
  let inComment = false;
  const add = (text: string) => { if (current !== null) content.set(current, `${content.get(current) ?? ''}${text}\n`); };
  for (const raw of body.split(/\r?\n/)) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(raw);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      add(raw);
      continue;
    }
    // 去掉 HTML 註解的部分,剩下的才是可見內容
    let rest = raw, kept = '';
    while (rest) {
      if (inComment) {
        const e = rest.indexOf('-->');
        if (e < 0) rest = '';
        else { rest = rest.slice(e + 3); inComment = false; }
      } else {
        const st = rest.indexOf('<!--');
        if (st < 0) { kept += rest; rest = ''; }
        else { kept += rest.slice(0, st); rest = rest.slice(st + 4); inComment = true; }
      }
    }
    // 反引號圍欄的資訊字串不能含反引號(CommonMark),否則不算圍欄
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(kept);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { ch: open[1][0], len: open[1].length };
      add(kept);
      continue;
    }
    const name = h2Name(kept);
    if (name !== null) { current = name; if (!content.has(name)) content.set(name, ''); continue; }
    if (isH1orH2(kept)) { current = null; continue; }
    add(kept);
  }
  const missing = MEMOIR_SECTIONS.filter(s => !content.has(s));
  const empty = MEMOIR_SECTIONS.filter(s => content.has(s) && !content.get(s)!.trim());
  return { missing, empty };
}

/** 正文缺了哪些固定章節(`## 來源`、`## 不確定之處`)。 */
export function missingSections(body: string): string[] { return checkSections(body).missing; }

export interface MemoirSubmission { title: string; content: string; period: string }

/**
 * 檢查節點提交的回憶錄參數(kind 已確定是回憶錄);節點填的 節點ID、節點、後台 等身分欄位不讀,由主控台另外填。
 * 不合格就丟出說明,讓節點照著補上重寫。
 */
export function parseMemoir(args: Record<string, unknown>): MemoirSubmission {
  const title = cleanTitle(args.title ?? args.name ?? args['標題']);
  const content = str(args.content ?? args.text ?? args.body ?? args['正文']);
  if (!title || !content) throw new Error('回憶錄需要 title(這一章的標題)、period(涵蓋期間)、content(正文)三個字串參數。');
  if (content.length > MEMOIR_CONTENT_MAX) throw new Error(`回憶錄正文有 ${content.length} 字,超過上限 ${MEMOIR_CONTENT_MAX} 字。請精簡後重寫提交。`);
  const period = parsePeriod(args.period ?? args['涵蓋期間'] ?? args.covers ?? args.range);
  const { missing, empty } = checkSections(content);
  if (missing.length) throw new Error(`回憶錄的正文缺少固定章節:${missing.map(s => `「## ${s}」`).join('、')}。請補上後重寫提交(內容可以寫「無」,但章節不能缺):「## 來源」寫這一章根據什麼寫的,「## 不確定之處」寫記不清楚或推測的地方。`);
  if (empty.length) throw new Error(`回憶錄的固定章節${empty.map(s => `「## ${s}」`).join('、')}沒有內容。沒有可寫的就寫「無」,請補上後重寫提交。`);
  return { title, content, period };
}

export interface MemoirInput extends MemoirSubmission {
  /** 提交者的身分(主控台填)。 */
  nodeId: string;
  nodeName: string;
  backendLabel: string;
  now: Date;
}

export interface MemoirRecord {
  meta: Record<string, MetaValue>;
  body: string;
  dir: string;
  baseName: string;
  /** 遮掉的本機路徑處數(標題加正文)。 */
  pathsMasked: number;
}

/** 純函式:組成回憶錄的檔頭、正文與路徑。 */
export function buildMemoir(input: MemoirInput): MemoirRecord {
  const t = maskLocalPaths(input.title);
  const b = maskLocalPaths(input.content);
  const title = cleanTitle(t.text) || '未命名';
  const nodeName = input.nodeName.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim() || input.nodeId;
  const meta: Record<string, MetaValue> = {
    種類: '回憶錄',
    節點ID: input.nodeId,
    節點: nodeName,
    後台: input.backendLabel,
    標題: title,
    涵蓋期間: input.period,
    範圍: '全域',
    更新時間: localStamp(input.now),
    狀態: '未確認',
  };
  const idPart = fileName(safeName(input.nodeId)).slice(0, 8);
  return {
    meta,
    body: b.text.trim() + '\n',
    dir: `${MEMOIR_DIR}/${memoirFolderName(nodeName)}-${idPart}`,
    baseName: `${localDay(input.now)}-${memoirFileName(maskSecrets(title).text)}`,
    pathsMasked: t.masked + b.masked,
  };
}

/** 寫進記憶庫;同名檔已存在就加 -2、-3,不覆蓋。 */
export function writeMemoir(vaultDir: string, input: MemoirInput): WriteResult & { pathsMasked: number } {
  const rec = buildMemoir(input);
  let rel = `${rec.dir}/${rec.baseName}.md`;
  for (let n = 2; existsSync(join(vaultDir, ...rel.split('/'))); n++) rel = `${rec.dir}/${rec.baseName}-${n}.md`;
  const res = writeMemory(vaultDir, rel, rec.meta, rec.body, 'replace', input.now, { quoteStrings: true });
  return { ...res, pathsMasked: rec.pathsMasked };
}

/** 這段文字(佇列項目的內容、任務標題)是不是主控台的回憶錄請求。 */
export const isMemoirPrompt = (text: string): boolean => String(text ?? '').trimStart().startsWith(MEMOIR_PROMPT_LEAD);

/** 給節點的回憶錄請求。farewell:刪除節點前的最後一章。 */
export function formatMemoirPrompt(input: { nodeName: string; today: string; historyFrom?: string; historyTo?: string; farewell?: boolean }): string {
  const span = input.historyFrom ? `主控台記錄到你的對話期間大約是 ${input.historyFrom}${input.historyTo && input.historyTo !== input.historyFrom ? ` 到 ${input.historyTo}` : ''}。` : '';
  return [
    `${MEMOIR_PROMPT_LEAD}這不是使用者的新指令,請不要修改任何檔案。)`,
    input.farewell
      ? `使用者即將刪除你這個節點,刪除前想請你寫一章「回憶錄」,留作你最後的紀錄。`
      : '使用者請你寫一章「回憶錄」。',
    '回憶錄是你(節點)用第一人稱寫的經歷回顧:這段期間做了哪些事、當時怎麼想、和使用者或其他節點怎麼合作、學到了什麼、哪裡做得不好。寫完後呼叫 memory_draft 工具(nexus 伺服器)提交一次。參數:',
    '- kind:memoir(固定)',
    '- title:這一章的標題(一句話,會變成檔名)',
    '- period:這一章涵蓋的期間,ISO 日期區間,例如 2026-11-16/2026-11-17;只有一天就只寫 2026-11-16。起日不能晚於迄日',
    '- content:正文(Markdown)。一定要有兩個章節:「## 來源」(這一章根據什麼寫的:哪段對話、哪些任務、哪些記憶或檔案)與「## 不確定之處」(記不清楚、推測的地方)。沒有內容就寫「無」,但章節不能缺也不能空白,否則會被退回',
    '參數名稱一律用英文;內容用中文寫。節點ID、節點名稱、後台由主控台依你的身分自動填寫,不用填,填了也會被忽略。',
    '規則:只寫你實際經歷過的事,不要編造或美化;記不清楚、推測的部分寫進「不確定之處」;不要寫入金鑰、密碼、權杖;本機的絕對路徑會被遮掉,需要提到檔案時寫專案內的相對路徑;控制在 2000 字內;只提交一份。',
    `今天是 ${input.today};節點:${input.nodeName}。${span}`,
  ].join('\n');
}

/** 刪除節點前等回憶錄用到的狀態與動作(由 Core 提供;單元測試用假的)。 */
export interface MemoirWaitDeps {
  /** 這個節點有沒有一份等著提交的回憶錄請求。 */
  pending(): boolean;
  /** 佇列裡還沒送出的回憶錄提示的 id;沒有是 null。 */
  queuedId(): string | null;
  /** 有沒有正在進行的回憶錄回合(任務標題是回憶錄請求、還沒結束)。 */
  running(): boolean;
  /** since 之後有沒有回憶錄回合結束。 */
  endedSince(since: number): boolean;
  /** 送出新的(最後一章)回憶錄請求;舊請求掛著但已經沒有在進行時,會覆蓋舊請求。 */
  request(): Promise<unknown>;
  /** 取消回憶錄請求。 */
  cancel(): void;
  cancelQueued(queuedId: string): void;
  interrupt(): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  timeoutMs: number;
}

/**
 * 刪除節點前請它寫回憶錄,等到寫完(或這個回合結束、逾時),回傳給使用者看的一句說明。
 * - 已經有回憶錄請求在進行(使用者先按過「寫回憶錄」,提示還在佇列或節點正在寫):不重發,等那一份。
 * - 請求掛著但沒有對應的佇列項目或進行中的回合(例如上一份不合格後節點就停了):重發,覆蓋舊請求。
 * - 回合結束了卻沒有提交就取消請求;逾時就取消請求、拿掉佇列裡的提示、中斷正在寫的回合。都不擋刪除。
 */
export async function waitForMemoir(d: MemoirWaitDeps): Promise<string> {
  const t0 = d.now();
  const active = () => d.queuedId() !== null || d.running();
  const reuse = d.pending() && active();
  if (!reuse) {
    try { await d.request(); } catch (e) { return `沒有寫回憶錄:${String((e as Error)?.message ?? e)}`; }
  }
  while (d.now() - t0 < d.timeoutMs) {
    if (!active() && (!d.pending() || d.endedSince(t0))) {
      if (!d.pending()) return '已寫好回憶錄(未確認,在記憶庫管理 app 確認)。';
      d.cancel();
      return '節點沒有提交回憶錄。';
    }
    await d.sleep(250);
  }
  d.cancel();
  const q = d.queuedId();
  if (q) d.cancelQueued(q);
  if (d.running()) d.interrupt();
  return '節點沒有在時限內寫完回憶錄。';
}
