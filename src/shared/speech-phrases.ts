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
export const EN_DONE_FALLBACK = "I'm done. Please review the details on screen.";
/** 翻譯的時間上限;超過就改念固定句。 */
export const TRANSLATE_TIMEOUT_MS = 1500;

/**
 * 一則通知要念的整句。英文用節點自己的第一人稱,開頭不念節點名稱(聽聲音就知道是誰);
 * 每日預算的通知不屬於任何節點(agentName 是後台名稱,聲音借總管的),所以保留後台名稱。
 */
export function speechPhrase(n: SpeechNotice, lang: SpeechLang = 'zh'): string {
  if (lang === 'en') {
    switch (n.kind) {
      case 'done': return n.summary ? `I'm done. ${n.summary}` : EN_DONE_FALLBACK;
      case 'approval': return "I'm waiting for your approval. Please check the screen.";
      case 'question': return "I'm waiting for your answer. I have a question for you on screen.";
      case 'failed': {
        if (n.reason === 'quota') return "I'm out of usage quota, so the queued prompts are paused.";
        if (n.reason === 'budget') return `I'm letting you know that ${n.agentName} has gone over today's budget.`;
        const paused = n.queuePaused ? ', and the queued prompts are paused' : '';
        return n.reason === 'lost' ? `I'm offline. I lost my connection${paused}.` : `I'm sorry, I ran into an error${paused}.`;
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
 * 翻譯時容易被「漏掉」而翻反意思的否定與禁止詞。只擋這一類:譯文本身就帶負面意思的字(錯誤、失敗、取消、停止、跳過……)
 * 不必在原文擋,翻出來會有 error、fail、cancel、stop、skip 這類字,由 translationLooksOk 的 EN_NEGATIVE 擋下。
 * 「不」只擋會改變指示的組合(不要、不能、不可……與不通過、不成功這類結果),聊天語氣的「不對」「不錯」可以翻;「非常」不算否定。
 * 2026-11-28 依使用者要求從「單字一律擋」放寬到現在這樣。
 */
const RISKY = /不(?:要|能|可|准|得|許|许|應|应|該|该|用|必|行|會|会|通過|通过|成功|支援|完整|一致|存在|見|见|到|夠|够)|[沒没未無无別别勿禁否莫毋甭]|非(?!常)|除非|尚未|還沒|还没/;
export const riskyForTranslation = (zh: string): boolean => RISKY.test(zh);

/**
 * 譯文的極性檢查分兩類:
 * - EN_NEGATIVE_CONTENT:失敗、錯誤、取消、停止這類負面結果,出現就不念(原文是「修好錯誤」也一樣,寧可改念固定句)。
 * - EN_NEGATION:not、no、n't、wrong 這類否定。原文有「不」(已放行的「不對」「不錯」之類)時譯文要有否定,
 *   原文沒有時譯文不能有:兩邊不一致就是模型漏翻或自己加了否定。
 */
const EN_NEGATIVE_CONTENT = /\b(?:fail(?:s|ed|ure)?|errors?|cancel(?:l?ed)?|unable|stop(?:ped)?|skip(?:ped)?|block(?:ed)?|reject(?:ed)?|denied|deny|missing|lost|undo(?:ne)?|revert(?:ed)?|ignor(?:e|ed|ing)|lack(?:s|ed|ing)?|warn(?:s|ed|ing)?|abnormal|exceptions?|unless|broken|crash(?:ed|es)?|refus(?:e|ed))\b/i;
const EN_NEGATION = /\b(?:not|no|never|none|nothing|nobody|neither|nor|cannot|without|wrong)\b|n't\b/i;
/** 全形數字換成半形,數字比對才不會漏掉。 */
const halfDigits = (s: string) => s.replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0));

/** 翻譯結果像不像一句可以念的英文:不能有中文、模型的特殊記號、否定或失敗的字眼,原文的數字都要在,長度合理。 */
export function translationLooksOk(zh: string, en: string): boolean {
  const out = en.trim();
  zh = halfDigits(zh);
  if (!out || out.length > 400 || hasHan(out)) return false;
  if (/<unk>|<\/?s>|▁|�/.test(out)) return false;
  if (!/[A-Za-z]{2,}/.test(out)) return false;
  if (EN_NEGATIVE_CONTENT.test(out)) return false;
  if (/不/.test(zh) !== EN_NEGATION.test(out)) return false;
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
