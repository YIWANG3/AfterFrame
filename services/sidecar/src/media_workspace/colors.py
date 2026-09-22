"""Dominant colours of a photo, from its 512 px preview.

A palette of up to five swatches, ordered by how much of the picture each
covers, each with its CIELab coordinates. The Colour filter takes any
colour and matches the photos that have a swatch within a Lab distance of
it — the way Eagle does it — rather than a fixed list of named colours.

Weighted k-means in Lab on a 128 px thumbnail, each cluster shown by a
colour that is really in the picture (means of mixed regions come out
grey, which is what a median cut gave). Vivid accents that cover little
of the frame (a red sign in a blue night) are kept on purpose.
"""
from __future__ import annotations

import math
import re
from pathlib import Path

MAX_SWATCHES = 8
MIN_SHARE = 0.015  # a swatch below this is noise, not a colour of the picture
# A small but vivid area (a red sign in a blue night) is a colour of the
# picture too: this many of the most saturated clusters stay in regardless
# of their share, once they are this saturated and this big.
ACCENT_SLOTS = 2
ACCENT_MIN_CHROMA = 40.0
ACCENT_MIN_SHARE = 0.01
_MERGE_DISTANCE = 10.0  # ΔE (CIE76) under which two clusters are the same colour
_SAMPLE_EDGE = 128
_CLUSTERS = 12
_BIN = 8  # sRGB values are pooled into bins this wide before clustering
# Lightness counts less than hue when clustering, so the lit and the shaded
# parts of one orange facade fall in the same cluster instead of splitting
# into three browns.
_L_WEIGHT = 0.6
# Bump when the extraction changes: every catalog then redoes its colours
# on the next open (run_colors_job with force).
COLORS_VERSION = "kmeans-lab-2"

# How far (ΔE, CIE76) a swatch may be from the asked-for colour. Around 2.3
# is a just-noticeable difference; 25 still reads as "the same colour".
TOLERANCES = {"strict": 15.0, "normal": 25.0, "loose": 40.0}
DEFAULT_TOLERANCE = "normal"
# A swatch must cover this much of the picture to make the photo match.
MATCH_MIN_SHARE = MIN_SHARE


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


def _srgb_to_lab(rgb):
    """(n, 3) sRGB 0–255 → CIELab, vectorised."""
    import numpy as np

    v = np.asarray(rgb, dtype=np.float64) / 255.0
    c = np.where(v > 0.04045, ((v + 0.055) / 1.055) ** 2.4, v / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[:, 1] - 16, 500 * (f[:, 0] - f[:, 1]), 200 * (f[:, 1] - f[:, 2])], axis=1)


