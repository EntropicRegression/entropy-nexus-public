"""Entropy Nexus 語音服務(實驗性):語音轉文字(Phase 1),以及選用的語音合成(Phase 3)。

由主控台(src/main/voice.ts)啟動,用環境變數拿到設定:
  NEXUS_VOICE_PORT        要聆聽的連接埠(必要,主控台每次挑一個空的)
  NEXUS_VOICE_TOKEN       權杖;每個請求都要帶 Authorization: Bearer <權杖>(必要)
  NEXUS_VOICE_PARENT_PID  主控台的行程 id;主控台不在了就自己結束,避免留下佔著顯示卡記憶體的行程
  NEXUS_VOICE_MODEL       faster-whisper 的模型名稱或資料夾,預設 large-v3-turbo
  NEXUS_VOICE_DEVICE      auto(預設)、cuda 或 cpu
  NEXUS_VOICE_COMPUTE     計算精度;預設 cuda 用 int8_float16,cpu 用 int8
  NEXUS_VOICE_TTS_DIR     選用:CosyVoice repo 資料夾;有設定才啟用語音合成(見 tts_cosyvoice.py)
  NEXUS_VOICE_TTS_MODEL   選用:CosyVoice 2 模型資料夾,預設 <repo>/pretrained_models/CosyVoice2-0.5B

只用 Python 標準函式庫加 faster-whisper(numpy 是它的相依套件),不需要 FastAPI。
只聽 127.0.0.1,而且只接受 Host 是 127.0.0.1 或 localhost 的請求,避免瀏覽器裡的網頁借道送請求進來。

端點:
  GET  /health      {"status": "warming_up" | "ready" | "error", "model", "device", "error", "pid",
                     "tts": {"status": "off" | "warming_up" | "ready" | "unloaded" | "error", "error", "sampleRate", "vramMB"}}
  POST /transcribe  內容是 16 kHz、16-bit、單聲道的 WAV;標頭 X-Voice-Prompt(URL 編碼)可帶提示詞,
                    例如節點名稱,幫助辨識專有名詞。回傳 {"text", "audioMs", "durationMs", "language"}
  POST /tts         JSON {"text", "wav"(參考錄音的路徑), "promptText"(錄音的內容,可省略,省略時自動辨識), "style"(語氣指令,可省略),
                    "language"(參考錄音的語言 zh/en,只用在自動辨識逐字稿,預設 zh)};
                    回傳 16-bit 單聲道 WAV(取樣率見 health 的 tts.sampleRate),標頭 X-Voice-Ms 是合成耗時
  POST /tts/unload  手動卸載語音合成、釋放顯示卡記憶體(語音辨識照常);回傳 {"tts": ...}
  POST /tts/load    重新載入語音合成(背景載入,查 health 的 tts.status);回傳 {"tts": ...}
  POST /translate   JSON {"text", "from": "zh", "to": "en"} → {"text"};英文語音播報翻譯完成摘要用(選用,見 mt_opus.py),沒有模型時回 503。
"""
from __future__ import annotations

import gc
import hmac
import io
import json
import os
import sys
import threading
import time
import urllib.parse
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("NEXUS_VOICE_PORT", "0"))
TOKEN = os.environ.get("NEXUS_VOICE_TOKEN", "")
PARENT = int(os.environ.get("NEXUS_VOICE_PARENT_PID", "0") or 0)
MODEL = os.environ.get("NEXUS_VOICE_MODEL", "").strip() or "large-v3-turbo"
DEVICE = os.environ.get("NEXUS_VOICE_DEVICE", "").strip() or "auto"
COMPUTE = os.environ.get("NEXUS_VOICE_COMPUTE", "").strip()
MAX_BODY = 4 * 1024 * 1024  # 約兩分鐘的 16 kHz 單聲道 16-bit 音訊
MAX_SECONDS = 120
# Whisper 對中文常輸出簡體字;用繁體的提示詞把它帶往繁體輸出。裝了 OpenCC 時再轉一次台灣用字。
ZH_HINT = "以下是台灣華語的句子,使用繁體中文。"

