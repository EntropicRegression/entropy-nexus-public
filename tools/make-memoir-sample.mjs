// 產生去識別的回憶錄樣本:docs/memory-vault-app/回憶錄樣本.md
// 用真正的 parseMemoir + writeMemoir 寫進一個暫存記憶庫,再把寫出來的檔案原封不動複製過來(和主控台實際寫入的檔案逐位元組相同);
// 內容全是虛構的(節點、ID、日期、路徑)。樣本檔只放真實輸出,說明寫在 docs/memory-vault-app/樣本說明.md。
// 用法:node tools/make-memoir-sample.mjs(Node 22.18 以上可直接載入 .ts)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemoir, writeMemoir } from '../src/main/memoir.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'memory-vault-app', '回憶錄樣本.md');

// 和節點實際用 memory_draft(kind memoir)提交的參數同形;節點填的身分欄位會被忽略,由主控台依提交者填
const sub = parseMemoir({
  kind: 'memoir',
  title: '第一次接手星圖 App 的登入改版',
  period: '2031-03-14/2031-03-16',
  節點ID: 'node-someone-else',
  content: [
    '這三天我主要在處理星圖 App 的登入流程。使用者一開始只說「換裝置要重登太煩」,我先讀了 src/auth/session.ts,以為是 Cookie 逾時設太短,改了之後才發現真正的原因是權杖沒有跨裝置同步。',
    '',
    '第二天主持了一場短會,織女提出遷移步驟,天琴負責文件。我那時太急著定案,沒有先問北河二號的意見,後來他補充的風險(舊版 App 還會送舊 Cookie)差點被漏掉。',
    '',
    '學到的事:',
    '',
    '1. 使用者描述的是症狀,先確認原因再動手。',
    '2. 開會時每個人都要問到,不要只聽第一個提案。',
    '',
    '我當時把測試用的設定放在 C:\\Users\\example\\star-app\\.env,裡面的 api_key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456 已經請使用者作廢。',
    '',
    '## **來源**:',
    '',
    '- 這個 session 裡和使用者的對話(2031-03-14 到 2031-03-16)',
    '- 會議紀錄:meetings/star-app/2031-03-14-星圖 App 的登入流程要不要改成權杖.md',
    '- 任務:改登入逾時、補遷移腳本',
    '',
    '## 不確定之處',
    '',
    '- 北河二號提醒舊 Cookie 的時間,我記得是第二天下午,但不確定。',
  ].join('\n'),
});
// 標題故意寫成「## **來源**:」:主控台寬鬆接受,寫進檔案時改成標準的「## 來源」
const vault = mkdtempSync(join(tmpdir(), 'nexus-memoir-sample-'));
try {
  const res = writeMemoir(vault, { ...sub, nodeId: 'node-orion', nodeName: '獵戶', backendLabel: 'Claude Code', now: new Date(2031, 2, 16, 21, 4, 9) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, readFileSync(join(vault, ...res.path.split('/'))));
  console.log('已產生', out, '(實際寫入的路徑:', res.path + ')');
} finally {
  rmSync(vault, { recursive: true, force: true });
}
