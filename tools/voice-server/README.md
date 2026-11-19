# Entropy Nexus 語音服務(實驗性)

語音模式 Phase 1:對話視窗的「說話」按鈕按住說話,放開後由這個本機服務把語音轉成文字,填進輸入框,由你確認後自己送出。

- 全部在本機執行,語音不會上傳到網路。
- 不會自動送出指令,也不能用語音回覆授權。
- 服務由主控台啟動與結束;主控台被強制關閉時,服務也會在幾秒內自己結束。

## 準備

1. 安裝 Python 3.10 以上。
2. 安裝套件:

   ```bash
   pip install -r tools/voice-server/requirements.txt
   ```

3. 用 NVIDIA 顯示卡加速(建議):faster-whisper 的 GPU 版需要 cuBLAS 與 cuDNN。沒有另外安裝 CUDA Toolkit 時,執行下面這行,服務會自動找到它們:

   ```bash
   pip install nvidia-cublas-cu12 "nvidia-cudnn-cu12==9.*"
   ```

   沒有裝也能用,只是會改用 CPU,一句話要等好幾秒。設定面板的狀態會顯示實際使用的裝置,例如 `cuda/int8_float16` 或 `cpu/int8`。

4. 選用:要讓輸出改成台灣用字,可以加裝 `pip install opencc-python-reimplemented`。

第一次啟動會從 Hugging Face 下載模型。預設的 large-v3-turbo 約 1.6 GB,之後會留在快取裡。

## 在主控台啟用

1. 按頂部的「語音」,勾選「啟用語音模式」。
2. 啟動指令留白,就會用預設的 `python "<專案>/tools/voice-server/server.py"`。安裝版找不到這個檔案,要自己填完整的指令,例如 `C:\venv\Scripts\python.exe "C:\路徑\server.py"`。
3. 模型留白會用 `large-v3-turbo`。也可以填其他 faster-whisper 模型名稱,或已轉換好的模型資料夾路徑。
4. 狀態變成「可以使用」之後,對話視窗的輸入框旁就會出現「說話」按鈕。

## 介面

主控台用環境變數傳設定:`NEXUS_VOICE_PORT`、`NEXUS_VOICE_TOKEN`、`NEXUS_VOICE_PARENT_PID`、`NEXUS_VOICE_MODEL`、`NEXUS_VOICE_DEVICE`(auto、cuda、cpu)、`NEXUS_VOICE_COMPUTE`。

服務只聽 `127.0.0.1`,只接受 Host 是 `127.0.0.1` 或 `localhost` 的請求,而且每個請求都要帶 `Authorization: Bearer <權杖>`。

- `GET /health`:回傳 `{ status: "warming_up" | "ready" | "error", model, device, error, pid }`。
- `POST /transcribe`:內容是 16 kHz、16-bit、單聲道的 WAV,最長 120 秒。標頭 `X-Voice-Prompt`(URL 編碼)可以帶提示詞,主控台會放入節點名稱。回傳 `{ text, audioMs, durationMs, language }`。

驗收:`bash tests/voice.sh`。需要上面的 Python 環境;可以用 `NEXUS_VOICE_MODEL` 指定已經下載的模型。
