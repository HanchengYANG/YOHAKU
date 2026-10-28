"""Private JSONL adapter for the official NDLOCR-Lite CPU inference pipeline."""
import contextlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys
import time
import traceback
from types import SimpleNamespace
import xml.etree.ElementTree as ET


engine = None


def milliseconds(start):
    return round((time.perf_counter() - start) * 1000, 2)


def load_engine():
    override = os.environ.get("NDLOCR_LITE_DIR")
    if override:
        source = Path(override).expanduser().resolve()
        if not (source / "src" / "ocr.py").is_file():
            raise ModuleNotFoundError("NDLOCR_LITE_DIR must contain src/ocr.py")
        sys.path.insert(0, str(source / "src"))
    import onnxruntime as ort
    import ocr

    base = Path(ocr.__file__).resolve().parent
    args = SimpleNamespace(
        det_weights=str(base / "model" / "deim-s-1024x1024.onnx"),
        det_classes=str(base / "config" / "ndl.yaml"),
        det_score_threshold=0.2, det_conf_threshold=0.25,
        det_iou_threshold=0.2, device="cpu",
        rec_classes=str(base / "config" / "NDLmoji.yaml"),
        rec_weights=str(base / "model" / "parseq-ndl-24x768-100-tiny-153epoch-tegaki3-r8data-202604.onnx"),
        enable_tcy=False,
    )
    # Bound the detector's CPU threads without changing installed upstream code.
    # PARSeq independently sets intra/inter-op threads to one in its constructor.
    original_options = ort.SessionOptions

    def session_options():
        options = original_options()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        return options

    ort.SessionOptions = session_options
    try:
        detector = ocr.get_detector(args)
        recognizer100 = ocr.get_recognizer(args)
        recognizer30 = ocr.get_recognizer(args, str(base / "model" / "parseq-ndl-24x256-30-tiny-189epoch-tegaki3-r8data-202604.onnx"))
        recognizer50 = ocr.get_recognizer(args, str(base / "model" / "parseq-ndl-24x384-50-tiny-300epoch-tegaki3-r8data-202604.onnx"))
    finally:
        ort.SessionOptions = original_options
    return ocr, detector, recognizer30, recognizer50, recognizer100


def classified_lines(node, ruby=False):
    kind = (node.get("TYPE") or "").casefold()
    ruby = ruby or kind in {"ルビ", "ruby", "rubi", "block_rubi", "line_rubi", "line_ruby", "furigana"}
    if node.tag.upper() == "LINE":
        yield node, ruby
    for child in node:
        yield from classified_lines(child, ruby)


@contextlib.contextmanager
def line_preprocessing(ocr, image, metadata):
    """Keep upstream layout/cascade while rectifying its RGB line views."""
    from line_preprocess import rectify_line

    original_cascade = ocr.process_cascade
    base_pointer = image.__array_interface__["data"][0]

    def cascade(lines, *args, **kwargs):
        tick = time.perf_counter()
        for line in lines:
            crop = line.npimg
            offset = crop.__array_interface__["data"][0] - base_pointer
            y, x_bytes = divmod(offset, image.strides[0])
            x = x_bytes // image.strides[1]
            box = [x, y, x + crop.shape[1], y + crop.shape[0]]
            line.npimg, info = rectify_line(image, box)
            if info["applied"] and info["componentCount"] >= 25:
                # Rectified long lines need the wider recognizer input; the
                # detector's original length class describes the old crop.
                info["originalLengthClass"] = line.pred_char_cnt
                info["recognizer"] = "parseq-100"
                info["recognizerReason"] = "rectified-body-components>=25"
                line.pred_char_cnt = 100
            metadata["lines"].append({"index": line.idx, **info})
        metadata["elapsedMs"] = milliseconds(tick)
        metadata["appliedLines"] = sum(item["applied"] for item in metadata["lines"])
        return original_cascade(lines, *args, **kwargs)

    ocr.process_cascade = cascade
    try:
        yield
    finally:
        ocr.process_cascade = original_cascade


