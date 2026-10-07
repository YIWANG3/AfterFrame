"""Same Rec709 LUT on three bases of the same RAW: the camera's embedded JPEG,
Apple Image I/O (sips), and LibRaw with AfterFrame's decode params."""
import io
import subprocess
import sys
import tempfile
import time

import rawpy
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

sys.path.insert(0, sys.argv[0].rsplit("/", 1)[0])
from lut_bench import parse_cube  # noqa: E402

LUT = sys.argv[1]
OUT = sys.argv[2]
RAWS = sys.argv[3:]
W = 520

s, lo, hi, table = parse_cube(LUT)
lut = ImageFilter.Color3DLUT(s, table.reshape(-1).tolist())
font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 20)


def fit(im):
    im = im.convert("RGB")
    im.thumbnail((W, W))
    return im


def orient(im, flip):
    # rawpy sizes.flip: 0 none, 3 180, 5 90 CCW, 6 90 CW
    return {3: im.rotate(180, expand=True), 5: im.rotate(90, expand=True), 6: im.rotate(-90, expand=True)}.get(flip, im)


rows = []
for path in RAWS:
    with rawpy.imread(path) as raw:
        flip = raw.sizes.flip
        th = raw.extract_thumb()
        emb = Image.open(io.BytesIO(th.data))
        emb_size = emb.size
        emb = ImageOps.exif_transpose(emb)
        t = time.time()
        lib = raw.postprocess(half_size=True, use_camera_wb=True, no_auto_bright=True, gamma=(2.4, 12.92), output_bps=8)
        t_lib = time.time() - t
    lib = orient(Image.fromarray(lib), flip)
    with tempfile.NamedTemporaryFile(suffix=".jpg") as tmp:
        t = time.time()
        subprocess.run(["sips", "-s", "format", "jpeg", "-Z", "2000", path, "--out", tmp.name], check=True, capture_output=True)
        t_sips = time.time() - t
        aio = ImageOps.exif_transpose(Image.open(tmp.name))
        aio.load()
    bases = [("embedded JPEG", fit(emb)), ("Apple Image I/O", fit(aio)), ("LibRaw (AfterFrame)", fit(lib))]
    name = path.rsplit("/", 1)[-1]
    print(f"{name}: embedded {emb_size[0]}x{emb_size[1]}, LibRaw half {t_lib:.1f}s, sips->2000px {t_sips:.1f}s", flush=True)
    rows.append((name, [(lab, im) for lab, im in bases]))

h = max(im.height for _, r in rows for _, im in r)
canvas = Image.new("RGB", (W * 6 + 50, (h + 10) * len(rows)), "white")
for ri, (_name, bases) in enumerate(rows):
    y = ri * (h + 10)
    for bi, (lab, im) in enumerate(bases):
        for k, img in enumerate([im, im.filter(lut)]):
            x = (bi * 2 + k) * W + bi * 20 + k * 5
            canvas.paste(img, (x, y))
            d = ImageDraw.Draw(canvas)
            text = f"{lab}{' + LUT' if k else ''}"
            d.rectangle([x, y, x + 12 + d.textlength(text, font=font), y + 28], fill="black")
            d.text((x + 6, y + 3), text, fill="white", font=font)
canvas.save(OUT, quality=88)
print("saved", canvas.size)
