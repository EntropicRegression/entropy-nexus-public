import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SpeechClipKind, SpeechNotice } from '../shared/types';

/**
 * 固定語音(語音播報的 clips 引擎):角色資料夾的 clips/ 裡預先錄好的短句,依事件挑一條播放。
 * 檔名是 <事件>.wav、<事件>.mp3,或 <事件>-<任意>.wav(同一事件可以放好幾條,播報時隨機挑一條)。
 * 這個檔案只用 node:fs,不依賴 Electron,單元測試可以直接載入。
 */

export const CLIP_MAX = 5 * 1024 * 1024;
// 和 shared/types.ts 的 SPEECH_CLIP_KINDS 相同;這裡只用型別匯入,讓 node 能直接載入這個檔案做單元測試
const KINDS: readonly SpeechClipKind[] = ['done', 'approval', 'question', 'failed', 'lost', 'quota'];
const NAME = /^([a-z]+)(?:-[^.]*)?\.(wav|mp3)$/i;

/** 一則通知要找哪些事件的固定語音(依序找,找到就用):失聯、額度沒有專屬錄音時改用一般的出錯。 */
export function clipKindsFor(n: SpeechNotice): SpeechClipKind[] {
  switch (n.kind) {
    case 'done': return ['done'];
    case 'approval': return ['approval'];
    case 'question': return ['question'];
    case 'failed': return n.reason === 'lost' ? ['lost', 'failed'] : n.reason === 'quota' || n.reason === 'budget' ? ['quota', 'failed'] : ['failed'];
  }
}

/** 列出 clips 資料夾裡各事件的檔案(完整路徑,依檔名排序);資料夾不存在時回傳空物件。太大或不是檔案的略過。 */
export function listClips(dir: string): Partial<Record<SpeechClipKind, string[]>> {
  const out: Partial<Record<SpeechClipKind, string[]>> = {};
  let names: string[];
  try { names = readdirSync(dir).sort((a, b) => a.localeCompare(b)); } catch { return out; }
  for (const name of names) {
    const m = NAME.exec(name);
    const kind = m?.[1].toLowerCase() as SpeechClipKind | undefined;
    if (!kind || !KINDS.includes(kind)) continue;
    const file = join(dir, name);
    try { const st = statSync(file); if (!st.isFile() || st.size <= 44 || st.size > CLIP_MAX) continue; } catch { continue; }
    (out[kind] ??= []).push(file);
  }
  return out;
}

/** 挑一條這則通知要播的固定語音;沒有對應的錄音時回傳 null。rand 給測試用。 */
export function pickClip(dir: string, n: SpeechNotice, rand: () => number = Math.random): string | null {
  const all = listClips(dir);
  for (const kind of clipKindsFor(n)) {
    const files = all[kind];
    if (files?.length) return files[Math.min(files.length - 1, Math.floor(rand() * files.length))];
  }
  return null;
}

export const clipMime = (file: string): string => (/\.mp3$/i.test(file) ? 'audio/mpeg' : 'audio/wav');
