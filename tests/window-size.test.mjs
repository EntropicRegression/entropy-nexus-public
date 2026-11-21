// 驗收:主視窗的初始大小與最小尺寸不超過螢幕的可用範圍(src/main/window-size.ts)。
// 用法:在 app 資料夾執行 node tests/window-size.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { windowSizes } from '../src/main/window-size.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

test('大螢幕:初始 1440×900,最小 960×560', () => {
  assert.deepEqual(windowSizes({ width: 1920, height: 1040 }), { width: 1440, height: 900, minWidth: 960, minHeight: 560 });
});
test('1366×768 開 125%(可用約 1093×580):初始大小縮到可用範圍內,最小尺寸不變', () => {
  assert.deepEqual(windowSizes({ width: 1093, height: 580 }), { width: 1093, height: 580, minWidth: 960, minHeight: 560 });
});
test('可用範圍比最小尺寸還小:最小尺寸跟著縮,視窗不會比螢幕大', () => {
  assert.deepEqual(windowSizes({ width: 900, height: 520 }), { width: 900, height: 520, minWidth: 900, minHeight: 520 });
});
test('可用範圍有小數(非整數縮放):無條件捨去', () => {
  assert.deepEqual(windowSizes({ width: 1092.8, height: 579.2 }), { width: 1092, height: 579, minWidth: 960, minHeight: 560 });
});
test('讀不到螢幕資訊:用預設值', () => {
  assert.deepEqual(windowSizes(null), { width: 1440, height: 900, minWidth: 960, minHeight: 560 });
  assert.deepEqual(windowSizes({ width: 0, height: 0 }), { width: 1440, height: 900, minWidth: 960, minHeight: 560 });
});
console.log(`通過 ${passed} 項`);
