/**
 * 語音播報的規則摘要(Phase 2a)。純函式、不做 I/O:主行程用它算摘要,回測腳本也直接載入。
 *
 * 做法:
 * 1. 清理:拿掉程式碼區塊、表格、堆疊、網址、超長識別符;路徑只留檔名;Markdown 連結只留文字。
 * 2. 很短的回覆(清理後不超過 MAX_UNITS)直接念全文,只拿掉客套的收尾。
 * 3. 長回覆從「第一段第一句」與「最後兩段的每一句」挑:要使用者決定的事 > 還沒解決的問題 > 已完成的成果 > 開頭總結 > 末段第一句。
 *    取 1 到 2 句,合計不超過 MAX_UNITS;最高分的句子太長就換下一句合格的;都不合格回傳 null(畫面改念固定的完成通知)。
 * 4. 最後一則沒有實質內容(太短或只是「都改好了」)時,改用同一回合的倒數第二則;最多看兩則,不把整個回合拼起來。
 *
 * 長度用「朗讀單位」計算:中日文一個字算 1,英文一個單字算 2,數字一組算 1。
 */

export const MAX_UNITS = 65;
const TARGET_MIN = 30;
// 會議訂的是 10,但「已修好登入頁的錯誤」只有 9 單位也是完整的資訊;低於 5 才算沒有內容
const MIN_UNITS = 5;

