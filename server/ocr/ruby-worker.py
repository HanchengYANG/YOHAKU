#!/usr/bin/env python3
"""Offline, reusable JSON-lines Japanese ruby worker; offsets are JS UTF-16."""

from contextlib import redirect_stdout
from importlib.metadata import PackageNotFoundError, version
import json
import re
import socket
import sys
import time


def deny_network(*args, **kwargs):
    raise RuntimeError("Network blocked in local ruby worker")


# Install the guard before importing any inference dependency. Models and both
# dictionaries are packaged dependencies; runtime must never download anything.
socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.socket.sendto = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network

OPTIONS = dict(revert_long_vowels=True, revert_yotsugana=True,
               use_read_as_pron=False, use_tsqyomi=False, run_marine=False,
               use_sudachi_kanji_yomi=True, normalize_mode="None")
VERSIONS = {"pyopenjtalk-plus": "0.4.1.post10", "SudachiPy": "0.6.11",
            "SudachiDict-core": "20260723", "onnxruntime": "1.24.2"}
HAN_CHARS = ("\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
             "\U00020000-\U0002ee5f\U0002f800-\U0002fa1f"
             "\U00030000-\U0003347f々〆〇")
HAN = re.compile(f"[{HAN_CHARS}]+")
RUNS = re.compile(f"[{HAN_CHARS}]+|[^{HAN_CHARS}]+")
KANA = re.compile(r"[ぁ-ゖー]+")
_engine = None
_versions = None


class RuntimeUnavailable(RuntimeError):
    pass


def hiragana(text):
    return "".join(chr(ord(char) - 0x60) if "ァ" <= char <= "ヶ" else char for char in text)


def align_reading(surface, reading):
    """Literal kana anchors must admit exactly one assignment to Han runs."""
    if not KANA.fullmatch(reading):
        return []
    runs = list(RUNS.finditer(surface))
    solutions = []

    def visit(index, offset, parts):
        if len(solutions) > 1:
            return
        if index == len(runs):
            if offset == len(reading):
                solutions.append(parts)
            return
        run = runs[index]
        if not HAN.fullmatch(run.group()):
            anchor = hiragana(run.group())
            if reading.startswith(anchor, offset):
                visit(index + 1, offset + len(anchor), parts)
            return
        # A final Han run consumes the remainder. Other Han runs end only where
        # their next literal kana anchor begins, keeping alignment conservative.
        ends = [len(reading)] if index == len(runs) - 1 else (
            end for end in range(offset + 1, len(reading))
            if reading.startswith(hiragana(runs[index + 1].group()), end))
        for end in ends:
            if end <= offset:
                continue
            part = dict(start=run.start(), end=run.end(), surface=run.group(), reading=reading[offset:end])
            visit(index + 1, end, parts + [part])

    visit(0, 0, [])
    return solutions[0] if len(solutions) == 1 else []


def annotations_for_nodes(text, nodes):
    """Keep complete contiguous Han spans; abstain if any part lacks alignment."""
    parts = {}
    previous_end = 0
    previous_parts = []
    unanchored_next = False
    for node in nodes:
        span = node.get("char_span")
        if (not isinstance(span, (list, tuple)) or len(span) != 2
                or not all(type(offset) is int for offset in span)):
            raise ValueError("Invalid local ruby word offsets")
        start, end = span
        if (start, end) == (0, 0):
            if not KANA.fullmatch(hiragana(node.get("pron", "").replace("’", ""))):
                continue
            # OpenJTalk can insert spoken number units without an input span
            # (二〇二四年 -> 二千二十四年). Dropping that sound would produce a
            # plausible but incomplete reading, so both neighboring word spans
            # lose their annotations and their containing Han run stays missing.
            for offset in previous_parts:
                parts.pop(offset, None)
            unanchored_next = True
            continue
        if not 0 <= previous_end <= start < end <= len(text):
            raise ValueError("Overlapping or invalid local ruby word offsets")
        previous_end = end
        previous_parts = []
        if unanchored_next:
            unanchored_next = False
            continue
        surface = text[start:end]
        reading = hiragana(node.get("pron", "").replace("’", ""))
        if not HAN.search(surface):
            continue
        for part in align_reading(surface, reading):
            absolute_start, absolute_end = start + part["start"], start + part["end"]
            parts[absolute_start] = dict(start=absolute_start, end=absolute_end,
                                         surface=part["surface"], reading=part["reading"])
            previous_parts.append(absolute_start)

    utf16 = [0]
    for char in text:
        utf16.append(utf16[-1] + (2 if ord(char) > 0xFFFF else 1))
    annotations = []
    for match in HAN.finditer(text):
        cursor, readings = match.start(), []
        while cursor < match.end():
            part = parts.get(cursor)
            if not part or part["end"] > match.end():
                break
            readings.append(part["reading"])
            cursor = part["end"]
        if cursor == match.end():
            annotations.append(dict(start=utf16[match.start()], end=utf16[match.end()],
                                    surface=match.group(), reading="".join(readings)))
    return annotations


def get_engine():
    global _engine, _versions
    if _engine is not None:
        return _engine
    try:
        installed = {name: version(name) for name in VERSIONS}
        if installed != VERSIONS:
            raise RuntimeError(f"Unexpected dependency versions: {installed}")
        # Importing verifies ONNX is installed instead of silently disabling the
        # packaged nani classifier. pyopenjtalk selects CPUExecutionProvider.
        import onnxruntime
        import pyopenjtalk
        if "CPUExecutionProvider" not in onnxruntime.get_available_providers():
            raise RuntimeError("ONNX Runtime CPUExecutionProvider is unavailable")
        _versions = installed
        _engine = pyopenjtalk
        return _engine
    except (ImportError, OSError, PackageNotFoundError, RuntimeError) as error:
        raise RuntimeUnavailable("本地注音依赖不可用，请运行 bash scripts/install-document-runtime.sh，"
                                 "或配置 LOCAL_RUBY_PYTHON。" + str(error)) from error


def annotate(text):
    if not isinstance(text, str) or len(text.encode("utf-16-le")) // 2 > 200000:
        raise ValueError("本地注音需要不超过200000字的原文字符串。")
    started = time.perf_counter()
    with redirect_stdout(sys.stderr):
        engine = get_engine()
        nodes = engine.g2p_mapping(text, predict_nani=True, **OPTIONS) if text else []
    return dict(annotations=annotations_for_nodes(text, nodes), engine="pyopenjtalk-plus",
                versions=_versions, elapsedMs=round((time.perf_counter() - started) * 1000),
                options={**OPTIONS, "predict_nani": True})


def main():
    for line in sys.stdin:
        request = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or type(request.get("id")) is not int:
                raise ValueError("Invalid local ruby request")
            reply = dict(id=request["id"], result=annotate(request.get("text")))
        except Exception as error:
            status = 503 if isinstance(error, RuntimeUnavailable) else 400 if isinstance(error, ValueError) else 502
            reply = dict(id=request.get("id") if isinstance(request, dict) else None,
                         error=dict(message=str(error), status=status))
        print(json.dumps(reply, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
