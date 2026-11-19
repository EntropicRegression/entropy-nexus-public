"""語音合成引擎:CosyVoice 2(Apache-2.0)。語音模式 Phase 3,每個節點用參考錄音模仿出自己的聲音。

CosyVoice 不是 pip 套件,要另外 clone 它的 repo(含 third_party/Matcha-TTS 子模組)並下載模型;
由 server.py 依 NEXUS_VOICE_TTS_DIR(repo 資料夾)與 NEXUS_VOICE_TTS_MODEL(模型資料夾)載入。
安裝步驟見 README.md。以 CosyVoice repo 2026-11 的版本、torch 2.3.1+cu121、Windows 11 實測。
"""
from __future__ import annotations

import os
import sys
import threading


def _wetext_offline() -> None:
    """CosyVoice 在 Windows 上改用 wetext 做文字正規化;wetext 每次初始化都呼叫 modelscope.snapshot_download,
    去比對整個模型庫(現在含很多用不到的語言),從台灣連線很慢,常讓語音合成卡在載入。
    本機快取已經有中文與英文的檔案時,直接用快取,不連網。"""
    try:
        import wetext.wetext as ww  # type: ignore
    except Exception:  # noqa: BLE001 沒有 wetext(例如 Linux 用 ttsfrd)就不用處理
        return
    hub = os.environ.get("MODELSCOPE_CACHE") or os.path.join(os.path.expanduser("~"), ".cache", "modelscope", "hub")
    local = os.path.join(hub, "pengzhendong", "wetext")
    need = [os.path.join(local, lang, "tn", f) for lang in ("zh", "en") for f in ("tagger.fst", "verbalizer.fst")]
    if not all(os.path.isfile(p) for p in need):
        return
    original = ww.snapshot_download
    ww.snapshot_download = lambda repo_id, *a, **k: local if repo_id == "pengzhendong/wetext" else original(repo_id, *a, **k)


class CosyVoiceEngine:
    def __init__(self, repo: str, model_dir: str) -> None:
        _wetext_offline()
        repo = os.path.abspath(repo)
        for p in (repo, os.path.join(repo, "third_party", "Matcha-TTS")):
            if p not in sys.path:
                sys.path.insert(0, p)
        from cosyvoice.cli.cosyvoice import CosyVoice2  # type: ignore
        import torch

        self.torch = torch
        # fp16 實測沒有明顯變快;JIT、TensorRT、vLLM 在 Windows 上不用
        self.model = CosyVoice2(model_dir, load_jit=False, load_trt=False, fp16=False)
        self.sample_rate = int(self.model.sample_rate)
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        # 參考錄音 → 快取的說話者 id(add_zero_shot_spk);依檔案修改時間與內容文字區分
        self._spk: dict[tuple, str] = {}
        self.lock = threading.Lock()
        # CosyVoice 2 主要用簡體中文訓練:繁體字常被念錯(例如「測試」念成像「收息」),
        # 要念的文字與參考錄音的內容都先轉成簡體。需要 pip install opencc-python-reimplemented。
        try:
            from opencc import OpenCC  # type: ignore

            self._to_cn = OpenCC("t2s").convert
        except Exception:  # noqa: BLE001
            self._to_cn = None
            print("[voice] 警告:沒有安裝 opencc-python-reimplemented,繁體字可能會念錯", flush=True)

    def _cn(self, text: str) -> str:
        return self._to_cn(text) if self._to_cn and text else text

    def _speaker(self, wav: str, prompt_text: str) -> str:
        key = (wav, os.path.getmtime(wav), prompt_text)
        spk = self._spk.get(key)
        if spk is None:
            spk = f"nexus{len(self._spk)}"
            self.model.add_zero_shot_spk(prompt_text, wav, spk)
            self._spk[key] = spk
        return spk

    def synth(self, text: str, ref_wav: str, prompt_text: str, style: str):
        """回傳 (float32 numpy 陣列, 取樣率)。有語氣指令時用 instruct 模式,否則用快取說話者的 zero-shot。"""
        text, prompt_text, style = self._cn(text), self._cn(prompt_text), self._cn(style)
        with self.lock:
            if style:
                gen = self.model.inference_instruct2(text, f"{style}<|endofprompt|>", ref_wav, stream=False)
            else:
                gen = self.model.inference_zero_shot(text, "", "", zero_shot_spk_id=self._speaker(ref_wav, prompt_text), stream=False)
            chunks = [out["tts_speech"] for out in gen]
        audio = self.torch.cat(chunks, dim=1).squeeze(0).float().cpu().numpy()
        return audio, self.sample_rate
