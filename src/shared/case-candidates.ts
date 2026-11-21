// 判例候選偵測(長期記憶階段 3):任務完成時,判斷這個任務值不值得請承辦節點寫成判例。
// 純函式、不依賴 Electron 與其他模組(單元測試 tests/case-candidates.test.mjs 直接載入)。
import type { TaskInfo } from './types';

/** 耗時超過這麼多分鐘算「困難任務」。 */
export const CASE_MIN_MINUTES = 30;
/** 節點在這個任務裡說的話(agent 訊息)達到這麼多則,算對話回合特別多。 */
export const CASE_MIN_AGENT_MESSAGES = 15;
/** 每天自動請節點撰寫的判例份數上限(使用者手動標記的不算)。 */
export const CASE_DAILY_CAP = 3;

/**
 * 審查評論送回節點時的提示詞開頭(和 review.ts 的 formatCommentsPrompt 一致,測試會比對);
 * 由這個提示詞開出來的任務,就是「審查被打回後的修改」。
 */
const REVIEW_RESEND = /^使用者在變更檢視裡,對你在任務/;
/** 會議的發言提示詞開頭(和 interop.ts 一致);會議的發言不當成判例候選。 */
const MEETING_TURN = /^\(主控台:這是一場由節點/;

export interface CandidateInput {
  task: Pick<TaskInfo, 'status' | 'startedAt' | 'endedAt' | 'source' | 'title' | 'caseId' | 'casePending'>;
  /** 節點在這個任務期間說了幾則話。 */
  agentMessages: number;
  /** 失敗次數:任務期間的錯誤事件,加上這次是重試上一次失敗的同一句指令。 */
  failures: number;
  /** 覆寫門檻(測試與 NEXUS_CASE_MIN_MINUTES 用);省略時用預設常數。 */
  minMinutes?: number;
  minMessages?: number;
}

/** 任務不適合當候選的原因;null 表示可以進一步判斷。 */
export function notCandidateReason(task: CandidateInput['task']): string | null {
  if (task.status !== 'done' || task.endedAt === null) return '任務沒有正常完成';
  if (task.caseId || task.casePending) return '已經有判例或正在撰寫';
  // 撰寫判例的請求本身、假資料的自動運作、會議的發言,都不是值得記下來的解法
  if (task.source === 'case' || task.source === 'autopilot') return '來源不列入判例候選';
  if (MEETING_TURN.test(task.title)) return '會議的發言';
  return null;
}

/** 候選的理由(中文,會寫進請節點撰寫的提示詞);空陣列表示不是候選。 */
export function detectCandidate(input: CandidateInput): string[] {
  if (notCandidateReason(input.task) !== null) return [];
  const { task } = input;
  const reasons: string[] = [];
  const minutes = ((task.endedAt as number) - task.startedAt) / 60000;
  if (minutes > (input.minMinutes ?? CASE_MIN_MINUTES)) reasons.push(`耗時約 ${Math.round(minutes)} 分鐘`);
  if (input.failures > 0) reasons.push(`中途失敗 ${input.failures} 次後才成功`);
  if (REVIEW_RESEND.test(task.title)) reasons.push('審查被打回後修好');
  if (input.agentMessages >= (input.minMessages ?? CASE_MIN_AGENT_MESSAGES)) reasons.push(`對話回合多(${input.agentMessages} 則)`);
  return reasons;
}
