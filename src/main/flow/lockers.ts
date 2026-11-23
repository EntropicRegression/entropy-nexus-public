import { execFile } from 'node:child_process';
import type { LockerInfo } from '../../shared/flow.ts';

/**
 * 找出鎖住檔案的程序(核實被環境擋住時附給使用者看)。盡力而為:
 * Windows 用 PowerShell 呼叫 Restart Manager(RmGetList);不是 win32、PowerShell 失敗或逾時都回傳 []。
 * 檔案路徑經環境變數傳給 PowerShell(不拼進指令文字),避免引號與特殊字元的問題。
 */

const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NexusRm {
  [StructLayout(LayoutKind.Sequential)] struct UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESS_INFO {
    public UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, string key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint nFiles, string[] files, uint nApps, IntPtr apps, uint nSvc, string[] svc);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] PROCESS_INFO[] info, ref uint reasons);
  public static List<string> Find(string[] files) {
    var result = new List<string>();
    uint h; if (RmStartSession(out h, 0, Guid.NewGuid().ToString()) != 0) return result;
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, IntPtr.Zero, 0, null) != 0) return result;
      uint needed = 0, n = 0, reasons = 0;
      int rc = RmGetList(h, out needed, ref n, null, ref reasons);
      if (rc == 234 && needed > 0) {
        var info = new PROCESS_INFO[needed]; n = needed;
        if (RmGetList(h, out needed, ref n, info, ref reasons) == 0)
          for (int i = 0; i < n; i++) result.Add(info[i].Process.dwProcessId + "\\t" + info[i].strAppName);
      }
    } finally { RmEndSession(h); }
    return result;
  }
}
'@
$files = $env:NEXUS_LOCK_FILES -split "\`n" | Where-Object { $_ }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
foreach ($line in [NexusRm]::Find([string[]]$files)) { Write-Output $line }
`;

/** 從核實指令的輸出找出被鎖的檔案路徑(例如 EBUSY: resource busy or locked, unlink 'C:\\x\\a.dll')。 */
export function lockedPathsFromOutput(output: string): string[] {
  const out = new Set<string>();
  const re = /(?:EBUSY|EPERM|EACCES)[^'"\n]*?['"]([^'"\n]+)['"]/g;
  for (const m of output.matchAll(re)) out.add(m[1]);
  // Windows 的「程序無法存取檔案,因為檔案正由另一個程序使用」通常把路徑放在引號裡
  const zh = /['"「]([^'"」\n]+)['"」][^\n]*(?:另一個程序|another process)/g;
  for (const m of output.matchAll(zh)) out.add(m[1]);
  return [...out].slice(0, 20);
}

export function findLockers(files: string[], timeoutMs = 20000): Promise<LockerInfo[]> {
  if (process.platform !== 'win32' || !files.length) return Promise.resolve([]);
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise(res => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: timeoutMs, env: { ...process.env, NEXUS_LOCK_FILES: files.join('\n') } },
      (err, stdout) => {
        if (err) { res([]); return; }
        const list: LockerInfo[] = [];
        for (const line of String(stdout).split(/\r?\n/)) {
          const m = /^(\d+)\t(.*)$/.exec(line.trim());
          if (m) list.push({ pid: Number(m[1]), name: m[2].trim() });
        }
        res(list);
      });
  });
}
