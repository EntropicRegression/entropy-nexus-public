// 驗證 Claude 附件內容的組裝(src/main/adapters/claude-content.ts):圖片 image 區塊、PDF document 區塊、
// 其他類型與超過上限的改成路徑文字。直接用 Node 的型別剝除載入 TypeScript 原始碼,不必先建置。
// 用法:node tests/claude-content.test.mjs <附件資料夾(由 attachments-fixtures.mjs 產生)>
// 加上 --live 時另外把組好的內容真的送給 claude(haiku、極短提示詞、不留 session)確認 PDF 讀得到。
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// 原始碼的 import 沒寫副檔名(交給打包工具處理),這裡補上 .ts
register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(spec, ctx, next) {
  try { return await next(spec, ctx); } catch (e) {
    if (spec.startsWith('.') && !/\\.[a-z]+$/.test(spec)) return next(spec + '.ts', ctx);
    throw e;
  }
}`));
const { claudeContent, CLAUDE_PDF_MAX } = await import('../src/main/adapters/claude-content.ts');

const dir = process.argv[2];
const png = join(dir, 'sample.png'), pdf = join(dir, 'sample.pdf'), txt = join(dir, 'notes.txt');
const big = join(dir, 'big.pdf');
writeFileSync(big, Buffer.alloc(CLAUDE_PDF_MAX + 1, 32));

// 1. 圖片 + PDF + 文字檔 + 不存在的檔案 + 超過上限的 PDF
const text = `看附件\n\n附加的檔案:\n- ${png}\n- ${pdf}\n- ${txt}`;
const r = claudeContent(text, [png, pdf, txt, join(dir, 'missing.png'), big]);
assert.ok(Array.isArray(r.content));
const [img, doc, tail] = r.content;
assert.equal(r.content.length, 3);
assert.equal(img.type, 'image'); assert.equal(img.source.type, 'base64'); assert.equal(img.source.media_type, 'image/png');
assert.equal(doc.type, 'document'); assert.deepEqual(Object.keys(doc.source).sort(), ['data', 'media_type', 'type']);
assert.equal(doc.source.type, 'base64'); assert.equal(doc.source.media_type, 'application/pdf');
assert.ok(Buffer.from(doc.source.data, 'base64').toString('latin1').startsWith('%PDF-1.4'));
assert.equal(tail.type, 'text');
// notes.txt 已經在文字裡,不重複;不存在的檔案與太大的 PDF 補上「附件:」
assert.equal(tail.text.split(txt).length - 1, 1);
assert.ok(tail.text.includes(`附件:${join(dir, 'missing.png')}`));
assert.ok(tail.text.includes(`附件:${big}`));
assert.deepEqual(r.fallback.map(f => f.reason), ['Claude Code 只能內嵌圖片與 PDF', '找不到檔案', `檔案 10.0 MB,超過內嵌上限 10.0 MB`]);
console.log('區塊結構', JSON.stringify(r.content.map(b => b.type === 'text' ? b : { ...b, source: { ...b.source, data: `<${b.source.data.length} 字元 base64>` } })));
console.log('改傳路徑', JSON.stringify(r.fallback));

// 2. 沒有可內嵌的附件時維持純文字
const plain = claudeContent('只有文字', [txt]);
assert.equal(typeof plain.content, 'string');
assert.equal(plain.content, `只有文字\n\n附件:${txt}`);
console.log('純文字', JSON.stringify(plain.content));
console.log('claude-content 檢查全部通過');

if (process.argv.includes('--live')) {
  // 真正送給 claude:只附 PDF,請它回覆 PDF 裡的代碼。工作目錄是暫存資料夾,不留 session
  const work = join(dir, 'live'); mkdirSync(work, { recursive: true });
  const { content } = claudeContent('Reply with only the code written in the attached PDF.', [pdf]);
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
  const res = spawnSync('claude', ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--max-budget-usd', '0.05'],
    { cwd: work, input, encoding: 'utf8', timeout: 180000, shell: process.platform === 'win32' });
  const lines = (res.stdout || '').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = lines.find(l => l.type === 'result');
  console.log('claude 結束代碼', res.status, '| stderr', (res.stderr || '').slice(0, 300));
  console.log('claude 回覆', JSON.stringify(result?.result), '| is_error', result?.is_error, '| 花費', result?.total_cost_usd);
  assert.ok(String(result?.result ?? '').includes('NEXUS-PDF-42'), 'claude 沒有讀到 PDF 內容');
  console.log('claude 實測通過');
}
