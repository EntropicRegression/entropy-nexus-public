import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StepReport } from '../../shared/flow.ts';
import type { FlowRun } from './machine.ts';

/**
 * 協作流程的持久化:<資料夾>/runs/<id>/
 *   run.json             完整狀態(含啟動當時解析好的流程定義)
 *   reports/<交辦>.json  step_report(下一步讀這個檔,不讀回覆)
 *   reports/<交辦>.md    主控台代寫的回報文件
 *   late/<交辦>-<時間>.json 遲到的回報(不推進流程)
 *   copies/              審查副本(r-)與核實副本(v-),用完就刪
 *   logs/<交辦>/         核實指令的輸出
 * 寫入一律先寫暫存檔再 rename(原子寫入),主控台中途被關掉也不會留下寫一半的 run.json。
 */

const ID_RE = /^[\w-]{1,80}$/;

/** 先寫暫存檔再 rename;Windows 上目標被其他程式短暫開著時重試幾次。 */
export function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { renameSync(tmp, file); return; } catch (e) {
      if (i >= 4) { rmSync(tmp, { force: true }); throw e; }
      const until = Date.now() + 50 * (i + 1);
      while (Date.now() < until) { /* 短暫等待後重試 */ }
    }
  }
}

export class RunStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`流程 id 不合法:${id}`);
    return join(this.root, id);
  }

  copiesDir(id: string): string { return join(this.dir(id), 'copies'); }
  logsDir(id: string, assignmentId: string): string { return join(this.dir(id), 'logs', safe(assignmentId)); }

  save(run: FlowRun): void {
    const d = this.dir(run.id);
    mkdirSync(d, { recursive: true });
    atomicWrite(join(d, 'run.json'), JSON.stringify(run, null, 1));
  }

  /** 讀回所有流程;壞掉的 run.json 略過並回報。 */
  loadAll(): { runs: FlowRun[]; errors: string[] } {
    const runs: FlowRun[] = [];
    const errors: string[] = [];
    if (!existsSync(this.root)) return { runs, errors };
    for (const name of readdirSync(this.root)) {
      const file = join(this.root, name, 'run.json');
      if (!ID_RE.test(name) || !existsSync(file)) continue;
      try {
        const run = JSON.parse(readFileSync(file, 'utf8')) as FlowRun;
        if (run && run.id === name && Array.isArray(run.assignments)) runs.push(run); else errors.push(`${file}:格式不對`);
      } catch (e) { errors.push(`${file}:${(e as Error).message}`); }
    }
    return { runs: runs.sort((a, b) => a.startedAt - b.startedAt), errors };
  }

  /** 寫入 step_report 的 json 與 md,回傳兩個檔案的完整路徑。 */
  writeReport(runId: string, assignmentId: string, report: StepReport, md: string): string[] {
    const d = join(this.dir(runId), 'reports');
    mkdirSync(d, { recursive: true });
    const json = join(d, `${safe(assignmentId)}.json`);
    const mdFile = join(d, `${safe(assignmentId)}.md`);
    atomicWrite(json, JSON.stringify(report, null, 1));
    atomicWrite(mdFile, md);
    return [json, mdFile];
  }

  /** 從檔案讀回 step_report(下一步的交辦用);沒有或壞掉時回傳 null。 */
  readReport(runId: string, assignmentId: string): { report: StepReport; file: string } | null {
    const file = join(this.dir(runId), 'reports', `${safe(assignmentId)}.json`);
    try { return { report: JSON.parse(readFileSync(file, 'utf8')) as StepReport, file: file.replace(/\.json$/, '.md') }; } catch { return null; }
  }

  /** 遲到的回報:寫進 late/,不推進流程。回傳檔案路徑。 */
  writeLate(runId: string, assignmentId: string, payload: unknown): string {
    const d = join(this.dir(runId), 'late');
    mkdirSync(d, { recursive: true });
    const file = join(d, `${safe(assignmentId)}-${Date.now()}.json`);
    atomicWrite(file, JSON.stringify(payload, null, 1));
    return file;
  }

  /** late/ 底下的檔案(畫面與測試用)。 */
  lateFiles(runId: string): string[] {
    const d = join(this.dir(runId), 'late');
    try { return readdirSync(d).filter(n => n.endsWith('.json')).sort().map(n => join(d, n)); } catch { return []; }
  }
}

const safe = (s: string) => s.replace(/[^\w.-]/g, '_').slice(0, 120);
