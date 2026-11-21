// 驗收:主控台提供給 agent 的 MCP 工具(src/main/interop.ts 的 TOOL_DEFS)名稱與參數名稱都符合各家 API 的限制。
// Anthropic API 規定工具的參數名稱只能是 ^[a-zA-Z0-9_.-]{1,64}$,工具名稱是 ^[a-zA-Z0-9_-]{1,64}$;
// 不符合的工具會被 Claude Code 整個排除(Claude 節點根本看不到它)。曾經發生過:case_submit 的參數用了中文。
// interop.ts 有無副檔名的匯入,node 不能直接載入,所以讀原始碼解析工具定義。
// 用法:在 app 資料夾執行 node tests/mcp-schema.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };

const src = readFileSync(new URL('../src/main/interop.ts', import.meta.url), 'utf8');
const start = src.indexOf('const TOOL_DEFS');
assert.ok(start >= 0, '找得到 TOOL_DEFS');
const defs = src.slice(start, src.indexOf('\n];', start));

// 每個工具:name 與 inputSchema 區塊(到下一個工具或結尾)
const tools = [...defs.matchAll(/name:\s*'([^']+)',\s*\n\s*description:/g)].map((m, i, all) => ({
  name: m[1],
  body: defs.slice(m.index, all[i + 1]?.index ?? defs.length),
}));

test('找得到所有工具定義,而且和 INTEROP_TOOLS 一致', () => {
  const listed = /export const INTEROP_TOOLS = \[([^\]]+)\]/.exec(src)?.[1].match(/'([^']+)'/g).map(s => s.slice(1, -1)) ?? [];
  assert.ok(tools.length >= 8, `工具數 ${tools.length}`);
  assert.deepEqual(tools.map(t => t.name).sort(), [...listed].sort());
});

test('工具名稱只用英數字、底線、連字號(64 字以內)', () => {
  for (const t of tools) assert.match(t.name, /^[a-zA-Z0-9_-]{1,64}$/, t.name);
});

test('參數名稱只用英數字與 _ . -(64 字以內),required 列的參數都有定義', () => {
  for (const t of tools) {
    // properties 從「properties:」到「required:」或「additionalProperties」之間;不管寫成一行或多行都抓得到。
    // 每個參數都寫成「名稱: { type: …」;清單的 items 也是這個樣子,但它是子結構,不是參數名稱。
    const from = t.body.indexOf('properties:');
    const end = Math.min(...['required:', 'additionalProperties'].map(w => t.body.indexOf(w, from)).filter(i => i > 0));
    const props = from >= 0 ? t.body.slice(from + 'properties:'.length, end) : '';
    const keys = [...props.matchAll(/([^\s{},:]+)\s*:\s*\{\s*type:/g)].map(m => m[1].replace(/^['"]|['"]$/g, '')).filter(k => k !== 'items');
    for (const k of keys) assert.match(k, /^[a-zA-Z0-9_.-]{1,64}$/, `${t.name} 的參數「${k}」`);
    const required = /required:\s*\[([^\]]*)\]/.exec(t.body)?.[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? [];
    for (const r of required) assert.ok(keys.includes(r), `${t.name} 的 required 「${r}」沒有定義在 properties`);
  }
});

test('case_submit 用英文參數,而且和 cases.ts 的 CASE_ARGS 對得上', () => {
  const cs = tools.find(t => t.name === 'case_submit');
  assert.ok(cs, '有 case_submit');
  const casesSrc = readFileSync(new URL('../src/main/cases.ts', import.meta.url), 'utf8');
  const args = /export const CASE_ARGS = \{([^}]+)\}/.exec(casesSrc)?.[1].match(/(\w+):/g)?.map(s => s.slice(0, -1)) ?? [];
  assert.ok(args.length === 11, `CASE_ARGS 有 ${args.length} 個`);
  for (const a of args) assert.ok(new RegExp(`^\\s*${a}:\\s*\\{\\s*type:`, 'm').test(cs.body), `case_submit 少了參數 ${a}`);
});

console.log(`通過 ${passed} 項`);
