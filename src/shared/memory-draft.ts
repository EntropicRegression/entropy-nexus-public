/**
 * 對話草稿(長期記憶階段 4.5,點 1):節點對話累積到一定字數,對話視窗就出現「儲存這段記憶」按鈕,
 * 請那個節點把「上次儲存之後」的對話整理成一份草稿(狀態未確認)。這裡是純函式:算累積字數、決定要不要顯示、擷取要交給節點看的片段。
 */

/** 累積多少字(使用者加節點的訊息)才出現按鈕;主控台可用環境變數 NEXUS_DRAFT_THRESHOLD 覆寫。 */
export const DRAFT_THRESHOLD = 3000;
/** 交給節點看的片段最多這麼多字(超過就取最近的部分)。 */
export const DRAFT_SEGMENT_MAX = 6000;
/** 草稿請求提示詞的開頭;假資料轉接器靠它認出這是草稿請求。 */
export const DRAFT_PROMPT_LEAD = '(主控台:記憶草稿請求。';

export interface DraftEvent { type: string; seq: number; role?: string; text?: string }
export interface DraftLine { seq: number; role: 'user' | 'agent'; text: string }

/** 主控台自己發給節點的請求(歸檔總結、判例、草稿)不算對話內容。 */
const CONSOLE_PROMPT = /^\s*(?:\(主控台|〔歸檔)/;

/** 對話裡使用者與節點說的話(依序),只取 lastSeq 之後的。 */
export function draftLines(events: DraftEvent[], lastSeq: number): DraftLine[] {
  const out: DraftLine[] = [];
  for (const e of events) {
    if (e.type !== 'message' || e.seq <= lastSeq || (e.role !== 'user' && e.role !== 'agent') || typeof e.text !== 'string' || !e.text.trim()) continue;
    if (e.role === 'user' && CONSOLE_PROMPT.test(e.text)) continue;
    out.push({ seq: e.seq, role: e.role, text: e.text });
  }
  return out;
}

/** 上次儲存之後累積的字數。 */
export function accumulatedChars(events: DraftEvent[], lastSeq: number): number {
  return draftLines(events, lastSeq).reduce((n, l) => n + l.text.length, 0);
}

/** 要不要顯示按鈕:累積字數達到門檻。 */
export function shouldOfferDraft(chars: number, threshold: number = DRAFT_THRESHOLD): boolean {
  return Number.isFinite(chars) && chars >= Math.max(1, threshold);
}

/** 整理成「使用者:…/節點:…」的文字,超過上限時保留最近的部分。回傳文字、涵蓋到的最後一筆 seq 與原始字數。 */
export function draftSegment(events: DraftEvent[], lastSeq: number, max: number = DRAFT_SEGMENT_MAX): { text: string; lastSeq: number; chars: number } {
  const lines = draftLines(events, lastSeq);
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  const parts = lines.map(l => `${l.role === 'user' ? '使用者' : '節點'}:${l.text.trim()}`);
  let text = parts.join('\n\n');
  if (text.length > max) text = `(前面較早的部分已省略)\n${text.slice(text.length - max)}`;
  return { text, lastSeq: lines.length ? lines[lines.length - 1].seq : lastSeq, chars };
}
