// 驗收:瀏覽器版完整介面(src/main/remote-shim.js)提供的 window.nexus 方法,要涵蓋桌面版(src/preload/index.ts)的每一個方法,
// 刻意只給桌面畫面的(協作流程)除外。少了方法時,畫面在 effect 裡直接呼叫會丟例外,瀏覽器版整個畫面可能變空白
// (2026-11-24 發現 getMemoryVault 與 moveWorkspace 漏了)。
// 用法:node --no-warnings tests/remote-shim-api.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pre = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
const shim = readFileSync(new URL('../src/main/remote-shim.js', import.meta.url), 'utf8');
const preNames = [...pre.matchAll(/^\s{2}([a-zA-Z]+)\s*:/gm)].map(m => m[1]);
const mStart = shim.indexOf('const METHODS = {');
const mapped = [...shim.slice(mStart, shim.indexOf('};', mStart)).matchAll(/([a-zA-Z]+):\s*'/g)].map(m => m[1]);
const aStart = shim.indexOf('Object.assign(api, {');
const extra = [...shim.slice(aStart, shim.indexOf('window.nexus = api')).matchAll(/^\s{4}([a-zA-Z]+)[,:(]/gm)].map(m => m[1]);
const have = new Set([...mapped, ...extra]);

// 只在桌面畫面提供:協作流程(App.tsx 依 window.nexus.flowStart 是否存在決定顯示)
const DESKTOP_ONLY = /^flow[A-Z]/;
assert.ok(preNames.length > 50, `preload 的方法讀不到(${preNames.length})`);
const missing = preNames.filter(n => !have.has(n) && !DESKTOP_ONLY.test(n));
assert.deepEqual(missing, [], `瀏覽器版缺少這些方法:${missing.join(', ')}`);
assert.ok(!mapped.some(n => DESKTOP_ONLY.test(n)), '協作流程的方法不應出現在瀏覽器版');
console.log(`remote-shim-api:桌面版 ${preNames.length} 個方法,瀏覽器版都有(協作流程除外)`);
