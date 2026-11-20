// 驗收:語音播報的固定語音挑選(src/main/speech-clips.ts,只用 node:fs)。
// 用法:在 app 資料夾執行 node tests/speech-clips.test.mjs(Node 22.18 以上可直接載入 .ts)
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { clipKindsFor, clipMime, listClips, pickClip } from '../src/main/speech-clips.ts';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('[ok]', name); };
const base = { agentId: 'a', agentName: 'A', ts: 0 };
const N = {
  done: { ...base, kind: 'done', taskId: 't', summary: '好了' },
  approval: { ...base, kind: 'approval', requestId: 'r' },
  question: { ...base, kind: 'question', requestId: 'r' },
  error: { ...base, kind: 'failed', reason: 'error', queuePaused: false },
  lost: { ...base, kind: 'failed', reason: 'lost', queuePaused: false },
  quota: { ...base, kind: 'failed', reason: 'quota', queuePaused: true },
};

const dir = join(mkdtempSync(join(tmpdir(), 'nexus-clips-')), 'clips');
mkdirSync(dir);
const wav = Buffer.alloc(200, 1);
for (const f of ['done.wav', 'done-2.wav', 'DONE-cheer.WAV', 'approval.mp3', 'failed.wav', 'question.txt', 'other.wav', 'done-tiny.wav']) writeFileSync(join(dir, f), f === 'done-tiny.wav' ? Buffer.alloc(10) : wav);
mkdirSync(join(dir, 'question.wav')); // 資料夾,不是檔案

test('事件對應:失聯與額度沒有專屬錄音時改用出錯', () => {
  assert.deepEqual(clipKindsFor(N.done), ['done']);
  assert.deepEqual(clipKindsFor(N.error), ['failed']);
  assert.deepEqual(clipKindsFor(N.lost), ['lost', 'failed']);
  assert.deepEqual(clipKindsFor(N.quota), ['quota', 'failed']);
});

test('列出錄音:認得 <事件>.wav、<事件>-任意.wav、mp3、大小寫;略過其他檔名、資料夾和空檔', () => {
  const all = listClips(dir);
  assert.deepEqual(Object.keys(all).sort(), ['approval', 'done', 'failed']);
  assert.deepEqual(all.done.map(f => basename(f)).sort(), ['DONE-cheer.WAV', 'done-2.wav', 'done.wav'].sort());
  assert.equal(all.question, undefined);
});

test('挑選:同一事件多條時依亂數挑,邊界值不會超出', () => {
  const files = listClips(dir).done;
  assert.equal(pickClip(dir, N.done, () => 0), files[0]);
  assert.equal(pickClip(dir, N.done, () => 0.9999), files[files.length - 1]);
  assert.equal(pickClip(dir, N.done, () => 1), files[files.length - 1]);
});

test('挑選:失聯沒有 lost.wav 時用 failed.wav;沒有提問錄音時回傳 null', () => {
  assert.equal(basename(pickClip(dir, N.lost)), 'failed.wav');
  assert.equal(pickClip(dir, N.question), null);
  assert.equal(basename(pickClip(dir, N.approval)), 'approval.mp3');
});

test('資料夾不存在時回傳空的結果,不會丟錯', () => {
  assert.deepEqual(listClips(join(dir, 'nope')), {});
  assert.equal(pickClip(join(dir, 'nope'), N.done), null);
});

test('MIME:mp3 是 audio/mpeg,其他是 audio/wav', () => {
  assert.equal(clipMime('x/approval.mp3'), 'audio/mpeg');
  assert.equal(clipMime('x/done.WAV'), 'audio/wav');
});

console.log(`通過 ${passed} 項`);
