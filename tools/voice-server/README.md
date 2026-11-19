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

## 語音合成:節點自己的聲音(選用,Phase 3)

用 [CosyVoice 2](https://github.com/FunAudioLLM/CosyVoice)(Apache-2.0)模仿參考錄音的聲音,念語音播報。沒有設定時,播報用系統語音。

**限制**:

- 繁體字會先轉成簡體再交給 CosyVoice;沒有裝 OpenCC 時,繁體字常被念錯。
- 英文名字(例如節點名稱 Hagemi)的發音不太準。

**效能**(RTX 4060 Ti 實測):

- 語音辨識和語音合成可以放在同一個服務。兩個模型一起常駐,顯示卡記憶體多用約 4.6 GB。
- 一句播報約 3 到 5 秒合成完。服務啟動時載入約 17 秒。
- 合成超過 15 秒或失敗時,改用系統語音。

**安裝**(Windows,Python 3.11;在獨立資料夾裝,不影響全域的 Python):

```bash
cd %LOCALAPPDATA%\entropy-nexus-tts      # 自己選一個資料夾
python -m venv venv
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
venv/Scripts/python -m pip install -U pip wheel setuptools
venv/Scripts/python -m pip install torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cu121
grep -v -E '^(--|torch|deepspeed|tensorrt|onnxruntime-gpu|openai-whisper|gradio|fastapi|grpcio|tensorboard|matplotlib|gdown|wget|pyworld)' CosyVoice/requirements.txt > req-win.txt
venv/Scripts/python -m pip install -r req-win.txt --extra-index-url https://download.pytorch.org/whl/cu121
venv/Scripts/python -m pip install pyworld==0.3.4 tiktoken gdown wget matplotlib==3.7.5
venv/Scripts/python -m pip install --no-deps --no-build-isolation openai-whisper==20231117
# 語音辨識也在同一個服務裡跑:CTranslate2 要用 4.4(配合 PyTorch 2.3 的 cuDNN 8)
venv/Scripts/python -m pip install "ctranslate2==4.4.0" "faster-whisper==1.1.1"
# 必要:CosyVoice 2 主要用簡體中文訓練,繁體字會被念錯,服務會先轉成簡體
venv/Scripts/python -m pip install opencc-python-reimplemented
```

**安裝說明:**

- 以下套件在 Windows 上跳過:`ttsfrd`、`deepspeed`、`tensorrt`、`onnxruntime-gpu`(改用 CPU 版的 `onnxruntime`)。文字正規化改用 `wetext`。
- `wetext` 第一次執行時,會把一個小模型下載到 `%USERPROFILE%\.cache\modelscope`。
- faster-whisper 和 PyTorch 各帶一份 OpenMP;同一個服務同時載入兩者時,服務會自動設定 `KMP_DUPLICATE_LIB_OK=TRUE`。

**模型**:下載 CosyVoice2-0.5B,約 4.4 GB。

- 放到 `CosyVoice\pretrained_models\CosyVoice2-0.5B`。
- 可以用 ModelScope 下載:`modelscope.snapshot_download('iic/CosyVoice2-0.5B', local_dir=...)`,在台灣通常很慢。
- 也可以從 Hugging Face `FunAudioLLM/CosyVoice2-0.5B` 下載,同時開幾個連線會比較快。

**在主控台啟用:**

1. 語音設定面板的「啟動指令」填 `"<資料夾>\venv\Scripts\python.exe" "<專案>\tools\voice-server\server.py"`。
2. 「CosyVoice 資料夾」填 `<資料夾>\CosyVoice`。
3. 按「儲存」,狀態會顯示「語音合成:可以使用」。

**每個角色的聲音**:最方便的是在主控台角色卡底下的「聲音」區塊錄音或選檔,也可以自己把檔案放在立繪資料夾的 `<角色>\` 底下。

- `voice.wav`:參考錄音。建議 3 到 10 秒、16-bit、只有一個人說話、沒有背景音。
- `voice.txt`(選用):錄音說的內容。沒有的話,服務會自動辨識一次。**內容一定要和錄音實際念的一致**,差一兩個字,模仿出來的發音就可能整句亂掉。用其他語音合成生成的參考音,常常和原本給它的文字不一樣,請先播放確認,或用「自動辨識內容」。
- `style.txt`(選用):語氣指令,例如「用活潑、甜美的語氣說」。有這個檔案時,改用 instruct 模式合成。
- 只用自己錄的聲音,或取得本人同意的聲音。不要用動畫、遊戲角色或配音員的錄音片段。

驗收:`bash tests/voice-tts.sh`。
