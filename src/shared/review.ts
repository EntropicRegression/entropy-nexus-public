import type { ChangedFile, ChangeSet, ReviewComment } from './types';

/**
 * 變更檢視的行內評論與跨節點審查:行號推算與提示詞組裝。
 * 全是純函式,畫面(顯示行號)與主行程(組裝提示詞)共用,也方便直接用 node 測試。
 */

/** patch 的一行。old、new 是這一行在舊檔、新檔的行號;沒有對應(或差異沒有行號資訊)時是 null。 */
export interface PatchRow { kind: 'hunk' | 'ins' | 'rm' | 'ctx' | 'meta'; text: string; old: number | null; new: number | null }

/** 送交審查時 diff 的總長上限(字元);超過時截斷較大的檔案。 */
export const REVIEW_DIFF_LIMIT = 60_000;

/** 把一個檔案的 patch 拆成一行一行,並依 hunk 標頭(@@ -a,b +c,d @@)推算每一行的新舊行號。 */
export function patchRows(patch: string): PatchRow[] {
  const rows: PatchRow[] = [];
  let oldNo = 0, newNo = 0, known = false;
  for (const text of patch.split('\n')) {
    if (text.startsWith('@@')) {
      // 沒有行號的標頭(例如「@@ 這次編輯 @@」)之後的行都不標行號
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      known = m !== null;
      if (m) { oldNo = Number(m[1]); newNo = Number(m[2]); }
      rows.push({ kind: 'hunk', text, old: null, new: null });
    } else if (text.startsWith('+')) {
      rows.push({ kind: 'ins', text, old: null, new: known ? newNo++ : null });
    } else if (text.startsWith('-')) {
      rows.push({ kind: 'rm', text, old: known ? oldNo++ : null, new: null });
    } else if (known && text.startsWith(' ')) {
      rows.push({ kind: 'ctx', text, old: oldNo++, new: newNo++ });
    } else if (text.startsWith('\\') || text === '' || text.startsWith('… ')) {
      // 「\ No newline at end of file」、結尾的空行與截斷說明都不是檔案內容
      rows.push({ kind: 'meta', text, old: null, new: null });
    } else {
      rows.push({ kind: 'ctx', text, old: null, new: null });
    }
  }
  return rows;
}

/** 評論對應的位置;能評論的行才有(hunk 標頭與說明行沒有)。 */
export function rowAnchor(row: PatchRow): { side: 'new' | 'old' | null; line: number | null } | null {
  if (row.kind === 'hunk' || row.kind === 'meta') return null;
  if (row.kind === 'rm') return { side: row.old === null ? null : 'old', line: row.old };
  return { side: row.new === null ? null : 'new', line: row.new };
}

/** 評論位置的文字,例如「第 12 行」或「舊檔第 8 行(被刪除的行)」。 */
export function lineLabel(c: Pick<ReviewComment, 'side' | 'line'>): string {
  if (c.line === null || c.side === null) return '(這段差異沒有行號)';
  return c.side === 'old' ? `舊檔第 ${c.line} 行(被刪除的行)` : `第 ${c.line} 行`;
}

