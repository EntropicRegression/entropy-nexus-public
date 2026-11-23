/**
 * 交辦時指定專案(ask_node / start_meeting 的 project 參數,專案星系第二版)。純函式,不依賴 Electron,單元測試可以直接載入。
 * 預設仍是接手節點自己的工作目錄所屬的專案;交辦者可以明確指定,但只能指定主控台已知的專案
 * (某個節點的工作目錄所屬的專案,或已經有任務紀錄的專案),可以填名稱或 ID。
 */
export interface KnownProject { id: string; name: string; git?: boolean }

export type ProjectChoice = { ok: true; project: KnownProject } | { ok: false; error: string };

const normId = (s: string) => s.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 已知專案去重(依 ID;同一個 ID 以先出現的為準,但有 git 資訊的補上)。 */
export function uniqueProjects(list: readonly KnownProject[]): KnownProject[] {
  const out = new Map<string, KnownProject>();
  for (const p of list) {
    if (!p?.id) continue;
    const old = out.get(p.id);
    if (!old) out.set(p.id, { ...p });
    else if (old.git === undefined && p.git !== undefined) old.git = p.git;
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** 給 agent 看的可用專案清單(一行一個)。 */
export function projectList(known: readonly KnownProject[]): string {
  if (!known.length) return '(目前沒有已知的專案)';
  return known.map(p => `- ${p.name}(${p.git === false ? '共用資料夾' : 'git'}) ID:${p.id}`).join('\n');
}

/** 依 project 參數(名稱或 ID)找出已知專案;找不到、或名稱對到好幾個時,回傳附可用清單的錯誤訊息。 */
export function chooseProject(arg: string, known: readonly KnownProject[]): ProjectChoice {
  const key = String(arg ?? '').trim();
  if (!key) return { ok: false, error: 'project 是空的。' };
  const byId = known.find(p => normId(p.id) === normId(key));
  if (byId) return { ok: true, project: byId };
  const named = known.filter(p => p.name.toLowerCase() === key.toLowerCase());
  if (named.length === 1) return { ok: true, project: named[0] };
  if (named.length > 1) return { ok: false, error: `有 ${named.length} 個專案都叫「${key}」,請改用 ID 指定:\n${projectList(named)}` };
  return { ok: false, error: `主控台不認得專案「${key}」。只能指定已知的專案(某個節點的工作目錄所屬的專案,或已有任務紀錄的專案),可以填名稱或 ID:\n${projectList(known)}` };
}

/** 沒有指定專案、接手節點又在共用的非 git 資料夾時,附在回覆上的一行提醒(不擋交辦);其餘情況是空字串。 */
export function folderHint(target: KnownProject | null | undefined): string {
  return target && target.git === false ? `(提醒:未指定專案,將記到該節點的資料夾〈${target.name}〉。這件事屬於某個專案時,下次可以帶 project 指定。)` : '';
}
