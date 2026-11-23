import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { maskSecrets, safeName, writeMemory, type MetaValue, type WriteResult } from './memory-write.ts';

/**
 * 會議紀錄寫進記憶庫(規格見 docs/記憶設計討論.md「第五輪:會議紀錄寫進記憶庫」)。
 *
 * - 路徑:meetings/<專案名稱>/<YYYY-MM-DD>-<遮罩後的主題>.md;沒有專案是「未分類專案」;同名加 -2、-3,不覆蓋舊檔。
 *   檔名與資料夾名稱另外去掉 [ ] # ^ |(免得弄壞 [[...]] 連結);資料夾名稱開頭的 _ 與 .(寶庫不掃描那種資料夾)也去掉。
 * - 檔頭欄位、正文結構(## 結論、## 第 N 輪、### 名稱 · 節點ID,內容逐行加「> 」)照規格。
 * - 本機絕對路徑只在可見文字(主題、名稱、摘要、結語、發言)換成「[本機路徑已隱藏]」;專案ID 是內部分組用,不遮。
 *   金鑰由 writeMemory 遮罩;檔名用的主題這裡也先遮一次金鑰,免得金鑰跑進檔名。
 *
 * 取捨:
 * - round 為 0 的主控台說明(略過、失敗等):保留,寫成一般發言(名稱沒給就是「主控台」,沒有節點ID 就是「-」)。
 *   放哪一輪:有 inRound(實際發生在第幾輪)就放那一輪、輪數也算進去;沒有就依原本的順序放在「最近一個 round>0」的那一輪底下,
 *   若出現在第一個正式發言之前,歸到第一個有發言的輪。不另開「第 0 輪」。
 * - 摘要:沒有結語時寫成空字串(不省略欄位),和規格「沒有結語時留空」一致,檔頭欄位形狀固定。
 * - 輪數:所有發言中最大的 round(含 round 0 說明的 inRound)。
 * - YAML:檔頭所有字串值(含清單內)一律用雙引號(writeMemory 的 quoteStrings),反斜線與雙引號跳脫、換行單行化;
 *   名稱與主題照原樣寫入(只先遮罩本機路徑),不做全形替換,讀回(parseFrontMatter)的值與原值相同。
 *
 * 本機路徑遮罩(maskLocalPaths):
 * - 起點(前綴):磁碟代號加一個以上的反斜線或斜線(含 JSON 跳脫的 C:\\Users)、file://、UNC(兩個以上反斜線開頭)、
 *   /Users/ 與 /home/、Git Bash / MSYS / WSL 的 /c/、/mnt/c/(單字母磁碟目錄開頭)。以 / 開頭的前綴,前面不能是英數字、
 *   . ~ / 反斜線 -(所以相對路徑與網址內的路徑不動),但可以接在冒號後(PATH=/usr/bin:/home/bob/bin、scp host:/home/bob/x)。
 * - 之後逐段往後掃(手寫掃描,線性時間、沒有回溯,不會 ReDoS):段落以反斜線或斜線分隔(連續的分隔符一起吃);
 *   不是最後一段的段落可以含 ' , ; ( ) （ ，等符號(O'Brien、a,b);第一段與 Users/home 之後的那一段(使用者名稱)
 *   可含空白、最多再接 3 個詞、詞可以是中文(「王 小明」);其他段落空白後的詞限 ASCII(my project、Program Files (x86))。
 *   詞之間的空白含全形空白(U+3000)。最後一段不含空白,遇到空白、引號、: < > | * ? 與中日文標點結束,並在第一個 ' , ; （ 處截斷
 *   (句尾逗號不吞後面的字);但最後一段若正好是 Users/home 底下的帳號段,套用帳號段的寬鬆規則(可含空白、撇號,尾端標點還給原文)。
 * - 另認 UNC(\\伺服器\分享 至少兩段,以及 \\?\、\\.\、\\wsl$\ 單段前綴,後面可接磁碟代號)、//server/share、網址編碼的 %5C %2F 分隔符。
 *   giveBack 括號只數一次,線性時間。
 * - 結尾的「.」與沒有對應左括號的「)」會還給原文(句尾標點)。
 * - 取捨:寧可多遮也不漏遮使用者名稱。「C:\Users\bob open src/a.ts」這種路徑後接空白再接斜線的句子會多遮一些;
 *   路徑後緊接中文字、沒有空白時,中文字會被當成檔名的一部分一起遮掉(逗號除外)。
 */

