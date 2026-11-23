import type { FlowStepDef, StepMode, StepReport, VerifyResult } from '../../shared/flow.ts';

/**
 * 協作流程每一步的交辦文字(純函式)。輸入一律來自從 runs/<id>/ 讀回的檔案(step_report、核實結果、diff),
 * 不讀節點的文字回覆(規格 §8:下一步讀檔,不讀回覆,回覆遺失也能補回)。
 * 開頭幾行是固定格式(假資料轉接器靠它認出流程交辦,見 fake.ts):
 *   (主控台:協作流程「…」的交辦。…)
 *   流程步驟:<步驟 id>(第 N 次)
 *   assignment_id:<交辦 id>
 */

/** 交辦的開頭;假資料轉接器也靠它認出這是流程交辦。 */
export const FLOW_PROMPT_LEAD = '(主控台:協作流程「';
/** 提醒的開頭。 */
export const FLOW_REMIND_LEAD = '(主控台:step_report 提醒。';

/** 這一步要填的 step_report 欄位(交辦文字只列出這一步要填的,實作步驟看不到審查專用的欄位)。 */
export function reportFields(mode: StepMode): string[] {
  const common = [
    '- summary(必填):這一步做了什麼、結果如何',
    '- commands_run:實際跑過的指令與結果(物件陣列:command、result)',
    '- not_verified:明確列出沒驗證到的事',
    '- questions:要請使用者裁示的問題(會交給使用者,不計入退回輪數)',
    '- scope_exceptions:每改一個範圍外的檔案都寫一筆原因(物件陣列:path、reason)',
  ];
  if (mode === 'write') return common;
  return [
    '- verdict(必填):mergeable(可合併)或 changes_required(需修正);有必修就不能填 mergeable',
    '- must_fix:必修(會退回實作者修正);changes_required 時至少一項',
    '- suggestions:建議(實作者自行判斷要不要改)',
    '- needs_ruling:需要使用者裁示的事(直接交給使用者,不計入退回輪數)',
    ...common,
  ];
}

export interface PrevReport {
  label: string;
  agentName: string;
  report: StepReport;
  /** 這份回報的 md 檔(給節點自己打開看)。 */
  file?: string;
}

export interface StepPromptInput {
  flowName: string;
  topic: string;
  step: FlowStepDef;
  attempt: number;
  assignmentId: string;
  continuation: 'continued' | 'new';
  /** 正本的工作目錄。 */
  cwd: string;
  /** 允許修改的範圍(空陣列表示不限制)。 */
  allowedPaths: string[];
  /** 主控台會自己重跑的核實指令。 */
  verifyCommands: string[];
  /** 審查步驟:副本資料夾(對應到工作目錄的那一層)與版本。 */
  copyDir?: string;
  version?: string;
  /** 審查步驟:這次相對開始時改了哪些檔。 */
  changed?: string[];
  /** 前一步的回報(從檔案讀回)。 */
  prev?: PrevReport;
  /** 退回原因:審查的必修(從檔案讀回)。 */
  mustFix?: { from: PrevReport };
  /** 退回原因:核實失敗(從檔案讀回)。 */
  verify?: VerifyResult;
  /** 新 session 時附上相對交審版本的 diff。 */
  diff?: string;
  /** 使用者的裁示。 */
  rulings?: string[];
}

const DIFF_MAX = 20000;
const list = (xs: string[]) => xs.map(x => `- ${x.replace(/\r?\n/g, '\n  ')}`).join('\n');

/** 前一份回報的摘要段落。 */
function reportBlock(title: string, p: PrevReport, full: boolean): string {
  const r = p.report;
  const lines = [`【${title}:${p.label}(${p.agentName})】`, r.summary];
  if (r.verdict) lines.push(`結論:${r.verdict === 'mergeable' ? '可合併' : '需修正'}`);
  if (full && r.mustFix.length) lines.push('必修:', list(r.mustFix));
  if (full && r.suggestions.length) lines.push('建議(自行判斷):', list(r.suggestions));
  if (r.notVerified.length) lines.push('沒驗證到的事:', list(r.notVerified));
  if (r.scopeExceptions.length) lines.push('範圍外的檔案:', list(r.scopeExceptions.map(e => `${e.path}:${e.reason}`)));
  if (p.file) lines.push(`(完整回報:${p.file})`);
  return lines.join('\n');
}

