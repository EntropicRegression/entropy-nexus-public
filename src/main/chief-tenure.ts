/**
 * 總管任期:誰、從什麼時候到什麼時候是總管(主控台的設定只存現任總管,換人後舊值就沒了,所以另外記)。
 * 交辦與會議紀錄在建立當下另外標記「由總管發出」;舊紀錄沒有標記時,統計檔用任期判斷(任期紀錄開始之前的資料,以現任總管判斷)。
 * 純函式,不依賴 Electron,單元測試可以直接載入。
 */
export interface ChiefTerm { id: string; name: string; from: number; to: number | null }

/** 最多保留這麼多段任期(很舊的捨去)。 */
export const CHIEF_TERMS_MAX = 200;

/** 總管換成 next(null 表示解除):現任那段結束、next 開新的一段。同一個人不變時原樣回傳。 */
export function updateChiefTerms(terms: readonly ChiefTerm[], next: { id: string; name: string } | null, now: number): ChiefTerm[] {
  const open = terms.find(t => t.to === null);
  if ((open?.id ?? null) === (next?.id ?? null)) return [...terms];
  const out = terms.map(t => (t.to === null ? { ...t, to: now } : t));
  if (next) out.push({ id: next.id, name: next.name, from: now, to: null });
  return out.slice(-CHIEF_TERMS_MAX);
}

/** 讀設定裡存的任期;格式不對的項目略過。 */
export function parseChiefTerms(raw: string | null): ChiefTerm[] {
  try {
    const list = JSON.parse(raw ?? '[]');
    if (!Array.isArray(list)) return [];
    return list.filter((t): t is ChiefTerm => !!t && typeof t.id === 'string' && typeof t.name === 'string' && Number.isFinite(t.from) && (t.to === null || Number.isFinite(t.to)));
  } catch { return []; }
}

/**
 * 這個節點在 at 這個時間是不是總管。任期紀錄涵蓋的時間(第一段開始之後)依任期判斷;
 * 更早的資料(任期紀錄開始之前)沒有依據,以現任總管判斷。
 */
export function wasChief(terms: readonly ChiefTerm[], currentChief: string | null, id: string, at: number): boolean {
  const start = terms.length ? Math.min(...terms.map(t => t.from)) : Infinity;
  if (at < start) return id === currentChief;
  return terms.some(t => t.id === id && at >= t.from && (t.to === null || at < t.to));
}
