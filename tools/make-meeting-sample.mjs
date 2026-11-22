// 產生去識別的會議紀錄樣本:docs/memory-vault-app/會議紀錄樣本.md
// 用真正的 buildMeetingRecord + serializeFrontMatter 產生;內容全是虛構的(主題、節點、專案、時間、路徑)。
// 用法:node tools/make-meeting-sample.mjs(Node 22.18 以上可直接載入 .ts)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMeetingRecord, meetingRecordOf } from '../src/main/meeting-record.ts';
import { serializeFrontMatter } from '../src/main/memory-write.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'docs', 'memory-vault-app', '會議紀錄樣本.md');

// 和主控台實際散會時的資料同形(interop 的會議):參與者不含主持人;主持人的發言名稱是「名稱(主持人)」;
// 略過的參與者記成 round 0、名稱是該參與者;主持人結束時的結語成為「結論」,不再重複列在逐字紀錄裡。
const conclusion = '登入改用短效權杖,舊的工作階段 Cookie 保留兩週後移除。\n\n後續:織女補遷移腳本,天琴更新文件。';
const rec = buildMeetingRecord(meetingRecordOf({
  id: 'm-sample',
  topic: '星圖 App 的登入流程要不要改成權杖',
  callerId: 'node-orion', callerName: '獵戶',
  participants: [
    { id: 'node-vega', name: '織女' },
    { id: 'node-lyra', name: '天琴' },
    { id: 'node-castor', name: '北河、二號' },
  ],
  project: { id: 'c:/projects/star-app', name: 'star-app' },
  createdAt: Date.UTC(2031, 2, 14, 6, 0, 0),
  status: 'done',
  conclusion,
  transcript: [
    { round: 1, name: '織女', nodeId: 'node-vega', text: '可行。我看過設定檔 C:\\Users\\example\\Documents\\star app\\auth.config.json,逾時寫死在裡面,要先抽成設定。' },
    { round: 1, name: '天琴', nodeId: 'node-lyra', text: '文件那邊要同步改,相對路徑 docs/auth.md 之後也要補流程圖。' },
    { round: 1, name: '北河、二號', nodeId: 'node-castor', text: '同意。換裝置要重登是最多人抱怨的地方。' },
    { round: 1, name: '獵戶(主持人)', nodeId: 'node-orion', text: '第 2 輪請織女列出遷移步驟,其他人看有沒有風險。' },
    { round: 2, name: '織女', nodeId: 'node-vega', text: '## 遷移步驟\n\n1. 新增權杖表\n2. 雙寫兩週\n\n```ts\nexport const TOKEN_TTL_MS = 15 * 60 * 1000;\n```\n\n有沒有人反對?' },
    { round: 0, name: '天琴', nodeId: 'node-lyra', text: '(第 2 輪略過:目前在休眠)', inRound: 2 },
    { round: 2, name: '北河、二號', nodeId: 'node-castor', text: '沒有反對。(沒有需要補充的)' },
    { round: 2, name: '獵戶(主持人)', nodeId: 'node-orion', text: conclusion },
    { round: 0, name: '主控台', nodeId: null, text: '主持人結束了會議。' },
  ],
}, Date.UTC(2031, 2, 14, 6, 18, 42)));

// 第一行就是 ---(可以直接當解析測試的輸入);說明用的 HTML 註解放在檔尾
const text = serializeFrontMatter(rec.meta, true) + '\n' + rec.body
  + '\n<!-- 去識別樣本:內容全是虛構的。由 tools/make-meeting-sample.mjs 用 buildMeetingRecord 與 serializeFrontMatter 產生,請勿手改。 -->\n'
  + `<!-- 實際寫入的路徑:${rec.dir}/<日期>-<主題>.md -->\n`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log('已產生', out);
