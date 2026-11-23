// 驗收:Antigravity 的工具白名單(src/shared/agy-allow.ts):規則格式、整理輸入、合併成 agy 的權限設定。
// 用法:在 app 資料夾執行 node tests/agy-allow.test.mjs
import assert from 'node:assert/strict';
import { AGY_ALLOW_MAX, agySettings, isAgyRule, normalizeAgyAllow } from '../src/shared/agy-allow.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

test('規則格式:工具名稱,或「工具名稱(目標)」', () => {
  for (const ok of ['mcp(StitchMCP/*)', 'mcp(StitchMCP/create_project)', 'read_file(C:\\work\\*)', 'execute_url(localhost)', 'run_command']) assert.ok(isAgyRule(ok), ok);
  for (const bad of ['', 'mcp(', 'mcp()', 'mcp(a(b))', '中文(x)', 'mcp(a)\nrun_command', ' mcp(x)', '1abc']) assert.ok(!isAgyRule(bad), JSON.stringify(bad));
});

test('整理輸入:一行一條、去掉空白行、註解與重複,格式錯的另外列出', () => {
  const r = normalizeAgyAllow('mcp(StitchMCP/*)\n\n  mcp(StitchMCP/*)  \n# 這是說明\nmcp(壞的\r\nexecute_url(localhost)');
  assert.deepEqual(r.rules, ['mcp(StitchMCP/*)', 'execute_url(localhost)']);
  assert.deepEqual(r.invalid, ['mcp(壞的']);
  assert.deepEqual(normalizeAgyAllow(['run_command', 'run_command']).rules, ['run_command']);
  assert.deepEqual(normalizeAgyAllow(null), { rules: [], invalid: [] });
});

test('最多 50 條', () => {
  const many = Array.from({ length: 60 }, (_, i) => `mcp(s${i}/*)`).join('\n');
  assert.equal(normalizeAgyAllow(many).rules.length, AGY_ALLOW_MAX);
});

test('合併:主控台自己的規則在前,加上白名單,去掉重複', () => {
  assert.deepEqual(agySettings(['mcp(nexus_tools/*)'], ['mcp(StitchMCP/*)', 'mcp(nexus_tools/*)']), { permissions: { allow: ['mcp(nexus_tools/*)', 'mcp(StitchMCP/*)'] } });
  assert.deepEqual(agySettings([], []), { permissions: { allow: [] } });
});

console.log(`通過 ${passed} 項`);
