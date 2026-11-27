"""中翻英(英文語音播報用,選用):Helsinki-NLP/opus-mt-zh-en 轉成 CTranslate2 INT8,在 CPU 上跑(一句約 0.1 秒,不佔顯示卡記憶體)。

模型資料夾:NEXUS_VOICE_MT_DIR,沒設定時用這個檔案旁邊的 mt/opus-mt-zh-en。資料夾裡要有 CTranslate2 的 model.bin,
以及原模型的 source.spm、target.spm。準備方式(只要做一次):
    pip install ctranslate2 sentencepiece transformers
    ct2-transformers-converter --model Helsinki-NLP/opus-mt-zh-en --quantization int8 \
        --output_dir mt/opus-mt-zh-en --copy_files source.spm target.spm
沒有模型或套件時 /translate 回 503,主控台改念固定的英文句。翻譯結果由主控台再做一次防呆(否定詞、數字、怪字元)。
"""
from __future__ import annotations

import os
import threading

MT_DIR = os.environ.get("NEXUS_VOICE_MT_DIR", "").strip() or os.path.join(os.path.dirname(os.path.abspath(__file__)), "mt", "opus-mt-zh-en")


class OpusMt:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.translator = None
        self.src = None
        self.tgt = None
        # status:off 沒有模型資料夾、idle 還沒載入(語音服務啟動時在背景載入,見 warm)、ready 可以用、error 載入失敗
        self.status = "off" if not os.path.isfile(os.path.join(MT_DIR, "model.bin")) else "idle"
        self.error = ""

    def _load(self) -> None:
        import ctranslate2  # type: ignore
        import sentencepiece as spm  # type: ignore

        self.translator = ctranslate2.Translator(MT_DIR, device="cpu", compute_type="int8", inter_threads=1, intra_threads=2)
        self.src = spm.SentencePieceProcessor(model_file=os.path.join(MT_DIR, "source.spm"))
        self.tgt = spm.SentencePieceProcessor(model_file=os.path.join(MT_DIR, "target.spm"))
        self.status = "ready"

    def warm(self) -> None:
        """語音服務啟動時在背景先載入並翻一句:第一次載入約 2 秒,會超過主控台 1.5 秒的上限。失敗只記下狀態。"""
        if self.status != "idle":
            return
        try:
            self.translate("測試")
        except Exception:  # noqa: BLE001 狀態與錯誤已在 translate 裡記下
            pass

    def translate(self, text: str) -> str:
        if self.status == "off":
            raise RuntimeError("沒有設定翻譯模型")
        if self.status == "error":
            # 載入失敗過就不再重試(要重新載入請重新啟動語音服務)
            raise RuntimeError(f"翻譯模型載入失敗:{self.error}")
        with self.lock:
            if self.translator is None:
                try:
                    self._load()
                except Exception as err:  # noqa: BLE001
                    self.status, self.error = "error", str(err)[:200]
                    raise RuntimeError(f"翻譯模型載入失敗:{self.error}") from err
            tokens = self.src.encode(text, out_type=str) + ["</s>"]
            result = self.translator.translate_batch([tokens], beam_size=4, max_decoding_length=200)
            out = [t for t in result[0].hypotheses[0] if t not in ("</s>", "<pad>")]
            return self.tgt.decode(out).strip()