state = {"status": "warming_up", "error": "", "device": "", "model": MODEL}
model = None
TTS_DIR = os.environ.get("NEXUS_VOICE_TTS_DIR", "").strip()
if TTS_DIR:
    # faster-whisper(CTranslate2)與 PyTorch 各帶一份 OpenMP(libiomp5md.dll),同一個行程同時載入時
    # Intel OpenMP 會直接結束行程;這是兩者並用時的通行做法(實測辨識與合成結果正常)
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
TTS_MODEL = os.environ.get("NEXUS_VOICE_TTS_MODEL", "").strip() or (os.path.join(TTS_DIR, "pretrained_models", "CosyVoice2-0.5B") if TTS_DIR else "")
# status:off 沒有設定、warming_up 載入中、ready 可以用、unloaded 使用者手動卸載(釋放顯示卡記憶體)、error 失敗
# vramMB:語音合成載入後 PyTorch 佔用的顯示卡記憶體(MB),卸載後應該接近 0
tts_state = {"status": "warming_up" if TTS_DIR else "off", "error": "", "sampleRate": 0, "vramMB": 0}
tts_switch = threading.Lock()  # 載入與卸載不同時進行
tts = None
# 參考錄音的內容文字(沒有 voice.txt 時自動辨識一次);鍵是 (路徑, 修改時間)
prompt_cache: dict = {}
# 中翻英(英文語音播報,選用):沒有模型資料夾時 status 是 off,/translate 回 503。python -I 不會把腳本所在的資料夾放進 sys.path
if os.path.dirname(os.path.abspath(__file__)) not in sys.path:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mt_opus import OpusMt  # noqa: E402

mt = OpusMt()
lock = threading.Lock()  # 一次只跑一段辨識,避免同時佔用顯示卡

try:  # 選用:pip install opencc-python-reimplemented
    from opencc import OpenCC  # type: ignore

    # 只轉字形(s2tw),不換詞彙:s2twp 會把「通过」換成「透過」,在「測試通過」這類句子是錯的
    _cc = OpenCC("s2tw")
    to_tw = _cc.convert
except Exception:  # noqa: BLE001 沒裝就不轉
    to_tw = None


def log(*args: object) -> None:
    # 主控台被強制關閉後輸出管線就斷了,寫不出去也不能讓呼叫的執行緒跟著出錯
    try:
        print("[voice]", *args, flush=True)
    except Exception:  # noqa: BLE001
        pass


def add_cuda_dlls() -> None:
    """Windows:faster-whisper 的 GPU 版需要 cuBLAS 與 cuDNN 的 DLL。
    用 pip 裝了 nvidia-cublas-cu12 與 nvidia-cudnn-cu12 時,把它們的 bin 資料夾加進 DLL 搜尋路徑。"""
    if sys.platform != "win32":
        return
    import site

    roots = [*site.getsitepackages(), site.getusersitepackages()]
    for root in roots:
        for sub in ("cublas", "cudnn", "cuda_nvrtc"):
            d = os.path.join(root, "nvidia", sub, "bin")
            if os.path.isdir(d):
                os.add_dll_directory(d)
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def load_model() -> None:
    global model
    try:
        add_cuda_dlls()
        from faster_whisper import WhisperModel

        tries = []
        if DEVICE in ("auto", "cuda"):
            tries.append(("cuda", COMPUTE or "int8_float16"))
        if DEVICE in ("auto", "cpu"):
            tries.append(("cpu", COMPUTE or "int8"))
        last = None
        for device, compute in tries:
            try:
                t0 = time.time()
                m = WhisperModel(MODEL, device=device, compute_type=compute)
                # 先跑一小段靜音,讓 CUDA 與 cuDNN 在第一個真正的請求之前就載入完成
                import numpy as np

                list(m.transcribe(np.zeros(16000, dtype=np.float32), language="zh")[0])
                model = m
                state.update(status="ready", device=f"{device}/{compute}", error="")
                log(f"模型 {MODEL} 已載入({device}/{compute},{time.time() - t0:.1f} 秒)")
                log("READY")
                return
            except Exception as err:  # noqa: BLE001 換下一種裝置再試
                last = err
                log(f"{device}/{compute} 載入失敗:{err}")
        raise RuntimeError(str(last))
    except Exception as err:  # noqa: BLE001
        state.update(status="error", error=f"模型載入失敗:{err}")
        log(state["error"])


def vram_mb() -> int:
    """PyTorch 目前向顯示卡保留的記憶體(MB);沒有載入 torch 或沒有 CUDA 時是 0。"""
    torch = sys.modules.get("torch")
    try:
        return round(torch.cuda.memory_reserved() / 1048576) if torch is not None and torch.cuda.is_available() else 0
    except Exception:  # noqa: BLE001
        return 0


def load_tts() -> None:
    global tts
    if not TTS_DIR:
        return
    with tts_switch:
        if tts is not None:
            return
        tts_state.update(status="warming_up", error="")
        try:
            # python -I 不會把腳本所在的資料夾放進 sys.path
            here = os.path.dirname(os.path.abspath(__file__))
            if here not in sys.path:
                sys.path.insert(0, here)
            from tts_cosyvoice import CosyVoiceEngine

            t0 = time.time()
            tts = CosyVoiceEngine(TTS_DIR, TTS_MODEL)
            tts_state.update(status="ready", error="", sampleRate=tts.sample_rate, vramMB=vram_mb())
            log(f"語音合成已載入(CosyVoice 2,{tts.device},{time.time() - t0:.1f} 秒,顯示卡記憶體 {tts_state['vramMB']} MB)")
        except Exception as err:  # noqa: BLE001
            tts_state.update(status="error", error=f"語音合成載入失敗:{err}", vramMB=vram_mb())
            log(tts_state["error"])