/** 包住程式碼的圍欄要比內容裡最長的連續反引號更長,內容才不會把它提早關掉。 */
function fence(body: string): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map(s => s.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** 找出評論所在的行:先用 row,與行號對不上(差異已變動)時改用行號找。 */
function findRow(rows: PatchRow[], c: ReviewComment): number {
  const match = (i: number) => {
    const a = rowAnchor(rows[i]);
    return a !== null && a.side === c.side && a.line === c.line;
  };
  if (c.row !== null && c.row >= 0 && c.row < rows.length && match(c.row)) return c.row;
  if (c.line === null) return -1;
  for (let i = 0; i < rows.length; i++) if (match(i)) return i;
  return -1;
}

/** 評論那一行與前後少量程式碼,只取同一個 hunk 裡的行;目標行前面標「>」。 */
export function commentSnippet(patch: string, c: ReviewComment, around = 2): string {
  const rows = patchRows(patch);
  const at = findRow(rows, c);
  if (at < 0) return '';
  const inHunk = (i: number) => i >= 0 && i < rows.length && rows[i].kind !== 'hunk' && rows[i].kind !== 'meta';
  let from = at, to = at;
  while (from > at - around && inHunk(from - 1)) from--;
  while (to < at + around && inHunk(to + 1)) to++;
  const lines: string[] = [];
  for (let i = from; i <= to; i++) {
    const r = rows[i];
    lines.push(`${i === at ? '>' : ' '} ${String(r.old ?? '').padStart(4)} ${String(r.new ?? '').padStart(4)} | ${r.text}`);
  }
  return lines.join('\n');
}

/** 把變更檢視的評論整理成一則給原節點的修改指令。 */
export function formatCommentsPrompt(input: { title: string; comments: ReviewComment[]; files: ChangedFile[] }): string {
  const comments = input.comments.filter(c => c.text.trim());
  const general = comments.filter(c => c.path === null);
  const inline = comments.filter(c => c.path !== null);
  const out: string[] = [
    `使用者在變更檢視裡,對你在任務「${input.title}」中做的修改留下了 ${comments.length} 則審查意見。請逐一處理,依意見修改對應的程式碼;如果你認為某則意見不該照做,請說明理由。完成後簡短列出每則意見的處理結果。`,
  ];
  if (inline.length) out.push('行號說明:「第 N 行」是修改後檔案的行號;「舊檔第 N 行(被刪除的行)」是修改前的行號,那一行現在已經不在檔案裡。程式碼片段的兩欄數字依序是舊檔與新檔的行號,標「>」的是評論所在的行,+ 是新增、- 是刪除。');
  if (general.length) {
    out.push('## 整體意見');
    for (const c of general) out.push(`- ${c.text.trim()}`);
  }
  inline.forEach((c, i) => {
    const file = input.files.find(f => f.path === c.path);
    const snippet = file ? commentSnippet(file.patch, c) : '';
    const block = [`## ${i + 1}. ${c.path} ${lineLabel(c)}`];
    if (snippet) { const f = fence(snippet); block.push(`${f}\n${snippet}\n${f}`); }
    block.push(`意見:${c.text.trim()}`);
    out.push(block.join('\n'));
  });
  return out.join('\n\n');
}

/** 一個檔案在審查提示詞裡實際放進去的 diff。cut 是 truncated 表示只放了前面一部分,omitted 表示整個省略。 */
export interface FittedPatch { path: string; text: string; cut: 'full' | 'truncated' | 'omitted'; length: number }

/**
 * 讓所有檔案的 diff 總長不超過 limit:短的檔案完整保留,剩下的額度平均分給較大的檔案,
 * 較大的檔案在行的邊界截斷;平均分到的額度太少(不到 800 字元)時,從最大的檔案開始整個省略,額度留給其他檔案。二進位檔沒有 diff。
 */
export function fitPatches(files: ChangedFile[], limit = REVIEW_DIFF_LIMIT): FittedPatch[] {
  const MIN = 800;
  const text = files.filter(f => !f.binary && f.patch);
  const pool = [...text].sort((a, b) => a.patch.length - b.patch.length);
  let cap = new Map<ChangedFile, number>();
  for (;;) {
    cap = new Map();
    let remaining = limit;
    let starved = false;
    pool.forEach((f, i) => {
      const share = Math.floor(remaining / (pool.length - i));
      const take = Math.min(f.patch.length, share);
      if (take < f.patch.length && take < MIN) starved = true;
      cap.set(f, take);
      remaining -= take;
    });
    if (!starved || !pool.length) break;
    pool.pop();
  }
  return text.map(f => {
    const n = cap.get(f) ?? 0;
    if (n >= f.patch.length) return { path: f.path, text: f.patch, cut: 'full' as const, length: f.patch.length };
    if (n < MIN) return { path: f.path, text: '', cut: 'omitted' as const, length: f.patch.length };
    const head = f.patch.slice(0, n);
    const nl = head.lastIndexOf('\n');
    return { path: f.path, text: nl > 0 ? head.slice(0, nl) : head, cut: 'truncated' as const, length: f.patch.length };
  });
}

const STATUS_LABEL = { A: '新增', M: '修改', D: '刪除' } as const;

/** 比較兩個路徑是否相同(Windows 不分大小寫與斜線方向)。 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

export interface ReviewPromptInput {
  /** 原任務的指令標題。 */
  title: string;
  /** 完成這個任務的節點。backend 是顯示用的後台名稱。 */
  author: { name: string; backend: string; model: string };
  /** 變更所在的工作目錄。 */
  changeCwd: string;
  /** 審查節點的工作目錄。 */
  reviewerCwd: string;
  set: ChangeSet;
  /** 使用者附加給審查者的說明。 */
  note?: string;
  limit?: number;
}

