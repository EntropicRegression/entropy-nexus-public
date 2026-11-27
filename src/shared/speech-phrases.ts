/**
 * 語音播報的台詞與語言(第一階段:只有播報可以切成英文,介面與節點回覆的語言不變)。
 * 純函式,不依賴 Electron;主行程、畫面與單元測試共用。
 *
 * 英文模式下,完成通知的摘要是節點自己回覆裡挑出來的一句(通常是中文)。含中文時交給本機翻譯模型翻成英文,
 * 但翻譯可能把否定詞翻反(例如「請勿部署」翻成 deploy),所以先過 englishSummary 的防呆:
 * 有高風險的極性詞、翻譯結果不像正常英文、數字對不上、沒有翻譯模型或逾時,一律改念固定的英文句。
 */
import type { SpeechLang, SpeechNotice } from './types';

export type { SpeechLang };
export const SPEECH_LANGS: readonly SpeechLang[] = ['zh', 'en'];
export const normalizeSpeechLang = (v: unknown): SpeechLang => (v === 'en' ? 'en' : 'zh');

/** 英文模式下摘要不能用時改念的固定句。 */
export const EN_DONE_FALLBACK = 'Task complete. Review the details on screen.';
/** 翻譯的時間上限;超過就改念固定句。 */
export const TRANSLATE_TIMEOUT_MS = 1500;

/** 一則通知要念的整句。 */
export function speechPhrase(n: SpeechNotice, lang: SpeechLang = 'zh'): string {
  if (lang === 'en') {
    switch (n.kind) {
      case 'done': return `${n.agentName}: ${n.summary || EN_DONE_FALLBACK}`;
      case 'approval': return `${n.agentName} is waiting for your approval. Please check the screen.`;
      case 'question': return `${n.agentName} has a question for you. Please answer on screen.`;
      case 'failed': {
        if (n.reason === 'quota') return `${n.agentName} reached its usage limit. Queued prompts are paused.`;
        if (n.reason === 'budget') return `${n.agentName} has gone over today's budget.`;
        const paused = n.queuePaused ? ', and queued prompts are paused' : '';
        return n.reason === 'lost' ? `${n.agentName} lost its connection${paused}.` : `${n.agentName} ran into an error${paused}.`;
      }
    }
  }
  switch (n.kind) {
    case 'done': return n.summary ? `${n.agentName}:${n.summary}` : `${n.agentName} 完成了,詳情請看畫面。`;
    case 'approval': return `${n.agentName} 在等你授權,請到畫面確認。`;
    case 'question': return `${n.agentName} 有問題要問你,請到畫面回答。`;
    case 'failed': {
      const paused = n.queuePaused ? ',排隊的指令已暫停' : '';
      if (n.reason === 'quota') return `${n.agentName} 的額度到達上限,排隊的指令已暫停。`;
      if (n.reason === 'budget') return `${n.agentName} 今天的用量超過每日預算了。`;
      return n.reason === 'lost' ? `${n.agentName} 失去連線${paused}。` : `${n.agentName} 出錯了${paused}。`;
    }
  }
}

const HAN = /[\p{Script=Han}]/u;
export const hasHan = (s: string): boolean => HAN.test(s);

/**
 * 翻譯容易翻反意思的極性詞(否定、禁止、未完成、失敗、取消……)。寧可多擋:擋下只是改念固定句,翻反會念出相反的指示。
 */
const RISKY = /[不沒没未無无別别勿禁否非錯错失敗败缺漏停擋挡拒免莫毋甭卻却但]|取消|跳過|跳过|略過|略过|忽略|撤銷|撤销|回滾|回滚|還原|还原|退回|除非|異常|异常|警告|阻止|尚未|還沒|还没/;
export const riskyForTranslation = (zh: string): boolean => RISKY.test(zh);

/** 原文沒有極性詞時,譯文也不該出現否定或失敗的意思;出現就是模型自己加的,不能念。 */
const EN_NEGATIVE = /\b(?:not|no|never|none|nothing|nobody|neither|nor|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|haven't|hasn't|shouldn't|fail(?:s|ed|ure)?|errors?|cancel(?:l?ed)?|unable|without|stop(?:ped)?|skip(?:ped)?|block(?:ed)?|reject(?:ed)?|denied|deny|missing|lost|undo(?:ne)?|revert(?:ed)?)\b|n't\b/i;
/** 全形數字換成半形,數字比對才不會漏掉。 */
const halfDigits = (s: string) => s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/** 翻譯結果像不像一句可以念的英文:不能有中文、模型的特殊記號、否定或失敗的字眼,原文的數字都要在,長度合理。 */
export function translationLooksOk(zh: string, en: string): boolean {
  const out = en.trim();
  zh = halfDigits(zh);
  if (!out || out.length > 400 || hasHan(out)) return false;
  if (/<unk>|<\/?s>|▁|�/.test(out)) return false;
  if (!/[A-Za-z]{2,}/.test(out)) return false;
  if (EN_NEGATIVE.test(out)) return false;
  // 原文用中文數字寫的數量(三個、十次)無法逐一比對,直接不翻
  if (/[零〇一二兩两三四五六七八九十百千萬万億亿]+\s*[個个次項项筆笔份條条件台位]/.test(zh)) return false;
  const nums = (s: string): string[] => s.match(/\d+(?:[.,:]\d+)*/g) ?? [];
  const have = nums(out);
  for (const n of nums(zh)) if (!have.includes(n)) return false;
  // 同一個詞連續重複是翻譯模型失控的典型症狀
  if (/\b(\w+)(?:\s+\1\b){3,}/i.test(out)) return false;
  return true;
}

/**
 * 英文模式下要念的摘要:本來就是英文的照用;含中文的翻譯後通過防呆才用;其他情況回傳 null(念固定句)。
 * translate 由呼叫端提供(本機語音服務的翻譯),失敗或逾時回傳 null。
 */
export async function englishSummary(summary: string | null, translate: (zh: string) => Promise<string | null>, timeoutMs = TRANSLATE_TIMEOUT_MS): Promise<string | null> {
  const s = (summary ?? '').trim();
  if (!s) return null;
  if (!hasHan(s)) return s;
  if (riskyForTranslation(s)) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(r => { timer = setTimeout(() => r(null), timeoutMs); });
  try {
    const en = await Promise.race([translate(s).catch(() => null), late]);
    return en && translationLooksOk(s, en) ? en.trim() : null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 播報要用哪些角色的聲音(依序嘗試)。中文:節點自己的角色,沒有角色就借總管的(維持原本的行為)。
 * 英文:節點的角色 → 總管的角色;英文素材(clips/en/、voice.en.wav)只在各自的資料夾找,都沒有時畫面改用系統英文語音。
 */
export function speechCharacters(roles: { own: string | null; chief: string | null }, lang: SpeechLang): string[] {
  if (lang !== 'en') { const c = roles.own || roles.chief; return c ? [c] : []; }
  return [...new Set([roles.own, roles.chief].filter((c): c is string => !!c))];
}