def unload_tts() -> None:
    """手動卸載語音合成,釋放顯示卡記憶體;正在合成的那一句會先做完。語音辨識不受影響。"""
    global tts
    with tts_switch:
        engine = tts
        if engine is None:
            if tts_state["status"] in ("ready", "error"):
                tts_state.update(status="unloaded", error="")
            return
        tts_state.update(status="unloaded", error="")
        tts = None
        with engine.lock:  # 等正在進行的合成結束
            pass
        del engine
        gc.collect()
        torch = sys.modules.get("torch")
        try:
            if torch is not None and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        tts_state.update(vramMB=vram_mb())
        log(f"語音合成已卸載,顯示卡記憶體剩 {tts_state['vramMB']} MB")


def to_wav(audio, rate: int) -> bytes:
    import numpy as np

    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def prompt_text_of(path: str, language: str = "zh") -> str:
    """參考錄音說了什麼;CosyVoice 的 zero-shot 需要它。用 Whisper 辨識一次並快取。
    language:錄音的語言(英文播報的 voice.en.wav 要用 en 辨識,否則會被當成中文辨識成錯的內容)。"""
    key = (path, os.path.getmtime(path), language)
    if key in prompt_cache:
        return prompt_cache[key]
    if model is None:
        raise ValueError("參考錄音沒有附上內容文字(voice.txt),語音轉文字的模型也還沒載入")
    with open(path, "rb") as f:
        data = f.read()
    text = transcribe(data, "", language)["text"]
    prompt_cache[key] = text
    log(f"參考錄音的內容:{text}")
    return text


def synthesize(body: dict) -> tuple[bytes, int]:
    text = str(body.get("text") or "").strip()[:500]
    ref = str(body.get("wav") or "")
    if not text:
        raise ValueError("沒有要念的文字")
    if not ref.lower().endswith(".wav") or not os.path.isfile(ref):
        raise ValueError("找不到參考錄音")
    style = str(body.get("style") or "").strip()[:200]
    language = "en" if body.get("language") == "en" else "zh"
    prompt = str(body.get("promptText") or "").strip()[:500] or ("" if style else prompt_text_of(ref, language))
    t0 = time.time()
    engine = tts
    if engine is None:
        raise RuntimeError("語音合成已卸載")
    audio, rate = engine.synth(text, ref, prompt, style)
    return to_wav(audio, rate), round((time.time() - t0) * 1000)