/** 估算念出來的長度。 */
export function speechUnits(text: string): number {
  const han = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Bopomofo}]/gu)?.length ?? 0;
  const words = text.match(/[A-Za-z]+(?:['’.-][A-Za-z]+)*/g)?.length ?? 0;
  const nums = text.match(/\d+(?:[.,:]\d+)*%?/g)?.length ?? 0;
  return han + words * 2 + nums;
}

const basename = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;

/** 一段文字裡的路徑換成檔名(不念出完整路徑)。 */
function stripPaths(s: string): string {
  return s
    // Windows 絕對路徑(含空白的通常有引號或反引號包住,前面已處理;這裡處理沒有空白的)
    .replace(/(?:[A-Za-z]:|\\\\[\w.$-]+)[\\/][^\s,,。;;:：)）\]」』"'`]*/g, m => basename(m))
    // 有兩層以上目錄的相對或 Unix 路徑
    .replace(/(?:~|\.{1,2})?(?:\/?[\w@.+-]+\/){2,}[\w@.+-]*/g, m => basename(m) || m)
    .replace(/(?:[\w@.+-]+\\){2,}[\w@.+-]*/g, m => basename(m) || m);
}

/** 行內的清理:連結、網址、行內程式碼、路徑、超長識別符、Markdown 標記。 */
function cleanInline(s: string): string {
  let t = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<?https?:\/\/[^\s)>]+>?/g, '')
    .replace(/`([^`]+)`/g, (_m, code: string) => (/[\\/]/.test(code) ? basename(code.trim()) : code));
  t = stripPaths(t)
    // 括號裡的補充說明太長就不念(規格、數字細節之類)
    .replace(/[（(]([^（）()]*)[）)]/g, (m, inner: string) => (speechUnits(inner) > 8 ? '' : m))
    .replace(/[A-Za-z0-9_\-]{25,}/g, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$)/g, '$1$2')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return t;
}

interface Para { lines: string[] }

/** 拆成段落;拿掉程式碼區塊、表格與堆疊。冒號帶出的清單收成一句「……,共 N 項」。 */
function paragraphs(text: string): Para[] {
  const src = text.replace(/\r\n?/g, '\n')
    .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, '$1')
    .split('\n');
  const out: Para[] = [];
  let cur: string[] = [];
  const flush = () => { if (cur.length) out.push({ lines: cur }); cur = []; };
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (/^\|.*\|$/.test(line) || /^\|?\s*:?-{3,}/.test(line)) continue; // 表格
    if (/^(at\s.+\(.+\)|at\s[\w.$<>]+(\s|$)|File ".+", line \d+|Traceback \(most recent call last\)|\w+(Error|Exception):\s)/.test(line)) continue; // 堆疊
    if (/^\s{4,}\S/.test(raw) && !/^\s*([-*+]|\d+[.)])\s/.test(raw)) continue; // 縮排的程式碼
    const item = /^([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const text = cleanInline((item?.[2] ?? heading?.[1] ?? line).replace(/^>\s?/, ''));
    if (!text) continue;
    // 冒號結尾、後面接清單:收成一句,清單本身不念
    if (/[:：]$/.test(text) && /^\s*([-*+]|\d+[.)])\s+/.test(src[i + 1] ?? '')) {
      let n = 0;
      while (/^\s*([-*+]|\d+[.)])\s+/.test(src[i + 1] ?? '') || (n > 0 && /^\s{2,}\S/.test(src[i + 1] ?? ''))) { if (/^\s*([-*+]|\d+[.)])\s+/.test(src[i + 1])) n++; i++; }
      cur.push(`${text.replace(/[:：]$/, '')},共 ${n} 項。`);
      continue;
    }
    cur.push(item || heading || /[:：]$/.test(text) ? `${text.replace(/[。.!！?？:：]?$/, '')}。` : text);
  }
  flush();
  return out;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh-TW', { granularity: 'sentence' }) : null;

function sentences(p: Para): string[] {
  const text = p.lines.join(p.lines.every(l => /[。.!！?？;;]$/.test(l)) ? '' : '。').replace(/。。+/g, '。');
  const parts = segmenter ? [...segmenter.segment(text)].map(x => x.segment) : text.split(/(?<=[。！？!?])/);
  return parts.map(s => s.trim()).filter(s => speechUnits(s) > 0);
}

const DECISION = /(請(你)?(選擇|確認|決定|回覆|告訴我|提供)|需要你(的)?(確認|決定|選擇|提供|同意|授權)|要用哪|要選哪|選哪一|哪一(個|種|條|版)比較|要不要我(先)?.{0,12}[?？]$|你(想|要)(用|選)哪|please (choose|confirm|decide|pick|let me know which)|which (one|option|approach) (do|would) you|do you want me to|should i\b)/i;
const BLOCKER = /(仍(然)?(失敗|有錯|無法|不行)|還是(失敗|不行|無法|有錯)|無法(繼續|完成|執行|啟動|連線|找到)|卡住|失敗了|沒有通過|未通過|找不到|出錯|報錯|(有|發生|出現|還有|仍有)(錯誤|問題)|錯誤(出在|來自|原因)|中斷了|blocked|still (fail|broken|erroring)|cannot|can't|unable|failed|failing|errors? (occurred|remain|persist)|an error)/i;
const RESULT = /(已(經)?(完成|修正|修好|新增|加入|加上|更新|移除|刪除|建立|通過|合併|推送|推上|改好|改成|處理|解決|實作|上傳|打包|建置|commit)|完成了|改好了|修好了|測試(都|全部)?(已)?通過|全部通過|成功|done\b|fixed|added|updated|removed|implemented|created|merged|pushed|completed|resolved|tests? (all )?pass(ed)?|succeeded)/i;
const SUCCESS_AFTER_FAIL = /(已|現在|修正後|之後|now|after).{0,20}(通過|正常|修好|成功|pass|work)/i;
const COURTESY = /((需要|想要|要)的話|需要我.{0,30}的話|說一聲(即可|就好|就行)|如果(你)?(需要|想|要|有興趣)|如有需要|若有需要|有任何問題|有問題(再|隨時)|隨時(告訴|跟)我|let me know|feel free|hope this helps|happy to help|if you('d)? (like|want|need))/i;
const OFFER = /(我可以|我再|我來|我會再|再幫你|幫你(再)?|I can|I could|I'll)/i;
const LOW_SIGNAL = /^(都|已|全部|以上)?(改好|完成|處理好|弄好|好|做好)了?[。.!！]*$|^(done|ok|okay|all set|finished)[.!]*$/i;

function isCourtesy(s: string): boolean {
  if (DECISION.test(s) && !COURTESY.test(s)) return false;
  return COURTESY.test(s) && (OFFER.test(s) || speechUnits(s) < 25) || /^(謝謝|不客氣|希望(這)?(對你)?有幫助)/.test(s);
}

function score(s: string, role: 'lead' | 'tailHead' | 'tail'): number {
  if (DECISION.test(s)) return 50;
  const fail = BLOCKER.test(s), ok = RESULT.test(s);
  if (fail && (SUCCESS_AFTER_FAIL.test(s) || ok)) return 30; // 「原本失敗,修正後已通過」整句算成果
  if (fail) return 40;
  if (ok) return 30;
  if (role === 'lead') return 20;
  if (role === 'tailHead') return 10;
  return 0;
}

/** 單則訊息的摘要;沒有可念的內容回傳 ''(交給呼叫端決定要不要回看前一則)。 */
function summarizeOne(text: string): { text: string; units: number; lowSignal: boolean } {
  const paras = paragraphs(text)
    .map(p => ({ p, ss: sentences(p).filter(s => !isCourtesy(s)) }))
    .filter(x => x.ss.length);
  if (!paras.length) return { text: '', units: 0, lowSignal: true };
  const whole = paras.map(x => x.ss.join('')).join('');
  const units = speechUnits(whole);
  const lowSignal = units < MIN_UNITS || LOW_SIGNAL.test(whole.trim());
  if (units <= MAX_UNITS) return { text: whole, units, lowSignal };
  // 候選:第一段第一句、最後兩段的每一句(記住原本的順序)
  const pool: Array<{ s: string; order: number; score: number }> = [];
  const add = (s: string, order: number, role: 'lead' | 'tailHead' | 'tail') => {
    if (pool.some(c => c.s === s)) return;
    pool.push({ s, order, score: score(s, role) });
  };
  add(paras[0].ss[0], 0, 'lead');
  const tail = paras.slice(-2);
  tail.forEach((x, pi) => x.ss.forEach((s, si) => add(s, 1000 * (paras.length - tail.length + pi) + si + 1, pi === tail.length - 1 && si === 0 ? 'tailHead' : 'tail')));
  // 同分時取後面的句子:回覆的後段通常才是最終狀態
  const ranked = [...pool].sort((a, b) => b.score - a.score || b.order - a.order);
  const fit = ranked.filter(c => speechUnits(c.s) <= MAX_UNITS);
  if (!fit.length) return { text: '', units: 0, lowSignal: false };
  const first = fit[0];
  const picked = [first];
  if (speechUnits(first.s) < TARGET_MIN) {
    const second = fit.find(c => c !== first && c.score > 0 && speechUnits(first.s) + speechUnits(c.s) <= MAX_UNITS);
    if (second) picked.push(second);
  }
  const out = picked.sort((a, b) => a.order - b.order).map(c => c.s).join('');
  return { text: out, units: speechUnits(out), lowSignal: false };
}

/**
 * messages:同一回合 agent 的文字訊息(依時間先後;只會用到最後兩則)。
 * 回傳要念的摘要;找不到適合的句子回傳 null。
 */
export function summarizeForSpeech(messages: string[]): string | null {
  const list = messages.filter(m => typeof m === 'string' && m.trim());
  if (!list.length) return null;
  const last = summarizeOne(list[list.length - 1]);
  if (last.text && !last.lowSignal) return last.text;
  if (list.length >= 2) {
    const prev = summarizeOne(list[list.length - 2]);
    if (prev.text && !prev.lowSignal) return prev.text;
  }
  return null;
}
