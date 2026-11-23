import implementReview from './templates/implement-review.yaml?raw';
import { parseFlow } from './definition.ts';
import type { FlowParseResult } from '../../shared/flow.ts';

/**
 * 內建流程範本。範本檔放在 templates/,建置時用 ?raw 打包成字串(正式版的 out/ 裡沒有 templates 資料夾)。
 * 只有這個檔案用 ?raw;單元測試不載入這個檔案,改用 fs 直接讀範本檔交給 parseFlow。
 */
export const BUILTIN_TEMPLATE_FILES: Record<string, string> = {
  'implement-review.yaml': implementReview,
};

/** 解析所有內建範本。內建範本解析失敗是程式錯誤,單元測試會擋下。 */
export function builtinTemplates(): (FlowParseResult & { file: string })[] {
  return Object.entries(BUILTIN_TEMPLATE_FILES).map(([file, text]) => ({ file, ...parseFlow(text, 'builtin', file) }));
}
