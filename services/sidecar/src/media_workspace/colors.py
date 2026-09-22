"""Dominant colours of a photo, from its 512 px preview.

A palette of up to five swatches, ordered by how much of the picture each
covers, each with its CIELab coordinates. The Colour filter takes any
colour and matches the photos that have a swatch within a Lab distance of
it — the way Eagle does it — rather than a fixed list of named colours.

Median cut on a 96 px thumbnail is enough: the swatches are for the eye
and for the filter, not for print. Nearby cuts of one flat area (a sky
split into two blues) are merged back by Lab distance before ranking.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

MAX_SWATCHES = 5
MIN_SHARE = 0.02  # a swatch below this is noise, not a colour of the picture
_MERGE_DISTANCE = 12.0  # ΔE (CIE76) under which two cuts are the same colour
_SAMPLE_EDGE = 96
_CUT_COLORS = 10

# How far (ΔE, CIE76) a swatch may be from the asked-for colour. Around 2.3
# is a just-noticeable difference; 25 still reads as "the same colour".
TOLERANCES = {"strict": 15.0, "normal": 25.0, "loose": 40.0}
DEFAULT_TOLERANCE = "normal"
# A swatch must cover this much of the picture to make the photo match: an
# accent of a few pixels is not "a photo with that colour".
MATCH_MIN_SHARE = 0.03


def lab_of(r: int, g: int, b: int) -> tuple[float, float, float]:
    """sRGB (0–255) → CIELab, D65."""
    def channel(c: int) -> float:
        v = c / 255
        return ((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92

    rl, gl, bl = channel(r), channel(g), channel(b)
    x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047
    y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
    z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883

    def f(t: float) -> float:
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def _distance(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return math.sqrt(sum((p - q) ** 2 for p, q in zip(a, b, strict=True)))


def palette_from_pixels(pixels: list[tuple[int, int, int]], weights: list[int]) -> list[dict]:
    """Merge and rank already-quantised colours. Separate from the image
    reading so it can be tested without files."""
    total = sum(weights) or 1
    groups: list[dict] = []
    for (r, g, b), weight in sorted(zip(pixels, weights, strict=True), key=lambda item: -item[1]):
        lab = lab_of(r, g, b)
        for group in groups:
            if _distance(group["lab"], lab) < _MERGE_DISTANCE:
                group["weight"] += weight
                break
        else:
            groups.append({"rgb": (r, g, b), "lab": lab, "weight": weight})
    groups.sort(key=lambda group: -group["weight"])
    swatches = []
    for group in groups[:MAX_SWATCHES]:
        share = group["weight"] / total
        if share < MIN_SHARE:
            break
        r, g, b = group["rgb"]
        lab_l, lab_a, lab_b = group["lab"]
        swatches.append({
            "hex": f"#{r:02x}{g:02x}{b:02x}", "share": round(share, 4),
            "l": round(lab_l, 2), "a": round(lab_a, 2), "b": round(lab_b, 2),
        })
    return swatches


def parse_hex(value: object) -> tuple[int, int, int] | None:
    """'#rrggbb' / 'rrggbb' / '#rgb' → (r, g, b), else None."""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", text):
        return None
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)


def extract_palette(path: Path) -> list[dict]:
    """→ [{hex, share, l, a, b}] for an image file, most prominent first.
    Empty when the file cannot be read."""
    from PIL import Image

    try:
        with Image.open(path) as image:
            image.draft("RGB", (_SAMPLE_EDGE * 2, _SAMPLE_EDGE * 2))
            rgb = image.convert("RGB")
            rgb.thumbnail((_SAMPLE_EDGE, _SAMPLE_EDGE))
            quantised = rgb.quantize(colors=_CUT_COLORS, method=Image.Quantize.MEDIANCUT)
            palette = quantised.getpalette() or []
            counts = quantised.getcolors(_CUT_COLORS * 4) or []
    except Exception:
        return []
    pixels: list[tuple[int, int, int]] = []
    weights: list[int] = []
    for count, index in counts:
        i = int(index) * 3  # type: ignore[arg-type]  # a P-mode image indexes its palette by one int
        pixels.append((palette[i], palette[i + 1], palette[i + 2]))
        weights.append(int(count))
    return palette_from_pixels(pixels, weights)
