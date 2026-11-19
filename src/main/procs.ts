import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 記錄主控台啟動過的 CLI 子行程。
 * 正常情況下主控台結束時會自己停掉它們;即使被強制關閉,三家 CLI 也會在輸入管道關閉後自行結束(階段 5 實測)。
 * 這裡是最後一道保險:下次啟動時把名單上還活著、而且確實是我們啟動的那種行程清掉。
 */
export type Kind = 'claude' | 'codex' | 'agy';
interface Entry { pid: number; kind: Kind }

let file: string | null = null;
const live = new Map<number, Kind>();

function save(): void {
  if (!file) return;
  try { writeFileSync(file, JSON.stringify([...live].map(([pid, kind]) => ({ pid, kind })))); } catch { /* 寫不進去不影響運作 */ }
}

export function initProcs(dir: string): void {
  file = join(dir, 'children.json');
}

export function track(pid: number | undefined, kind: Kind): void {
  if (!pid) return;
  live.set(pid, kind);
  save();
}

export function untrack(pid: number | undefined): void {
  if (!pid || !live.delete(pid)) return;
  save();
}

/** 清掉上次留下的子行程,回傳清掉的數量。只處理名稱與啟動參數都符合的行程,避免誤殺重複使用的 PID。 */
export function reapStale(): Promise<number> {
  return new Promise(resolve => {
    if (!file || !existsSync(file) || process.platform !== 'win32') { resolve(0); return; }
    let entries: Entry[] = [];
    try { entries = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 檔案壞了就當作沒有 */ }
    entries = entries.filter(e => Number.isInteger(e.pid) && ['claude', 'codex', 'agy'].includes(e.kind));
    writeFileSync(file, '[]');
    if (!entries.length) { resolve(0); return; }
    const filter = entries.map(e => `ProcessId=${e.pid}`).join(' OR ');
    const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }`;
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
      if (err) { resolve(0); return; }
      const victims: number[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const [pidText, name = '', cmd = ''] = line.split('|');
        const entry = entries.find(e => e.pid === Number(pidText));
        if (!entry) continue;
        const ours = name.toLowerCase() === `${entry.kind}.exe` && /stream-json|app-server|\bacp\b/.test(cmd);
        if (ours) victims.push(entry.pid);
      }
      if (!victims.length) { resolve(0); return; }
      let left = victims.length;
      for (const pid of victims) {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => { if (--left === 0) resolve(victims.length); });
      }
    });
  });
}