def _cluster(pixels, k: int = _CLUSTERS) -> list[dict]:
    """Weighted k-means in Lab (lightness down-weighted) over the picture's
    pooled colours. Each cluster is shown by a colour that is actually in
    the picture: the mean of its more saturated half, snapped to the nearest
    real bin. The plain cluster mean comes out grey (mixed regions), and
    its heaviest bin comes out dark (shadow pixels outnumber lit ones)."""
    import numpy as np

    px = np.asarray(pixels, dtype=np.float64).reshape(-1, 3)
    keys = (px // _BIN).astype(np.int64)
    key = keys[:, 0] * 4096 + keys[:, 1] * 64 + keys[:, 2]
    _, inverse, counts = np.unique(key, return_inverse=True, return_counts=True)
    bins = np.zeros((len(counts), 3))
    np.add.at(bins, inverse, px)
    bins /= counts[:, None]
    lab = _srgb_to_lab(bins)
    space = lab * np.array([_L_WEIGHT, 1.0, 1.0])
    weight = counts.astype(np.float64)
    total = weight.sum()
    k = min(k, len(bins))

    rng = np.random.default_rng(0)  # fixed: the same picture gives the same palette
    centers = [space[rng.choice(len(space), p=weight / total)]]
    for _ in range(1, k):  # k-means++: far, heavy points first
        nearest = np.min(((space[:, None, :] - np.array(centers)[None, :, :]) ** 2).sum(-1), axis=1)
        p = nearest * weight
        if p.sum() <= 0:
            break
        centers.append(space[rng.choice(len(space), p=p / p.sum())])
    c = np.array(centers)
    assignment = np.zeros(len(space), dtype=np.int64)
    for _ in range(20):
        assignment = np.argmin(((space[:, None, :] - c[None, :, :]) ** 2).sum(-1), axis=1)
        for j in range(len(c)):
            members = assignment == j
            if members.any():
                c[j] = (space[members] * weight[members, None]).sum(0) / weight[members].sum()

    clusters = []
    chroma_all = np.hypot(lab[:, 1], lab[:, 2])
    for j in range(len(c)):
        members = np.flatnonzero(assignment == j)
        if len(members) == 0:
            continue
        vivid = members[np.argsort(-chroma_all[members])][: max(1, len(members) // 2)]
        mean = (lab[vivid] * weight[vivid, None]).sum(0) / weight[vivid].sum()
        pick = members[np.argmin(((lab[members] - mean) ** 2).sum(1))]
        clusters.append({
            "rgb": tuple(int(round(v)) for v in bins[pick]),
            "lab": tuple(float(v) for v in lab[pick]),
            "share": float(weight[members].sum() / total),
            "chroma": float(chroma_all[pick]),
        })
    return clusters


def rank_palette(clusters: list[dict]) -> list[dict]:
    """Merge near-identical clusters, keep the ones that cover enough of the
    picture plus the vivid accents, most prominent first."""
    merged: list[dict] = []
    for cluster in sorted(clusters, key=lambda c: -c["share"]):
        for kept in merged:
            if _distance(kept["lab"], cluster["lab"]) < _MERGE_DISTANCE:
                kept["share"] += cluster["share"]
                break
        else:
            merged.append(dict(cluster))
    merged.sort(key=lambda c: -c["share"])
    main = [c for c in merged if c["share"] >= MIN_SHARE][:MAX_SWATCHES]
    accents = sorted(
        (c for c in merged if c not in main and c["chroma"] >= ACCENT_MIN_CHROMA and c["share"] >= ACCENT_MIN_SHARE),
        key=lambda c: -c["chroma"],
    )[:ACCENT_SLOTS]
    if accents:
        main = (main[: MAX_SWATCHES - len(accents)] + accents)
        main.sort(key=lambda c: -c["share"])
    swatches = []
    for cluster in main:
        r, g, b = cluster["rgb"]
        lab_l, lab_a, lab_b = cluster["lab"]
        swatches.append({
            "hex": f"#{r:02x}{g:02x}{b:02x}", "share": round(cluster["share"], 4),
            "l": round(lab_l, 2), "a": round(lab_a, 2), "b": round(lab_b, 2),
        })
    return swatches


def palette_from_pixels(pixels: list[tuple[int, int, int]], weights: list[int]) -> list[dict]:
    """Rank already-distinct colours (no clustering). Separate from the image
    reading so it can be tested without files."""
    total = sum(weights) or 1
    clusters = []
    for (r, g, b), weight in zip(pixels, weights, strict=True):
        lab = lab_of(r, g, b)
        clusters.append({"rgb": (r, g, b), "lab": lab, "share": weight / total, "chroma": math.hypot(lab[1], lab[2])})
    return rank_palette(clusters)


def extract_palette(path: Path) -> list[dict]:
    """→ [{hex, share, l, a, b}] for an image file, most prominent first.
    Empty when the file cannot be read."""
    from PIL import Image

    try:
        with Image.open(path) as image:
            image.draft("RGB", (_SAMPLE_EDGE * 2, _SAMPLE_EDGE * 2))
            rgb = image.convert("RGB")
            rgb.thumbnail((_SAMPLE_EDGE, _SAMPLE_EDGE))
            pixels = list(rgb.getdata())
    except Exception:
        return []
    if not pixels:
        return []
    return rank_palette(_cluster(pixels))


def parse_hex(value: object) -> tuple[int, int, int] | None:
    """'#rrggbb' / 'rrggbb' / '#rgb' → (r, g, b), else None."""
    text = str(value or "").strip().lstrip("#")
    if len(text) == 3:
        text = "".join(ch * 2 for ch in text)
    if len(text) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", text):
        return None
    return int(text[0:2], 16), int(text[2:4], 16), int(text[4:6], 16)
