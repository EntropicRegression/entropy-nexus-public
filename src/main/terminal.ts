import * as pty from '@lydell/node-pty';

/**
 * 終端機保底模式:在虛擬終端機裡直接執行原生 CLI(未修改的官方程式)。
 * 結構化通道壞掉、或想用 CLI 自己的介面時使用;這個模式下主控台只轉送畫面與按鍵,不解析內容。
 */
interface Term { proc: pty.IPty; buffer: string }

const terms = new Map<string, Term>();
const MAX_BUFFER = 400_000;

export function hasTerminal(id: string): boolean {
  return terms.has(id);
}

export function openTerminal(
  id: string, command: { file: string; args: string[] }, cwd: string, cols: number, rows: number,
  onData: (data: string) => void, onExit: (code: number) => void,
): void {
  closeTerminal(id);
  const env = { ...process.env } as Record<string, string>;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // Windows 上經由 cmd 啟動,讓 PATH 上的指令與 .cmd 墊片都找得到
  const [file, args] = process.platform === 'win32' ? ['cmd.exe', ['/c', command.file, ...command.args]] as const : [command.file, command.args] as const;
  const proc = pty.spawn(file, [...args], { name: 'xterm-256color', cols: Math.max(20, cols), rows: Math.max(5, rows), cwd, env });
  const term: Term = { proc, buffer: '' };
  terms.set(id, term);
  proc.onData(data => {
    term.buffer = (term.buffer + data).slice(-MAX_BUFFER);
    onData(data);
  });
  proc.onExit(e => {
    if (terms.get(id) === term) { terms.delete(id); onExit(e.exitCode); }
  });
}

/** 畫面重新掛上時補回先前的輸出。 */
export function terminalBuffer(id: string): string {
  return terms.get(id)?.buffer ?? '';
}

export function writeTerminal(id: string, data: string): void {
  terms.get(id)?.proc.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  try { terms.get(id)?.proc.resize(Math.max(20, cols), Math.max(5, rows)); } catch { /* 行程剛結束 */ }
}

export function closeTerminal(id: string): void {
  const t = terms.get(id);
  if (!t) return;
  terms.delete(id);
  try { t.proc.kill(); } catch { /* 已結束 */ }
}

export function closeAllTerminals(): void {
  for (const id of [...terms.keys()]) closeTerminal(id);
}
