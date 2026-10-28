"""Conservative horizontal-line rectification; masks estimate geometry only."""
import time
import cv2
import numpy as np


def rectify_line(image, box):
    started = time.perf_counter()
    x0, y0, x1, y1 = box
    width, height = x1 - x0, y1 - y0
    info = {"box": list(box), "applied": False}
    # OpenCV remap uses signed 16-bit source indices, even for a small output.
    if max(image.shape[:2]) >= 32767:
        info["reason"] = "source-exceeds-remap-limit"
        return image[y0:y1, x0:x1], info
    if width < 160 or height < 16 or width < height * 4:
        info["reason"] = "short-or-vertical"
        return image[y0:y1, x0:x1], info
    pad = min(height // 2, width // 12)
    top, bottom = max(0, y0 - pad), min(image.shape[0], y1 + pad)
    crop = image[top:bottom, x0:x1]
    scale = min(1.0, 1600 / width)
    small = cv2.resize(crop, (min(width, 1600), max(1, round(crop.shape[0] * scale))),
                       interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    _, mask = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    sx, sy, sw, sh, area = stats[1:].T.astype(float)
    valid = ((sh >= max(4, height * scale * .035)) & (sh <= height * scale * .65)
             & (sw >= 2) & (sw <= small.shape[1] * .12)
             & (area >= max(12, height * scale * .15)) & (area >= sw * sh * .12))
    sx, sy, sw, sh, area = [a[valid] for a in (sx, sy, sw, sh, area)]
    if len(area) < 8:
        info["reason"] = "too-few-components"
        return image[y0:y1, x0:x1], info
    # Large ink components carry body geometry; tiny ruby and show-through do
    # not steer the line fit. No component is erased from the RGB image.
    body = (area >= np.percentile(area, 55)) & (sh >= np.percentile(sh, 50))
    sx, sy, sw, sh, area = [a[body] for a in (sx, sy, sw, sh, area)]
    if len(area) < 8:
        info["reason"] = "too-few-body-components"
        return image[y0:y1, x0:x1], info
    cx, cy = sx + sw / 2, sy + sh / 2
    char_height = float(np.median(sh))
    center = (y0 - top + height / 2) * scale
    half_band = max(3, char_height * .45)
    bins = np.arange(small.shape[0] + 1)
    kernel = np.ones(max(3, int(half_band * 2 + 1)))
    best = None
    for slope in np.linspace(-.22, .22, 177):
        projected = cy - slope * (cx - small.shape[1] / 2)
        hist, _ = np.histogram(projected, bins=bins, weights=area)
        scores = np.convolve(hist, kernel, mode="same")
        allowed = np.abs(np.arange(len(scores)) - center) <= height * scale * .35
        scores[~allowed] = 0
        peak = int(np.argmax(scores))
        score = float(scores[peak])
        if best is None or score > best[0]:
            best = (score, float(slope), peak)
    _, slope, peak = best
    selected = np.abs(cy - slope * (cx - small.shape[1] / 2) - peak) <= half_band * 1.4
    if selected.sum() < 8 or np.ptp(cx[selected]) < small.shape[1] * .65:
        info["reason"] = "insufficient-line-support"
        return image[y0:y1, x0:x1], info
    px, py = cx[selected], cy[selected]
    # A low-degree curve follows photographed-page curvature without using
    # recognized text. Restrict it to the supported line, with a linear fallback.
    coefficients = np.polyfit(px, py, 2, w=np.sqrt(area[selected]))
    fitted = np.polyval(coefficients, px)
    residual = py - fitted
    if np.percentile(np.abs(residual), 90) > char_height * .5:
        info["reason"] = "ambiguous-line"
        return image[y0:y1, x0:x1], info
    sample_x = np.linspace(0, small.shape[1] - 1, 33)
    curve = np.polyval(coefficients, sample_x)
    if (np.max(np.abs(np.diff(curve) / np.diff(sample_x))) > .3
            or np.ptp(curve) > height * scale * 1.2):
        info["reason"] = "unstable-curve"
        return image[y0:y1, x0:x1], info
    if np.ptp(curve) < char_height * .2:
        info["reason"] = "already-straight"
        return image[y0:y1, x0:x1], info
    upper = float(np.min(sy[selected] - fitted) - char_height * .75)
    lower = float(np.max(sy[selected] + sh[selected] - fitted) + char_height * .2)
    out_height = int(np.ceil((lower - upper) / scale))
    if out_height < 16 or out_height > height * 1.1:
        info["reason"] = "unsafe-height"
        return image[y0:y1, x0:x1], info
    map_x = np.broadcast_to(np.arange(x0, x1, dtype=np.float32), (out_height, width))
    output_curve = np.polyval(coefficients, np.arange(width) * scale)
    map_y = (top + (output_curve[None, :] + upper) / scale
             + np.arange(out_height, dtype=np.float32)[:, None])
    rectified = cv2.remap(image, map_x, map_y.astype(np.float32), cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    info.update(applied=True, method="component-curve-rgb-remap", slope=round(slope, 4),
                componentCount=int(selected.sum()), geometryScale=scale,
                curveCoefficients=coefficients.tolist(), upper=upper, lower=lower,
                sampledBox=[x0, top, x1, bottom], outputSize=[width, out_height],
                elapsedMs=round((time.perf_counter() - started) * 1000, 2))
    return rectified, info