def recognize(path):
    global engine
    started = time.perf_counter()
    cold = engine is None
    load_ms = 0
    if cold:
        engine = load_engine()
        load_ms = milliseconds(started)
    ocr, detector, recognizer30, recognizer50, recognizer100 = engine
    import numpy as np
    from PIL import Image, ImageOps

    with Image.open(path) as original:
        image = np.array(ImageOps.exif_transpose(original).convert("RGB"))
    height, width = image.shape[:2]
    tick = time.perf_counter()
    preprocessing = {"enabled": os.environ.get("NDLOCR_PREPROCESS", "1") != "0",
                     "method": "horizontal-component-curve", "elapsedMs": 0,
                     "appliedLines": 0, "lines": []}
    context = line_preprocessing(ocr, image, preprocessing) if preprocessing["enabled"] else contextlib.nullcontext()
    with context:
        raw = ocr._run_ocr_on_image_array(
            detector, recognizer30, recognizer50, recognizer100,
            Path(path).name, image, "", save_viz=False,
        )
    inference_ms = milliseconds(tick)
    # The helper's class_index falls back to 1 for Japanese TYPE labels. Read
    # categories from XML instead, including any explicitly marked ruby parent.
    xml_lines = list(classified_lines(ET.fromstring(raw["page_xml"])))
    if len(xml_lines) != len(raw["json_lines"]):
        raise RuntimeError("NDLOCR-Lite XML/JSON line counts do not match")
    regions, ruby_regions = [], []
    for index, ((line, is_ruby), item) in enumerate(zip(xml_lines, raw["json_lines"])):
        text = item["text"].strip()
        if not text:
            continue
        points = item["boundingBox"]
        region = {
            "label": f"line-{index + 1}", "text": text,
            "sourcePage": "unknown",
            "box": [int(min(p[0] for p in points)), int(min(p[1] for p in points)),
                    int(max(p[0] for p in points)), int(max(p[1] for p in points))],
            "vertical": item["isVertical"] == "true",
            "category": line.get("TYPE", ""),
            "confidence": item["confidence"],
        }
        (ruby_regions if is_ruby else regions).append(region)
    if not regions:
        raise RuntimeError("NDLOCR-Lite did not recognize body text")
    try:
        version = importlib.metadata.version("ndlocr-lite")
    except importlib.metadata.PackageNotFoundError:
        version = getattr(ocr, "__version__", "unknown")
    warnings = ["本地版面分类可能把原图注音、旁注混入正文或遗漏文字，请对照原图校对。"]
    if ruby_regions:
        warnings.append(f"已单独排除明确检测为注音的 {len(ruby_regions)} 个区域；未明确分类的小字仍保留。")
    return {
        "regions": regions, "excludedRubyRegions": ruby_regions,
        "warnings": warnings, "width": width, "height": height,
        "model": "ndl-lab/ndlocr-lite", "detector": "NDLOCR-Lite/DEIMv2",
        "versions": {"ndlocr-lite": version, "onnxruntime": importlib.metadata.version("onnxruntime")},
        "coldStart": cold, "modelLoadMs": load_ms,
        "elapsedMs": milliseconds(started), "inferenceMs": inference_ms,
        "preprocessing": preprocessing,
    }


for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        with contextlib.redirect_stdout(sys.stderr):
            result = recognize(request["path"])
        reply = {"id": request["id"], "result": result}
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        missing = isinstance(error, (ModuleNotFoundError, ImportError))
        reply = {"id": request.get("id"), "error": {
            "message": "NDLOCR-Lite 依赖未安装完整，请按本机安装说明配置 Python 环境。" if missing
                       else "NDLOCR-Lite 本地识别失败，请检查模型安装和服务日志后重试。",
        }}
    print(json.dumps(reply, ensure_ascii=False), flush=True)
