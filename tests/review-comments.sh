#!/usr/bin/env bash
# 驗收:變更檢視的行內評論與跨節點審查(假資料模式,不會啟動真正的 CLI)。
# 用法:在 app 資料夾執行 bash tests/review-comments.sh
# 測試版本庫、資料夾與截圖都放在系統暫存區裡這次專用的新資料夾,不會動到使用者的資料。
set -u
cd "$(dirname "$0")/.."
W="$(cygpath -u "${TEMP:-/tmp}")/nexus-review-comments-$$-$RANDOM"
mkdir -p "$W/repo" "$W/other" "$W/shots" "$W/profile"
echo "--- 測試資料夾:$W"
( cd "$W/repo" && git init -q -b main \
  && printf 'function greet(name) {\n  return "hi " + name;\n}\n\nconsole.log(greet("world"));\n\nfunction tail() {\n  return "old tail";\n}\n' > app.js \
  && printf 'line one\nline two\nline three\n' > notes.txt \
  && printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x01' > logo.png \
  && git add -A && git -c user.name=tester -c user.email=tester@example.com commit -q -m init )

# 截圖「1-task-started」出現時(任務已開始、快照已拍),修改檔案當作任務做的事
(
  for _ in $(seq 1 600); do [ -f "$W/shots/1-task-started.png" ] && break; sleep 0.1; done
  cd "$W/repo"
  printf 'function greet(name) {\n  // 打招呼\n  return `hi ${name}`;\n}\n\nconsole.log(greet("world"));\n' > app.js
  printf 'line one\nline three\n' > notes.txt
  printf '# 新檔案\n\n說明\n' > NEW.md
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\x02\x00' > logo.png
  echo "[wrapper] 已修改測試版本庫的檔案"
) &

for v in $(env | grep -oE '^(CLAUDE|ANTHROPIC)[A-Z_0-9]*'); do unset "$v"; done
export NEXUS_FAKE=1 NEXUS_FAKE_SNAPSHOT=1 NEXUS_NO_SEED=1 \
  NEXUS_DATA_DIR="$(cygpath -w "$W/profile")" NEXUS_TEST_DIR="$(cygpath -w "$W/shots")" \
  NEXUS_TEST_SCRIPT="$(pwd -W)/tests/review-comments.e2e.js" NEXUS_TEST_CWD="$(cygpath -w "$W/repo")"
timeout 240 ./node_modules/electron/dist/electron.exe . 2>&1 | grep -E "^\[test\]|^\[wrapper\]|rror" | cut -c1-2000
wait
echo "--- 截圖"; ls "$W/shots"
echo "--- 測試版本庫的狀態(審查者不應修改檔案;假資料節點本來就不會改)"; git -C "$W/repo" status --short
