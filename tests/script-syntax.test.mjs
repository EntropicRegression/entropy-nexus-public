// 驗收:tests/ 與 tools/ 底下所有 .js / .mjs / .cjs 都能通過 `node --check`(只檢查語法,不執行)。
// e2e 腳本多半只在 CI 的核心驗收才會跑到,寫壞了(例如字串裡混入真的換行)本機的單元測試抓不到;這支測試補上這個缺口。
// 用法:node --no-warnings tests/script-syntax.test.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'fixtures', '__pycache__', '.venv', 'venv']);

function scripts(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...scripts(p));
    else if (/\.(?:m|c)?js$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...scripts(join(ROOT, 'tests')), ...scripts(join(ROOT, 'tools'))];
if (files.length < 20) { console.log(`不符:只找到 ${files.length} 支腳本,搜尋路徑可能有誤`); process.exit(1); }
const bad = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) bad.push(`${relative(ROOT, f)}\n${(r.stderr || '').split('\n').slice(0, 4).join('\n')}`);
}
if (bad.length) {
  console.log(`有 ${bad.length} 項不符(語法錯誤):\n\n${bad.join('\n\n')}`);
  process.exit(1);
}
console.log(`[ok] ${files.length} 支腳本都通過語法檢查`);
console.log('通過 1 項');
