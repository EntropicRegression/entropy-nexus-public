"""Entropy Nexus 語音服務(實驗性,Phase 1:只做語音轉文字)。

由主控台(src/main/voice.ts)啟動,用環境變數拿到設定:
  NEXUS_VOICE_PORT        要聆聽的連接埠(必要,主控台每次挑一個空的)
  NEXUS_VOICE_TOKEN       權杖;每個請求都要帶 Authorization: Bearer <權杖>(必要)
  NEXUS_VOICE_PARENT_PID  主控台的行程 id;主控台不在了就自己結束,避免留下佔著顯示卡記憶體的行程
  NEXUS_VOICE_MODEL       faster-whisper 的模型名稱或資料夾,預設 large-v3-turbo
  NEXUS_VOICE_DEVICE      auto(預設)、cuda 或 cpu
  NEXUS_VOICE_COMPUTE     計算精度;預設 cuda 用 int8_float16,cpu 用 int8

只用 Python 標準函式庫加 faster-whisper(numpy 是它的相依套件),不需要 FastAPI。
只聽 127.0.0.1,而且只接受 Host 是 127.0.0.1 或 localhost 的請求,避免瀏覽器裡的網頁借道送請求進來。

端點:
  GET  /health      {"status": "warming_up" | "ready" | "error", "model", "device", "error", "pid"}
  POST /transcribe  內容是 16 kHz、16-bit、單聲道的 WAV;標頭 X-Voice-Prompt(URL 編碼)可帶提示詞,
                    例如節點名稱,幫助辨識專有名詞。回傳 {"text", "audioMs", "durationMs", "language"}
"""
from __future__ import annotations

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
lock = threading.Lock()  # 一次只跑一段辨識,避免同時佔用顯示卡

try:  # 選用:pip install opencc-python-reimplemented
    from opencc import OpenCC  # type: ignore

    _cc = OpenCC("s2twp")
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


def transcribe(data: bytes, prompt: str) -> dict:
    audio = read_wav(data)
    t0 = time.time()
    with lock:
        segments, info = model.transcribe(
            audio,
            language="zh",
            initial_prompt=f"{ZH_HINT}{prompt}".strip(),
            vad_filter=True,
            beam_size=5,
            condition_on_previous_text=False,
        )
        text = "".join(s.text for s in segments).strip()
    if to_tw:
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
            self.send_json(200, {**state, "pid": os.getpid()})
        else:
            self.send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.allowed():
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
    threading.Thread(target=load_model, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
