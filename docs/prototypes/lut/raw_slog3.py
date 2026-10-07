"""Sony ARW -> scene-linear -> S-Gamut3.Cine / S-Log3 -> LUT, versus the naive
"S-Log3 LUT on the embedded JPEG". Float all the way; also shows what 8-bit
log input does to a sky gradient."""
import io
import sys
import time

import numpy as np
import rawpy
from PIL import Image, ImageDraw, ImageFont, ImageOps

sys.path.insert(0, sys.argv[0].rsplit("/", 1)[0])
from lut_bench import parse_cube  # noqa: E402

raw_path, official_lut, creative_lut, out = sys.argv[1:5]
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)


def tetra(x, lut):
    """x: float HxWx3 in [0,1]; lut: [b,g,r,3] float table. Tetrahedral."""
    n = lut.shape[0]
    x = np.clip(x, 0, 1) * (n - 1)
    i0 = np.minimum(np.floor(x).astype(np.int64), n - 2)
    f = x - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]

    def c(dr, dg, db):
        return lut[b0 + db, g0 + dg, r0 + dr]

    p000, p111 = c(0, 0, 0), c(1, 1, 1)
    out = np.zeros_like(p000)
    cases = [
        ((fr >= fg) & (fg >= fb), (1, 0, 0), (1, 1, 0), fr, fg, fb),
        ((fr >= fb) & (fb > fg), (1, 0, 0), (1, 0, 1), fr, fb, fg),
        ((fb > fr) & (fr >= fg), (0, 0, 1), (1, 0, 1), fb, fr, fg),
        ((fg > fr) & (fr >= fb), (0, 1, 0), (1, 1, 0), fg, fr, fb),
        ((fg >= fb) & (fb > fr), (0, 1, 0), (0, 1, 1), fg, fb, fr),
        ((fb > fg) & (fg > fr), (0, 0, 1), (0, 1, 1), fb, fg, fr),
    ]
    for cond, a, b, t1, t2, t3 in cases:
        out = np.where(cond, (1 - t1) * p000 + (t1 - t2) * c(*a) + (t2 - t3) * c(*b) + t3 * p111, out)
    return np.clip(out, 0, 1)


def rgb_to_xyz(prim, white=(0.3127, 0.3290)):
    xyz = lambda x, y: np.array([x / y, 1.0, (1 - x - y) / y])  # noqa: E731
    m = np.stack([xyz(*p) for p in prim], axis=1)
    s = np.linalg.solve(m, xyz(*white))
    return m * s


SG3C = rgb_to_xyz([(0.766, 0.275), (0.225, 0.800), (0.089, -0.087)])
XYZ_TO_SG3C = np.linalg.inv(SG3C)


def slog3(x):
    x = np.maximum(x, -0.01)  # keep the log's domain
    return np.where(
        x >= 0.01125,
        (420.0 + np.log10((x + 0.01) / 0.19) * 261.5) / 1023.0,
        (x * (171.2102946929 - 95.0) / 0.01125 + 95.0) / 1023.0,
    )


def orient(im, flip):
    return {3: im.rotate(180, expand=True), 5: im.rotate(90, expand=True), 6: im.rotate(-90, expand=True)}.get(flip, im)


t = time.time()
with rawpy.imread(raw_path) as raw:
    flip = raw.sizes.flip
    emb = ImageOps.exif_transpose(Image.open(io.BytesIO(raw.extract_thumb().data))).convert("RGB")
    lin = raw.postprocess(half_size=True, use_camera_wb=True, no_auto_bright=True, gamma=(1, 1),
                          output_bps=16, output_color=rawpy.ColorSpace.XYZ)
print(f"decode linear XYZ (half size) {time.time() - t:.1f}s, {lin.shape}")
xyz = lin.astype(np.float32) / 65535.0
sg = xyz @ XYZ_TO_SG3C.T.astype(np.float32)

_, _, _, off = parse_cube(official_lut)
_, _, _, cre = parse_cube(creative_lut)

# Exposure: RAW linear is 1.0 at sensor clip; S-Log3 wants 0.18 = 18% grey.
# There is no single right answer: match the official LC-709 rendering's
# median brightness to the camera's own JPEG.
small = sg[::8, ::8]
emb_med = np.median(np.asarray(emb.resize((small.shape[1], small.shape[0]) if flip in (0, 3) else (small.shape[0], small.shape[1]))).astype(np.float32) / 255)
best = None
for ev in np.arange(-1, 3.01, 0.1):
    med = np.median(tetra(slog3(small * 2**ev), off))
    if best is None or abs(med - emb_med) < best[1]:
        best = (ev, abs(med - emb_med))
ev = best[0]
print(f"exposure to match the camera JPEG: {ev:+.1f} EV")

log = slog3(sg * 2**ev).astype(np.float32)
t = time.time()
official = tetra(log, off)
creative = tetra(log, cre)
print(f"two tetrahedral LUTs on {log.shape[1]}x{log.shape[0]} float: {time.time() - t:.1f}s")
log8 = np.round(log * 255) / 255
creative8 = tetra(log8, cre)
naive = tetra(np.asarray(emb).astype(np.float32) / 255, cre)


def img(a):
    return orient(Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)), flip)


tiles = [
    ("camera JPEG (embedded)", emb),
    ("RAW -> S-Log3 (raw log)", img(log)),
    ("RAW -> S-Log3 -> Sony LC-709A", img(official)),
    ("S-Log3 look LUT on camera JPEG (wrong)", Image.fromarray((naive * 255 + 0.5).astype(np.uint8))),
    ("RAW -> S-Log3 -> same look LUT", img(creative)),
    ("same, but log quantised to 8-bit", img(creative8)),
]
W = 640
for i, (lab, im) in enumerate(tiles):
    im = im.copy()
    im.thumbnail((W, W))
    tiles[i] = (lab, im)
h = max(im.height for _, im in tiles)
canvas = Image.new("RGB", (W * 3 + 20, h * 2 + 10), "white")
for i, (lab, im) in enumerate(tiles):
    x, y = (i % 3) * (W + 10), (i // 3) * (h + 10)
    canvas.paste(im, (x, y))
    d = ImageDraw.Draw(canvas)
    d.rectangle([x, y, x + 12 + d.textlength(lab, font=font), y + 30], fill="black")
    d.text((x + 6, y + 3), lab, fill="white", font=font)
canvas.save(out, quality=88)

# 8-bit vs float log: a 1:1 crop of the sky, contrast-stretched to show steps.
a, b = img(creative), img(creative8)
cw, ch = 500, 260
box = (a.width // 2 - cw // 2, 40, a.width // 2 + cw // 2, 40 + ch)
ca, cb = np.asarray(a.crop(box)).astype(np.float32), np.asarray(b.crop(box)).astype(np.float32)
lo, hi = min(ca.min(), cb.min()), max(ca.max(), cb.max())
stretch = lambda c: Image.fromarray(((c - lo) / max(1, hi - lo) * 255).astype(np.uint8))  # noqa: E731
crop = Image.new("RGB", (cw * 2 + 10, ch), "white")
crop.paste(stretch(ca), (0, 0))
crop.paste(stretch(cb), (cw + 10, 0))
crop.save(out.replace(".jpg", "_sky.png"))
print("unique sky levels float vs 8-bit:", len(np.unique(ca.reshape(-1, 3), axis=0)), len(np.unique(cb.reshape(-1, 3), axis=0)))
