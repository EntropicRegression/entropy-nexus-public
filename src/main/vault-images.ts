import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';

/**
 * 角色圖像的檔案查找與封存快照(不依賴 Electron,單元測試可以直接載入)。
 * 頭像:avatar、chibi_avatar(png、webp、jpg);立繪:neutral。和 portraits.ts 的規則一致,只是這裡回傳檔案路徑。
 */
const EXTS = ['png', 'webp', 'jpg', 'jpeg'];
const AVATAR_NAMES = ['avatar', 'chibi_avatar'];

/** 角色名稱就是立繪資料夾底下一層資料夾名稱;擋掉會跳出資料夾的名稱。 */
const validCharacter = (c: string): boolean => !!c && c.length <= 80 && c !== '.' && c !== '..' && !/[\/:*?"<>|\x00-\x1f]/.test(c);

export interface CharacterImages { avatar: string | null; portrait: string | null }

/** 角色的頭像與 neutral 立繪的絕對路徑;沒有角色、沒有圖檔就是 null。 */
export function characterImages(portraitsRoot: string, character: string): CharacterImages {
  const out: CharacterImages = { avatar: null, portrait: null };
  const c = String(character ?? '').trim();
  if (!portraitsRoot || !validCharacter(c)) return out;
  const hit = (names: string[]): string | null => {
    for (const n of names) for (const ext of EXTS) { const p = join(portraitsRoot, c, `${n}.${ext}`); if (existsSync(p)) return p; }
    return null;
  };
  out.avatar = hit(AVATAR_NAMES);
  out.portrait = hit(['neutral']);
  return out;
}

/** 封存的圖像快照資料夾(相對於記憶庫);名稱裡的路徑字元一律去掉。 */
export const IMAGE_DIR = 'nodes/封存/_圖像';
export const snapshotDir = (nodeId: string): string => `${IMAGE_DIR}/${String(nodeId).replace(/[\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '_')}`;

/**
 * 把頭像與立繪複製到記憶庫的 nodes/封存/_圖像/<節點ID>/(檔名 avatar.<副檔名>、portrait.<副檔名>;重複封存會覆蓋)。
 * 回傳相對於記憶庫的路徑;沒有圖或複製失敗的欄位是 null。
 */
export function snapshotImages(vault: string, nodeId: string, images: CharacterImages): CharacterImages {
  const out: CharacterImages = { avatar: null, portrait: null };
  const dir = snapshotDir(nodeId);
  for (const [key, label] of [['avatar', 'avatar'], ['portrait', 'portrait']] as const) {
    const src = images[key];
    if (!src || !existsSync(src)) continue;
    try {
      mkdirSync(join(vault, ...dir.split('/')), { recursive: true });
      const name = `${label}${extname(src).toLowerCase()}`;
      copyFileSync(src, join(vault, ...dir.split('/'), name));
      out[key] = `${dir}/${name}`;
    } catch { /* 複製失敗就不寫這個欄位 */ }
  }
  return out;
}
