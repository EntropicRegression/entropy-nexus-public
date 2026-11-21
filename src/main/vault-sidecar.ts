import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 記憶庫根目錄的附屬檔案(`.nexus-heat.json`、`.nexus-stats.json`):不依賴 Electron,單元測試可以直接載入。
 * 給別的程式(記憶庫管理 App)讀的,所以一律「暫存檔 + 改名」原子寫入;管理 App 正在讀的時候 Windows 會讓改名失敗,
 * 這裡短暫重試幾次,仍失敗就放棄這一次(暫存檔刪掉),留到下一次寫入。
 */

export interface SidecarIo {
  write(file: string, text: string): void;
  rename(from: string, to: string): void;
  remove(file: string): void;
  /** 重試之間等待的毫秒數(同步)。 */
  sleep(ms: number): void;
}

const defaultIo: SidecarIo = {
  write: (f, t) => writeFileSync(f, t, 'utf8'),
  rename: renameSync,
  remove: f => { try { unlinkSync(f); } catch { /* 沒有就算了 */ } },
  sleep: ms => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不能等就直接重試 */ } },
};

/** 改名失敗時的重試間隔(毫秒);共 RETRY_DELAYS.length + 1 次嘗試。 */
export const RETRY_DELAYS = [25, 50, 100, 200];

/**
 * 把 data 序列化成 JSON,以暫存檔 + 改名原子寫到 file。
 * 回傳 true 表示寫成功;false 表示放棄(寫暫存檔失敗,或改名在重試後仍失敗),原檔維持上一份,呼叫端留到下一次寫入再試。
 * 只在 EPERM、EBUSY、EACCES 時重試(Windows 上檔案被別的程式開著);其他錯誤直接放棄。永遠不丟例外。
 * 第三個參數只給測試用(假的檔案系統)。
 */
// 同步版本:主控台關閉前(before-quit)也要確實寫完熱度,所以不用非同步。定期寫入、不想卡住主行程的場合用 vault-stats.ts 的 atomicWriteJson(非同步)。
export function writeJsonAtomic(file: string, data: unknown, io: SidecarIo = defaultIo): boolean {
  const tmp = `${file}.${process.pid}.tmp`;
  try { io.write(tmp, JSON.stringify(data, null, 2)); } catch { io.remove(tmp); return false; }
  for (let i = 0; ; i++) {
    try { io.rename(tmp, file); return true; } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (i >= RETRY_DELAYS.length || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) { io.remove(tmp); return false; }
      io.sleep(RETRY_DELAYS[i]);
    }
  }
}

// ---------- 熱度 ----------

export const HEAT_FILE = '.nexus-heat.json';
/** 熱度檔最多每這麼多毫秒寫一次。 */
export const HEAT_INTERVAL = 5000;
export interface HeatEntry { 召回次數: number; 最後召回: string }

interface HeatState { data: Record<string, HeatEntry>; dirty: boolean; lastWrite: number; timer: ReturnType<typeof setTimeout> | null; io?: SidecarIo }
const states = new Map<string, HeatState>();

function stateOf(vaultDir: string): HeatState {
  let s = states.get(vaultDir);
  if (s) return s;
  const data: Record<string, HeatEntry> = {};
  try {
    const raw = JSON.parse(readFileSync(join(vaultDir, HEAT_FILE), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, any>)) {
        if (v && typeof v === 'object' && Number.isFinite(Number(v.召回次數))) data[k] = { 召回次數: Math.max(0, Math.floor(Number(v.召回次數))), 最後召回: String(v.最後召回 ?? '') };
      }
    }
  } catch { /* 沒有或壞掉就從空的開始 */ }
  s = { data, dirty: false, lastWrite: 0, timer: null };
  states.set(vaultDir, s);
  return s;
}

function flushState(vaultDir: string, s: HeatState): boolean {
  if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  if (!s.dirty) return true;
  if (!existsSync(vaultDir)) return false;
  s.lastWrite = Date.now();
  const ok = writeJsonAtomic(join(vaultDir, HEAT_FILE), s.data, s.io);
  if (ok) s.dirty = false; // 失敗就維持 dirty,下一次記錄時會再寫
  return ok;
}

/**
 * 記一次召回(只有 memory_read 呼叫):次數加一、更新最後召回時間。
 * 寫檔有節流:距離上次寫入超過 HEAT_INTERVAL 才立刻寫,否則排在滿 HEAT_INTERVAL 時寫;程式結束前呼叫 flushHeat()。
 */
export function recordRecall(vaultDir: string, relPath: string, now = Date.now()): void {
  const s = stateOf(vaultDir);
  const cur = s.data[relPath];
  s.data[relPath] = { 召回次數: (cur?.召回次數 ?? 0) + 1, 最後召回: new Date(now).toISOString() };
  s.dirty = true;
  if (s.timer) return;
  const wait = s.lastWrite + HEAT_INTERVAL - Date.now();
  if (wait <= 0) { flushState(vaultDir, s); return; }
  s.timer = setTimeout(() => { s.timer = null; flushState(vaultDir, s); }, wait);
  s.timer.unref?.();
}

/** 立刻把還沒寫出去的熱度寫出(結束前呼叫);不指定記憶庫就全部。 */
export function flushHeat(vaultDir?: string): void {
  for (const [dir, s] of states) if (!vaultDir || dir === vaultDir) flushState(dir, s);
}

/** 目前記憶體裡的熱度(測試與除錯用)。 */
export function heatOf(vaultDir: string): Record<string, HeatEntry> { return { ...stateOf(vaultDir).data }; }

/** 清掉某個記憶庫的快取狀態(測試用);可換成假的檔案系統。 */
export function resetHeat(vaultDir: string, io?: SidecarIo): void {
  const s = states.get(vaultDir);
  if (s?.timer) clearTimeout(s.timer);
  states.delete(vaultDir);
  if (io) stateOf(vaultDir).io = io;
}