/** 組合送給審查節點的提示詞:原任務、完成者、變更摘要與完整 diff,並要求只審查、不要修改檔案。 */
export function formatReviewPrompt(input: ReviewPromptInput): string {
  const { set } = input;
  const added = set.files.reduce((n, f) => n + f.added, 0);
  const removed = set.files.reduce((n, f) => n + f.removed, 0);
  const fitted = fitPatches(set.files, input.limit ?? REVIEW_DIFF_LIMIT);
  const out: string[] = [
    '這是一個程式碼審查請求。請以審查者的角度審查另一個節點完成的修改。**請不要修改任何檔案,也不要執行會改動檔案的指令**,只要回覆審查意見。',
    [
      `原任務指令:${input.title}`,
      `完成者:${input.author.name}(${input.author.backend}${input.author.model ? ` · ${input.author.model}` : ''})`,
      input.changeCwd && input.reviewerCwd && !samePath(input.changeCwd, input.reviewerCwd)
        ? `變更所在路徑:${input.changeCwd}\n注意:這不是你目前的工作目錄(${input.reviewerCwd})。檔案路徑都相對於上面的變更所在路徑;需要看完整內容時請到那裡讀取,但不要修改。`
        : `變更所在路徑:${input.changeCwd || '(不明)'}(就是你目前的工作目錄)`,
    ].join('\n'),
  ];
  if (input.note?.trim()) out.push(`使用者的補充說明:${input.note.trim()}`);
  const summary = [`## 變更摘要\n共 ${set.files.length} 個檔案,新增 ${added} 行、刪除 ${removed} 行。`];
  for (const f of set.files) summary.push(`- ${STATUS_LABEL[f.status]} ${f.path}${f.binary ? '(二進位檔,只列檔名)' : ` +${f.added} −${f.removed}`}`);
  if (set.truncated) summary.push(`(檔案太多,只列出前 ${set.files.length} 個。)`);
  if (set.note) summary.push(`(${set.note})`);
  out.push(summary.join('\n'));

  const diff = ['## 完整 diff'];
  const truncated = fitted.filter(f => f.cut === 'truncated');
  const omitted = fitted.filter(f => f.cut === 'omitted');
  if (truncated.length || omitted.length) {
    diff.push(`diff 總長超過 ${input.limit ?? REVIEW_DIFF_LIMIT} 字元的上限,較大的檔案沒有完整放進來:`);
    for (const f of truncated) diff.push(`- ${f.path}:截斷,只放了前 ${f.text.length} 字元(共 ${f.length} 字元)`);
    for (const f of omitted) diff.push(`- ${f.path}:整個省略(共 ${f.length} 字元)`);
    diff.push('需要時請直接讀取這些檔案。');
  }
  for (const f of fitted) {
    if (f.cut === 'omitted') continue;
    const body = f.cut === 'truncated' ? `${f.text}\n… 以下省略` : f.text.replace(/\n+$/, '');
    const fc = fence(body);
    diff.push(`### ${f.path}\n${fc}diff\n${body}\n${fc}`);
  }
  if (!fitted.length) diff.push('(沒有可顯示的文字差異。)');
  out.push(diff.join('\n\n'));

  out.push([
    '## 請回覆',
    '1. 錯誤:邏輯錯誤、遺漏的邊界情況、型別或執行期問題。',
    '2. 風險:安全性、效能、相容性、資料遺失、缺少的測試。',
    '3. 改進建議:可讀性、結構、命名、更簡單的寫法。',
    '每一點請標明檔案與行號,依嚴重程度排序;沒有問題的部分不用逐一說明。再次提醒:只回覆審查意見,不要修改檔案。',
  ].join('\n'));
  return out.join('\n\n');
}
