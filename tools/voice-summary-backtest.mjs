// 語音摘要的回測:用本機資料庫裡真實的回覆跑一次規則摘要,產生報告給人看,並統計可以自動檢查的項目。
// 只讀取資料庫(唯讀連線),報告寫到暫存資料夾,不會進版本庫(裡面是你和 agent 的對話內容)。
//
// 用法:node tools/voice-summary-backtest.mjs [資料庫路徑] [--labels 標記檔.json]
//   資料庫預設是 %APPDATA%\entropy-nexus\nexus.db。
//   標記檔(選用)的格式:{ "<事件 seq>": { "must": ["必須念到的關鍵詞"], "mustNot": ["不能念出的內容"] } },
//   鍵是報告裡每一筆的 seq。有標記時會算核心資訊命中率。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_UNITS, speechUnits, summarizeForSpeech } from '../src/shared/speech-summary.ts';

const args = process.argv.slice(2);
const li = args.indexOf('--labels');
const labels = li >= 0 ? JSON.parse(readFileSync(args[li + 1], 'utf8')) : null;
const dbPath = args.find((a, i) => !a.startsWith('--') && i !== li + 1) ?? join(process.env.APPDATA ?? '', 'entropy-nexus', 'nexus.db');
const db = new DatabaseSync(dbPath, { readOnly: true });
const agents = Object.fromEntries(db.prepare('SELECT id, name, backend FROM agents').all().map(r => [r.id, r]));
const rows = db.prepare("SELECT seq, agent_id, type, payload FROM events WHERE type IN ('message', 'state') ORDER BY seq").all();

// 依節點切成回合:使用者訊息開始,回到待命(不是中斷)結束;只留有 agent 文字的回合
const open = new Map();
const turns = [];
for (const r of rows) {
  const e = JSON.parse(r.payload);
  const a = agents[r.agent_id];
  if (!a) continue;
  if (r.type === 'message' && e.role === 'user') open.set(r.agent_id, { seq: r.seq, prompt: e.text, texts: [] });
  else if (r.type === 'message' && e.role === 'agent') open.get(r.agent_id)?.texts.push(e.text);
  else if (r.type === 'state' && e.state === 'idle') {
    const t = open.get(r.agent_id);
    open.delete(r.agent_id);
    if (!t || !t.texts.length || e.detail === '已中斷' || e.outcome === 'interrupted') continue;
    // 節點互相呼叫與會議的回合不會播,略過
    if (/^\(主控台:這(則指令來自節點|是一場由節點)/.test(t.prompt)) continue;
    turns.push({ seq: t.seq, name: a.name, backend: a.backend, texts: t.texts.slice(-2) });
  }
}

const PATH = /(?:[A-Za-z]:\\|\\\\)[^\s]*|(?:[\w.-]+\/){2,}[\w.-]+/;
const FAIL = /(失敗|無法|錯誤|failed|error|cannot|can't)/i;
const OK = /(通過|完成|成功|已修|passed|fixed|done|succeeded)/i;
let nulls = 0, long = 0, paths = 0, flip = 0, hit = 0, labelled = 0;
const lines = ['# 語音摘要回測報告', '', `資料庫:${dbPath}`, `回合數:${turns.length}`, ''];
for (const t of turns) {
  const s = summarizeForSpeech(t.texts);
  const u = s ? speechUnits(s) : 0;
  if (!s) nulls++;
  if (u > MAX_UNITS) long++;
  if (s && PATH.test(s)) paths++;
  // 粗略的「失敗念成成功」:原文最後一則提到失敗、摘要卻只有成功字眼
  const last = t.texts[t.texts.length - 1];
  const suspect = s && FAIL.test(last) && !FAIL.test(s) && OK.test(s);
  if (suspect) flip++;
  const lab = labels?.[t.seq];
  let mark = '';
  if (lab) {
    labelled++;
    const good = (lab.must ?? []).every(k => s?.includes(k)) && !(lab.mustNot ?? []).some(k => s?.includes(k));
    if (good) hit++;
    mark = good ? '(標記:命中)' : '(標記:沒命中)';
  }
  lines.push(`## seq ${t.seq} · ${t.name}(${t.backend})${suspect ? ' ⚠ 可能把失敗念成成功' : ''}${mark}`, '',
    `**摘要**(${u} 單位):${s ?? '(固定完成通知)'}`, '', '<details><summary>原文</summary>', '', '```text', last.slice(0, 3000), '```', '', '</details>', '');
}
const n = turns.length || 1;
const stat = [
  `回合 ${turns.length}`,
  `固定完成通知(找不到可念的句子)${nulls}(${Math.round(nulls / n * 100)}%)`,
  `超過 ${MAX_UNITS} 單位 ${long}(${Math.round(long / n * 100)}%)`,
  `摘要含路徑 ${paths}`,
  `可能把失敗念成成功 ${flip}(需要人工確認)`,
  labels ? `標記命中率 ${labelled ? Math.round(hit / labelled * 100) : 0}%(${hit}/${labelled})` : '沒有標記檔,未計算命中率',
];
lines.splice(4, 0, ...stat.map(x => `- ${x}`), '');
const dir = join(tmpdir(), 'nexus-voice-backtest');
mkdirSync(dir, { recursive: true });
const out = join(dir, 'report.md');
writeFileSync(out, lines.join('\n'));
console.log(stat.join('\n'));
console.log(`報告:${out}`);
