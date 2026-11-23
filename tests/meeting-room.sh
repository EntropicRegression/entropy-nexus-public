#!/usr/bin/env bash
# 會議室虛擬節點(任務清單 2-7)的驗收:假資料模式啟動主控台(tests/meeting-room.e2e.js 檢查主面板與旁聽視窗),
# 再由 tests/meeting-room-client.mjs 扮演節點的 CLI 開兩場會、讓主持人發言與散會。
# 兩個角色的頭像與立繪是這裡產生的純色小圖(不用任何真正的角色圖)。
# 用法:先 npm run build,再在 app 資料夾執行 bash tests/meeting-room.sh。不碰正式資料,也不消耗額度。
set -u
cd "$(dirname "$0")/.."
T="$(cygpath -u "$TEMP")/nexus-meeting-room-$$-$RANDOM"
mkdir -p "$T/shots" "$T/profile/portraits/RoomHost" "$T/profile/portraits/RoomP1" "$T/work"
# 純色 PNG(64×64):avatar 是主面板六角形裡的頭像,neutral 是對話視窗的立繪
mkpng() { node -e '
const zlib = require("zlib"), fs = require("fs");
const [file, hex] = process.argv.slice(1), W = 64, c = Buffer.from(hex, "hex"), raw = Buffer.alloc((W * 3 + 1) * W);
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) c.copy(raw, y * (W * 3 + 1) + 1 + x * 3);
const crc = b => { let r = ~0; for (const v of b) { r ^= v; for (let k = 0; k < 8; k++) r = r & 1 ? (r >>> 1) ^ 0xedb88320 : r >>> 1; } return ~r >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4), cr = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); cr.writeUInt32BE(crc(td)); return Buffer.concat([l, td, cr]); };
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(W, 4); ih[8] = 8; ih[9] = 2;
fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ih), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
' "$(cygpath -w "$1")" "$2"; }
for f in avatar neutral; do mkpng "$T/profile/portraits/RoomHost/$f.png" d9a441; mkpng "$T/profile/portraits/RoomP1/$f.png" 3f7fe6; done
PORT=$((40000 + RANDOM % 9000))
LOG="$T/run.log"
OUT="$T/result.txt"
export NEXUS_FAKE=1 NEXUS_FAKE_NO_ERRORS=1 NEXUS_NO_SEED=1 NEXUS_REMOTE_PORT=$PORT NEXUS_HOOKS_PORT=$((PORT + 1)) NEXUS_INTEROP_PORT=$((PORT + 2)) NEXUS_INTEROP_WAIT_MS=2500 \
  NEXUS_DATA_DIR="$(cygpath -w "$T/profile")" NEXUS_TEST_DIR="$(cygpath -w "$T/shots")" NEXUS_TEST_SCRIPT="$(pwd -W)/tests/meeting-room.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$T/work")"
timeout 300 ./node_modules/electron/dist/electron.exe . > "$LOG" 2>&1 &
APP=$!
node tests/meeting-room-client.mjs "$(cygpath -w "$LOG")" "$(cygpath -w "$T/profile")" 2>&1 | cut -c1-500 | tee "$OUT"
wait $APP
grep -E '^\[test\]' "$LOG" | grep -vE ' (READY|GO) ' | cut -c1-400 | tee -a "$OUT"
echo "暫存資料夾(含截圖):$T"
BAD=$(grep -cE '不符|失敗|等不到' "$OUT")
OK=$(grep -cE '通過' "$OUT")
if [ "$BAD" = 0 ] && [ "$OK" -gt 0 ] && grep -q '主控台端結束' "$OUT"; then echo "全部通過($OK 項)"; else echo "有 $BAD 項不符"; fi