export interface MeetingParticipant { id: string; name: string }
export interface MeetingTranscriptEntry {
  round: number;
  name: string;
  nodeId?: string | null;
  text: string;
  /** round 為 0 的說明實際發生在第幾輪;有的話說明放在那一輪。 */
  inRound?: number;
}
export type MeetingEndReason = '完成' | '中止' | '逾時';

export interface MeetingRecordInput {
  id: string;
  topic: string;
  hostId: string;
  hostName: string;
  participants: MeetingParticipant[];
  projectId?: string;
  projectName?: string;
  startedAt: number;
  endedAt: number;
  endReason: MeetingEndReason;
  conclusion?: string;
  transcript: MeetingTranscriptEntry[];
}

export interface MeetingRecord {
  meta: Record<string, MetaValue>;
  body: string;
  /** 相對記憶庫的資料夾,例如 meetings/star-app。 */
  dir: string;
  /** 不含序號與副檔名的檔名,例如 2026-11-22-主題。 */
  baseName: string;
}

const PATH_MASK = '[本機路徑已隱藏]';
const NO_PROJECT = '未分類專案';

// ---- 本機路徑遮罩 ----
const SEPS = '(?:[\\\\/]|%5[Cc]|%2[Ff])';
const PREFIX = new RegExp([
  `file:\\/\\/+(?:[A-Za-z]:${SEPS}+)?`,
  `(?<![A-Za-z0-9])[A-Za-z]:${SEPS}+`,
  // UNC:\\伺服器\分享 至少兩段(\\?\、\\.\、\\wsl$\ 的單段前綴也算,後面可直接接磁碟代號)
  '(?<![\\\\\\w])\\\\\\\\+[\\w.$?-]+[\\\\/]+(?:[A-Za-z]:[\\\\/]+)?(?=[^\\s\\\\/])',
  // 斜線 UNC://伺服器/分享(前面不能是冒號,免得吃到 https://)
  '(?<![\\w.~/\\\\:-])//[\\w.$-]+/+(?=[^\\s/])',
  '(?<![\\w.~/\\\\-])/(?:Users|home)/+',
  // 其他常見的 Unix 絕對路徑:暫存與安裝位置、root 的家目錄、macOS 的外接磁碟與 /private(/private/var/folders/… 是使用者暫存)。
  // 後面一定要接內容。/etc、/usr 是公開的系統路徑(常在說明裡提到 /etc/hosts、/usr/bin),不含使用者資料,不遮,免得誤遮
  '(?<![\\w.~/\\\\-])/(?:tmp|opt|var|root|srv|Volumes|private)/+(?=[^\\s/])',
  '(?<![\\w.~/\\\\-])/(?:mnt/)?[A-Za-z]/+(?=[^\\s/])',
].join('|'), 'gi');
const STOP = /[\s\\/:*?"<>|`。！？「」『』）、]/;
const PUNCT = "',;（，；";
const USER_PARENTS = new Set(['users', 'home', 'documents and settings']);
/** 分隔符的長度:\ 與 / 是 1,網址編碼的 %5C %2F 是 3,不是分隔符是 0。 */
function sepLen(t: string, i: number): number {
  const c = t[i];
  if (c === '\\' || c === '/') return 1;
  if (c === '%' && /^%(?:5[Cc]|2[Ff])/.test(t.slice(i, i + 3))) return 3;
  return 0;
}
/** 詞之間的空白:半形空白與全形空白(U+3000)。 */
const isGap = (c: string | undefined) => c === ' ' || c === '　';

/** 從 i 起的一個詞(不含空白與停止字元);asciiOnly 時遇到非 ASCII 就結束。 */
function wordEnd(t: string, i: number, asciiOnly: boolean): number {
  let j = i;
  while (j < t.length && !STOP.test(t[j]) && !sepLen(t, j) && !(asciiOnly && t.charCodeAt(j) > 0x7f)) j++;
  return j;
}

/**
 * 前綴之後的路徑本體結束在哪(回傳結束位置)。線性掃描:每個位置最多被讀常數次。
 * account0:前綴本身就是 /Users/ 或 /home/,所以第一段是帳號段。
 */
function scanPath(t: string, start: number, account0: boolean): number {
  let pos = start;
  let free = true;
  let account = account0;
  for (;;) {
    const j = wordEnd(t, pos, false);
    // 找最短的、以分隔符結尾的段落(空白後最多再接 3 個詞)
    let k = j, words = 0, sepAt = -1;
    for (;;) {
      if (sepLen(t, k)) { sepAt = k; break; }
      if (words >= 3 || !isGap(t[k])) break;
      const e = wordEnd(t, k + 1, !free);
      if (e === k + 1) break;
      k = e; words++;
    }
    if (sepAt < 0) {
      if (account) {
        // 帳號段正好是最後一段:一樣可含空白、撇號;尾端的標點還給原文
        let e = j;
        let kk = j;
        for (let w = 0; w < 3 && isGap(t[kk]) && !',;，；'.includes(t[kk - 1]); w++) {
          const we = wordEnd(t, kk + 1, false);
          if (we === kk + 1) break;
          kk = we; e = we;
        }
        while (e > pos && PUNCT.includes(t[e - 1])) e--;
        return e;
      }
      let e = pos;
      while (e < j && !PUNCT.includes(t[e])) e++;
      return e;
    }
    account = free = USER_PARENTS.has(t.slice(pos, sepAt).trim().toLowerCase());
    pos = sepAt;
    for (let n = sepLen(t, pos); n; n = sepLen(t, pos)) pos += n;
  }
}

/** 把句尾標點(「.」與沒有左括號配對的「)」)還給原文。括號只數一次,回退時遞減(線性時間)。 */
function giveBack(m: string): { keep: string; rest: string } {
  let open = 0, close = 0;
  for (let i = 0; i < m.length; i++) { if (m[i] === '(') open++; else if (m[i] === ')') close++; }
  let end = m.length;
  while (end > 0) {
    const last = m[end - 1];
    if (last === '.') end--;
    else if (last === ')' && close > open) { close--; end--; }
    else break;
  }
  return { keep: m.slice(0, end), rest: m.slice(end) };
}

/** 本機絕對路徑整段換成「[本機路徑已隱藏]」,回傳遮罩後的文字與處數。 */
export function maskLocalPaths(text: string): { text: string; masked: number } {
  const src = String(text ?? '');
  let out = '';
  let last = 0;
  let masked = 0;
  PREFIX.lastIndex = 0;
  for (let m = PREFIX.exec(src); m; m = PREFIX.exec(src)) {
    const pre = m.index + m[0].length;
    const end = scanPath(src, pre, /^\/(?:users|home)\/+$/i.test(m[0]));
    const { keep, rest } = giveBack(src.slice(m.index, end));
    if (!keep) { PREFIX.lastIndex = pre; continue; }
    out += src.slice(last, m.index) + PATH_MASK + rest;
    last = end;
    masked++;
    PREFIX.lastIndex = Math.max(end, pre);
  }
  return { text: out + src.slice(last), masked };
}

// ---- 組檔 ----
const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 可見文字:先遮本機路徑。 */
const visible = (s: string) => maskLocalPaths(s).text;

/** 檔名用:safeName 之外再去掉 [ ] # ^ |(免得弄壞 [[...]] 連結)。 */
export const fileName = (s: string) => safeName(String(s ?? '').replace(/[[\]#^|]/g, ''));
/** 資料夾名稱用:再去掉開頭的 _ 與 .(那種資料夾記憶庫不掃描)。 */
export const folderName = (s: string) => fileName(s).replace(/^[_.\s]+/, '') || '未命名';

/** 每行加「> 」,空行寫成「>」,前後的空行去掉。 */
function quoteBlock(text: string): string {
  const lines = visible(text).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (!lines.length) return '>';
  return lines.map(l => (l ? `> ${l}` : '>')).join('\n');
}

const iso = (ms: number) => new Date(ms).toISOString();
const pad = (n: number) => String(n).padStart(2, '0');
function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 結語第一個非空段落:遮罩後單行化,超過 200 字截斷。 */
function summaryOf(conclusion: string): string {
  const para = visible(conclusion).split(/\n\s*\n/).map(oneLine).find(Boolean) || '';
  const s = maskSecrets(para).text;
  const chars = Array.from(s);
  return chars.length > 200 ? chars.slice(0, 200).join('') + '…' : s;
}

/** 這則發言算在第幾輪:正式發言用自己的 round;round 0 的說明有 inRound 就用它,沒有回傳 0。 */
const roundOf = (e: MeetingTranscriptEntry): number => (e.round > 0 ? e.round : e.inRound && e.inRound > 0 ? e.inRound : 0);

/** 純函式:把一場會議組成檔頭、正文與路徑。 */
export function buildMeetingRecord(input: MeetingRecordInput): MeetingRecord {
  const topic = oneLine(visible(input.topic)) || '未命名會議';
  const entries = input.transcript.filter(e => e && typeof e.text === 'string');
  const rounds = entries.map(roundOf).filter(r => r > 0);
  const roundCount = rounds.length ? Math.max(...rounds) : 0;
  const conclusion = (input.conclusion ?? '').trim();
  // 參與節點ID / 參與者不含主持人(主持人只寫在 節點ID / 主持人,記憶設計討論第五輪);同一個節點重複列出時只留第一次
  const parts = (input.participants || []).filter((p, i, all) => p && p.id !== input.hostId && all.findIndex(q => q && q.id === p.id) === i);
  const nameOf = (s: string) => oneLine(visible(s));

  const meta: Record<string, MetaValue> = {
    種類: '會議紀錄',
    主題: topic,
    輪數: roundCount,
    開始: iso(input.startedAt),
    結束: iso(input.endedAt),
    更新時間: iso(input.endedAt),
    節點ID: input.hostId,
    主持人: nameOf(input.hostName) || input.hostId,
    參與節點ID: parts.map(p => p.id),
    參與者: parts.map(p => nameOf(p.name) || p.id),
    範圍: input.projectId ? '專案' : '全域',
    專案ID: input.projectId || undefined,
    專案: input.projectId ? nameOf(input.projectName || '') || undefined : undefined,
    摘要: conclusion ? summaryOf(conclusion) : '',
    結束原因: input.endReason,
    狀態: '未確認',
  };

  const out: string[] = [];
  if (conclusion) out.push('## 結論', '', quoteBlock(conclusion), '');
  let current: number | null = null;
  const firstRound = rounds.length ? roundOf(entries.find(e => roundOf(e) > 0)!) : 0;
  for (const e of entries) {
    // 有輪次(正式發言,或帶 inRound 的說明)就用它;否則歸在最近的正式輪底下,還沒有正式輪時歸到第一個有發言的輪
    const round: number = roundOf(e) || (current ?? firstRound);
    if (round !== current) { out.push(`## 第 ${round} 輪`, ''); current = round; }
    const name = nameOf(e.name) || '主控台';
    const id = oneLine(e.nodeId || '') || '-';
    out.push(`### ${name} · ${id}`, '', quoteBlock(e.text), '');
  }

  const projectLabel = input.projectId ? (input.projectName || input.projectId) : NO_PROJECT;
  return {
    meta,
    body: out.join('\n').trim() + '\n',
    dir: `meetings/${folderName(input.projectId ? maskSecrets(visible(projectLabel)).text : NO_PROJECT)}`,
    baseName: `${localDate(input.endedAt)}-${fileName(maskSecrets(topic).text)}`,
  };
}

/** 寫入記憶庫;沒有任何 round>0 的發言(會議沒有真的進行)時不寫,回傳 null。同名檔已存在就加序號。 */
export function writeMeetingRecord(vaultDir: string, input: MeetingRecordInput): (WriteResult & { path: string }) | null {
  if (!input.transcript.some(e => e && e.round > 0 && String(e.text ?? '').trim())) return null;
  const rec = buildMeetingRecord(input);
  let rel = `${rec.dir}/${rec.baseName}.md`;
  for (let n = 2; existsSync(join(vaultDir, ...rel.split('/'))); n++) rel = `${rec.dir}/${rec.baseName}-${n}.md`;
  const res = writeMemory(vaultDir, rel, rec.meta, rec.body, 'replace', new Date(input.endedAt), { quoteStrings: true });
  return { ...res, path: res.path };
}

/** interop 的會議在散會時的樣子(只取寫紀錄需要的欄位)。 */
export interface LiveMeeting {
  id: string;
  topic: string;
  callerId: string;
  callerName: string;
  /** 參與者,不含主持人。 */
  participants: MeetingParticipant[];
  project?: { id: string; name: string };
  createdAt: number;
  /** round 為 0 的是主控台的說明(略過、失敗、散會),可帶 inRound(實際發生在第幾輪);主持人的發言名稱是「名稱(主持人)」、nodeId 是主持人的 id。 */
  transcript: Array<{ round: number; name: string; text: string; nodeId: string | null; inRound?: number }>;
  /** 主持人用 meeting_say 結束會議時附帶的結語;沒有就是空字串。 */
  conclusion: string;
  status: 'running' | 'done' | 'failed';
  /** 主持人太久沒發言而自動散會。 */
  timedOut?: boolean;
}

/** 散會時主控台自己補的說明,和檔頭的結束原因重複,不寫進逐字紀錄。 */
const END_NOTES = new Set(['主持人結束了會議。']);

/** 主持人名稱的「(主持人)」後綴。 */
const HOST_SUFFIX = /\s*[(（]主持人[)）]\s*$/;

/**
 * interop 的會議轉成會議紀錄的輸入:
 * - 結論就是主持人結束時的結語,所以「最後一則」內容等於結語的主持人發言不再重複列在逐字紀錄裡;
 * - 「主持人結束了會議」這類散會說明略過(結束原因已經寫在檔頭);
 * - round 0 的說明(略過、沒完成發言)改成 name「主控台」、nodeId null,內容前面加上原本的名稱,避免被當成該參與者的發言;
 * - 主持人發言的標題名稱用純名稱(去掉「(主持人)」),靠節點ID 辨識;
 * - 結束原因:中止的會議記成「中止」,主持人太久沒回應記成「逾時」,其餘是「完成」。
 */
export function meetingRecordOf(m: LiveMeeting, endedAt: number): MeetingRecordInput {
  let dropAt = -1;
  if (m.conclusion) {
    for (let i = m.transcript.length - 1; i >= 0; i--) {
      const t = m.transcript[i];
      if (t.round > 0 && t.nodeId === m.callerId && t.text === m.conclusion) { dropAt = i; break; }
    }
  }
  const transcript: MeetingTranscriptEntry[] = [];
  m.transcript.forEach((t, i) => {
    if (i === dropAt) return;
    if (t.round === 0 && t.nodeId === null && END_NOTES.has(t.text.trim())) return;
    const inRound = t.inRound && t.inRound > 0 ? { inRound: t.inRound } : {};
    if (t.round === 0) {
      const who = oneLine(t.name);
      const text = who && who !== '主控台' ? `${who}:${t.text}` : t.text;
      transcript.push({ round: 0, name: '主控台', nodeId: null, text, ...inRound });
    } else {
      transcript.push({ round: t.round, name: t.name.replace(HOST_SUFFIX, ''), nodeId: t.nodeId, text: t.text, ...inRound });
    }
  });
  return {
    id: m.id, topic: m.topic, hostId: m.callerId, hostName: m.callerName.replace(HOST_SUFFIX, ''),
    participants: m.participants.map(p => ({ id: p.id, name: p.name })),
    ...(m.project ? { projectId: m.project.id, projectName: m.project.name } : {}),
    startedAt: m.createdAt, endedAt,
    endReason: m.timedOut ? '逾時' : m.status === 'failed' ? '中止' : '完成',
    ...(m.conclusion ? { conclusion: m.conclusion } : {}),
    transcript,
  };
}