/** 一步的交辦文字。 */
export function stepPrompt(i: StepPromptInput): string {
  const s = i.step;
  const review = s.mode === 'review';
  const out: string[] = [
    `${FLOW_PROMPT_LEAD}${i.flowName}」的交辦。這是流程裡的一個步驟,不是一般對話;做完後一定要呼叫 step_report 工具回報。)`,
    `流程步驟:${s.id}(第 ${i.attempt} 次)`,
    `assignment_id:${i.assignmentId}`,
    `【主題】${i.topic}`,
    `【這一步】${s.label}${review ? '(隔離審查)' : ''}`,
  ];
  if (i.attempt > 1 || i.continuation === 'new') out.push(i.continuation === 'continued' ? '(延續你在這個流程裡的 session。)' : '(這是新的交辦:之前的過程不在你的對話裡,下面附上需要的前情。)');
  if (review) {
    out.push(
      `審查副本:${i.copyDir ?? '(沒有副本)'}`,
      `請在上面這個副本資料夾裡審查版本 ${(i.version ?? '').slice(0, 12)}。副本是主控台從這個版本匯出的,不含 .git。`,
      `不要修改正本(${i.cwd}),也不要修改副本:副本被寫入會被標示並丟棄,絕不回寫正本。審查文件由主控台依你的 step_report 代寫,你不必寫檔。`,
    );
    if (i.changed?.length) out.push(`這次改了的檔案(相對專案根目錄):\n${list(i.changed.slice(0, 200))}${i.changed.length > 200 ? `\n…還有 ${i.changed.length - 200} 個` : ''}`);
  } else {
    out.push(`工作目錄:${i.cwd}`);
  }
  if (i.prev) out.push(reportBlock(review ? '實作者的回報' : '前一步的回報', i.prev, false));
  if (i.mustFix) out.push(reportBlock('審查意見', i.mustFix.from, true), '請逐項處理上面的必修;建議由你判斷要不要改。');
  if (i.verify) {
    const bad = i.verify.commands.filter(c => c.outcome === 'fail');
    out.push(`【主控台重跑核實失敗】\n${list(bad.map(c => `${c.id}(${c.run}):結束代碼 ${c.exitCode ?? '-'};最後一行:${c.lastLine || '(沒有輸出)'}${c.logFile ? `;完整輸出:${c.logFile}` : ''}`))}\n請修正到這些指令通過。`);
  }
  if (i.diff) out.push(`【相對開始時的修改(交審版本的 diff)】\n${i.diff.length > DIFF_MAX ? `${i.diff.slice(0, DIFF_MAX)}\n…(diff 太長,已截斷)` : i.diff}`);
  if (i.rulings?.length) out.push(`【使用者的裁示】\n${list(i.rulings)}`);
  const rules = [
    '規則:',
    '- 不要 commit、push、打包(npm run dist、electron-builder)、合併或核准 PR、刪分支;這些一律由使用者在主控台的授權卡上確認後處理。',
  ];
  if (!review) {
    rules.push(i.allowedPaths.length ? `- 只改這次需要的檔案,範圍:${i.allowedPaths.join('、')};改到範圍外的檔案要在 scope_exceptions 寫原因。` : '- 只改這次需要的檔案;改到不相關的檔案要在 scope_exceptions 寫原因。');
    if (i.verifyCommands.length && s.verify) rules.push(`- 你回報後,主控台會在隔離副本裡自己重跑核實指令(不採信自述):${i.verifyCommands.join('、')}`);
  }
  rules.push(
    `- 做完後呼叫 step_report 工具(nexus 伺服器)回報一次;主控台不讀你的文字回覆,沒有回報就不算完成。參數名稱一律用英文:`,
    `- assignment_id(必填):${i.assignmentId}`,
    ...reportFields(s.mode),
  );
  out.push(rules.join('\n'));
  return out.join('\n\n');
}

/** 回合結束仍沒回報時的提醒(只提醒一次)。 */
export function reminderPrompt(i: { flowName: string; step: FlowStepDef; attempt: number; assignmentId: string; topic: string }): string {
  return [
    `${FLOW_REMIND_LEAD}這不是新的工作,請不要再修改檔案。)`,
    `流程步驟:${i.step.id}(第 ${i.attempt} 次)`,
    `assignment_id:${i.assignmentId}`,
    `【主題】${i.topic}`,
    `你剛完成協作流程「${i.flowName}」的步驟「${i.step.label}」,但還沒有呼叫 step_report 工具。請現在呼叫一次(nexus 伺服器),主控台不讀文字回覆。這是唯一一次提醒;仍沒有回報時會記成「未回報」並交給使用者。`,
    `- assignment_id(必填):${i.assignmentId}`,
    ...reportFields(i.step.mode),
  ].join('\n');
}