def read_wav(data: bytes):
    import numpy as np

    with wave.open(io.BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError("只接受 16-bit PCM 的 WAV")
        rate, channels, frames = w.getframerate(), w.getnchannels(), w.getnframes()
        if frames / max(rate, 1) > MAX_SECONDS:
            raise ValueError(f"錄音超過 {MAX_SECONDS} 秒")
        pcm = np.frombuffer(w.readframes(frames), dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # 簡單的線性重取樣;畫面送來的本來就是 16 kHz,這裡只是保險
        n = int(len(pcm) * 16000 / rate)
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


def transcribe(data: bytes, prompt: str, language: str = "zh") -> dict:
    """語音轉文字。聽寫(/transcribe)一律是中文;language 只給參考錄音補逐字稿用(en 時不加中文提示、不轉繁體)。"""
    audio = read_wav(data)
    t0 = time.time()
    en = language == "en"
    with lock:
        segments, info = model.transcribe(
            audio,
            language="en" if en else "zh",
            initial_prompt=(prompt if en else f"{ZH_HINT}{prompt}").strip() or None,
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        text = "".join(s.text for s in segments).strip()
    if to_tw and not en:
        text = to_tw(text)
    return {"text": text, "audioMs": round(len(audio) / 16), "durationMs": round((time.time() - t0) * 1000), "language": info.language}


class Handler(BaseHTTPRequestHandler):
    server_version = "EntropyNexusVoice/1"

    def log_message(self, fmt: str, *args: object) -> None:  # 不印每一個請求
        pass

    def send_json(self, code: int, body: dict) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def allowed(self) -> bool:
        host = (self.headers.get("Host") or "").rsplit(":", 1)[0]
        auth = self.headers.get("Authorization") or ""
        if host not in ("127.0.0.1", "localhost") or not hmac.compare_digest(auth.encode(), f"Bearer {TOKEN}".encode()):
            self.send_json(404, {"error": "not found"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self.allowed():
            return
        if self.path == "/health":
            self.send_json(200, {**state, "pid": os.getpid(), "tts": tts_state, "mt": {"status": mt.status, "error": mt.error}})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.allowed():
            return
        if self.path == "/tts":
            self.do_tts()
            return
        if self.path == "/translate":
            self.do_translate()
            return
        if self.path in ("/tts/unload", "/tts/load"):
            if not TTS_DIR:
                self.send_json(409, {"error": "沒有設定語音合成"})
                return
            if self.path == "/tts/unload":
                unload_tts()
            elif tts is None and tts_state["status"] != "warming_up":
                tts_state.update(status="warming_up", error="")
                threading.Thread(target=load_tts, daemon=True).start()
            self.send_json(200, {"tts": tts_state})
            return
        if self.path != "/transcribe":
            self.send_json(404, {"error": "not found"})
            return
        if state["status"] != "ready":
            self.send_json(503, {"error": "模型還在載入" if state["status"] == "warming_up" else state["error"]})
            return
        size = int(self.headers.get("Content-Length") or 0)
        if size <= 44 or size > MAX_BODY:
            self.send_json(413, {"error": "錄音太短或太長"})
            return
        data = self.rfile.read(size)
        prompt = urllib.parse.unquote(self.headers.get("X-Voice-Prompt") or "")[:500]
        try:
            self.send_json(200, transcribe(data, prompt))
        except ValueError as err:
            self.send_json(400, {"error": str(err)})
        except Exception as err:  # noqa: BLE001
            log("辨識失敗:", err)
            self.send_json(500, {"error": f"辨識失敗:{err}"})


def _tts_handler(self) -> None:
    if tts_state["status"] != "ready":
        st = tts_state["status"]
        self.send_json(503, {"error": "語音合成沒有啟用" if st == "off" else "語音合成還在載入" if st == "warming_up" else "語音合成已卸載" if st == "unloaded" else tts_state["error"]})
        return
    size = int(self.headers.get("Content-Length") or 0)
    if size <= 0 or size > 64 * 1024:
        self.send_json(413, {"error": "請求太大"})
        return
    try:
        body = json.loads(self.rfile.read(size).decode("utf-8"))
        wav, ms = synthesize(body if isinstance(body, dict) else {})
    except ValueError as err:
        self.send_json(400, {"error": str(err)})
        return
    except RuntimeError as err:
        self.send_json(503, {"error": str(err)})
        return
    except Exception as err:  # noqa: BLE001
        log("合成失敗:", err)
        self.send_json(500, {"error": f"合成失敗:{err}"})
        return
    self.send_response(200)
    self.send_header("Content-Type", "audio/wav")
    self.send_header("Content-Length", str(len(wav)))
    self.send_header("X-Voice-Ms", str(ms))
    self.send_header("Cache-Control", "no-store")
    self.end_headers()
    self.wfile.write(wav)


Handler.do_tts = _tts_handler  # type: ignore[attr-defined]


def _translate_handler(self) -> None:
    size = int(self.headers.get("Content-Length") or 0)
    if size <= 0 or size > 16 * 1024:
        self.send_json(413, {"error": "請求太大"})
        return
    try:
        raw = json.loads(self.rfile.read(size).decode("utf-8"))
        body = raw if isinstance(raw, dict) else {}
        text = str(body.get("text") or "").strip()[:500]
        if not text or body.get("from", "zh") != "zh" or body.get("to", "en") != "en":
            raise ValueError("只支援中翻英,而且要有文字")
        self.send_json(200, {"text": mt.translate(text)})
    except ValueError as err:
        self.send_json(400, {"error": str(err)})
    except RuntimeError as err:
        self.send_json(503, {"error": str(err)})
    except Exception as err:  # noqa: BLE001
        log("翻譯失敗:", err)
        self.send_json(500, {"error": f"翻譯失敗:{err}"})


Handler.do_translate = _translate_handler  # type: ignore[attr-defined]


def parent_alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not h:
            return False
        try:
            return k32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT:還在執行
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def watch_parent() -> None:
    while True:
        time.sleep(2)
        try:
            alive = parent_alive(PARENT)
        except Exception:  # noqa: BLE001 查不了就當作還在,下一輪再查
            alive = True
        if not alive:
            log("主控台已經結束,語音服務跟著結束")
            os._exit(0)


def main() -> None:
    # Windows 的主控台預設是 cp950;主控台讀 log 時用 UTF-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001
            pass
    if not PORT or not TOKEN:
        print("請由 Entropy Nexus 主控台啟動(缺少 NEXUS_VOICE_PORT 或 NEXUS_VOICE_TOKEN)", file=sys.stderr)
        sys.exit(2)
    if PARENT:
        threading.Thread(target=watch_parent, daemon=True).start()
        log(f"監看主控台行程 {PARENT}")
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"聆聽 127.0.0.1:{PORT},載入模型 {MODEL}…")
    threading.Thread(target=lambda: (load_model(), load_tts()), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
