"""Private JSONL worker: upstream mokuro detection followed by manga-ocr."""
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import traceback

# The official legacy detector checkpoint contains Python model objects.
os.environ.setdefault("TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
engine = None
metrics = {}


def milliseconds(start):
    return round((time.perf_counter() - start) * 1000, 2)


def recognize(path):
    global engine, metrics
    started = time.perf_counter()
    cold = engine is None
    load_ms = 0
    if cold:
        import torch
        from mokuro.manga_page_ocr import MangaPageOcr

        torch.set_num_threads(4)
        engine = MangaPageOcr(force_cpu=True)
        engine.mocr.model.eval()
        detector, mocr = engine.text_detector, engine.mocr

        def detect(*args, **kwargs):
            tick = time.perf_counter()
            value = detector(*args, **kwargs)
            metrics["detectMs"] += milliseconds(tick)
            return value

        def read(*args, **kwargs):
            tick = time.perf_counter()
            with torch.inference_mode():
                value = mocr(*args, **kwargs)
            metrics["recognizeMs"] += milliseconds(tick)
            return value

        engine.text_detector, engine.mocr = detect, read
        load_ms = milliseconds(started)

    from PIL import Image, ImageOps
    metrics = {"detectMs": 0, "recognizeMs": 0}
    with Image.open(path) as original:
        image = ImageOps.exif_transpose(original).convert("RGB")
        needs_rotation = original.getexif().get(274, 1) not in (None, 1)
    # mokuro's imread does not apply EXIF rotation itself.
    with tempfile.TemporaryDirectory(prefix="yohaku-manga-") as directory:
        input_path = path
        if needs_rotation:
            input_path = str(Path(directory) / "oriented.png")
            image.save(input_path)
        raw = engine(input_path)
    regions = []
    for index, block in enumerate(raw["blocks"]):
        text = "\n".join(block["lines"]).strip()
        if text:
            regions.append({
                "label": f"region-{index + 1}", "text": text,
                "sourcePage": "unknown", "box": [int(n) for n in block["box"]],
                "vertical": bool(block["vertical"]),
            })
    warnings = []
    if not regions:
        regions = [{"label": "whole-image-fallback", "text": engine.mocr(image),
                    "sourcePage": "unknown", "box": [0, 0, image.width, image.height],
                    "vertical": None}]
        warnings.append("自动检测未找到文字区域，已尝试整图识别；正文可能大量遗漏，请对照原图。")
    return {
        "regions": regions, "warnings": warnings, "width": image.width, "height": image.height,
        "model": "kha-white/manga-ocr-base", "detector": "mokuro/comic-text-detector",
        "versions": {name: importlib.metadata.version(name) for name in ("manga-ocr", "mokuro", "torch")},
        "coldStart": cold, "modelLoadMs": load_ms, "elapsedMs": milliseconds(started),
        **{key: round(value, 2) for key, value in metrics.items()},
    }


for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        # Libraries may print model diagnostics; stdout is reserved for JSONL.
        with contextlib.redirect_stdout(sys.stderr):
            result = recognize(request["path"])
        reply = {"id": request["id"], "result": result}
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        missing = isinstance(error, (ModuleNotFoundError, ImportError))
        reply = {"id": request.get("id"), "error": {
            "message": "MangaOCR 依赖未安装完整，请按本机安装说明配置 Python 环境。" if missing
                       else "MangaOCR 本地识别失败，请检查模型安装和服务日志后重试。",
        }}
    print(json.dumps(reply, ensure_ascii=False), flush=True)
