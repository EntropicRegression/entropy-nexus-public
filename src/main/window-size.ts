// 主視窗的初始大小與最小尺寸(只做計算,不依賴 electron,方便單元測試)。
// 單位是 DIP(Windows 開了顯示縮放時,螢幕的可用範圍會變小:1366×768 開 125% 約 1093×580)。

export interface Size { width: number; height: number }

/** 希望的初始大小 */
export const PREFERRED: Size = { width: 1440, height: 900 };
/** 希望的最小尺寸;版面在這個大小下每個按鈕都要點得到(tests/layout.sh 會檢查) */
export const MINIMUM: Size = { width: 960, height: 560 };

/** 依螢幕的可用範圍(扣掉工作列)算出視窗大小:初始大小與最小尺寸都不超過可用範圍,視窗才不會比螢幕大 */
export function windowSizes(workArea: Size | null): { width: number; height: number; minWidth: number; minHeight: number } {
  const fit = (want: number, avail: number | undefined): number => (avail && avail > 0 ? Math.min(want, Math.floor(avail)) : want);
  const minWidth = fit(MINIMUM.width, workArea?.width);
  const minHeight = fit(MINIMUM.height, workArea?.height);
  return {
    width: Math.max(minWidth, fit(PREFERRED.width, workArea?.width)),
    height: Math.max(minHeight, fit(PREFERRED.height, workArea?.height)),
    minWidth,
    minHeight,
  };
}
