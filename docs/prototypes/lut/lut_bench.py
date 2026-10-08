"""Benchmark + accuracy check for applying .cube 3D LUTs to photos.

Compares Pillow's built-in Color3DLUT (trilinear, fixed-point, 8-bit) with a
float64 numpy trilinear and tetrahedral reference.
"""
import sys
import time

import numpy as np
from PIL import Image, ImageFilter


def parse_cube(path):
    size = None
    lo = np.zeros(3)
    hi = np.ones(3)
    rows = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for raw in f:
            s = raw.strip()
            if not s or s.startswith("#"):
                continue
            head = s.split()[0]
            if head == "LUT_3D_SIZE":
                size = int(s.split()[1])
            elif head == "DOMAIN_MIN":
                lo = np.array([float(x) for x in s.split()[1:4]])
            elif head == "DOMAIN_MAX":
                hi = np.array([float(x) for x in s.split()[1:4]])
            elif head == "LUT_3D_INPUT_RANGE":
                a, b = (float(x) for x in s.split()[1:3])
                lo, hi = np.full(3, a), np.full(3, b)
            elif head[0].isalpha():
                continue  # TITLE, LUT_1D_SIZE, vendor keys
            else:
                rows.append(s.split()[:3])
    table = np.asarray(rows, dtype=np.float64)
    assert size and len(table) == size**3, (size, len(table))
    # .cube: R fastest, then G, then B -> index [b, g, r]
    return size, lo, hi, table.reshape(size, size, size, 3)


def apply_numpy(img, size, lut, tetra):
    x = np.asarray(img, dtype=np.float64) / 255.0 * (size - 1)
    i0 = np.clip(np.floor(x).astype(np.int64), 0, size - 2)
    f = x - i0
    r0, g0, b0 = i0[..., 0], i0[..., 1], i0[..., 2]
    fr, fg, fb = f[..., 0:1], f[..., 1:2], f[..., 2:3]

    def c(dr, dg, db):
        return lut[b0 + db, g0 + dg, r0 + dr]

    if not tetra:
        c00 = c(0, 0, 0) * (1 - fr) + c(1, 0, 0) * fr
        c10 = c(0, 1, 0) * (1 - fr) + c(1, 1, 0) * fr
        c01 = c(0, 0, 1) * (1 - fr) + c(1, 0, 1) * fr
        c11 = c(0, 1, 1) * (1 - fr) + c(1, 1, 1) * fr
        c0 = c00 * (1 - fg) + c10 * fg
        c1 = c01 * (1 - fg) + c11 * fg
        out = c0 * (1 - fb) + c1 * fb
    else:
        p000, p111 = c(0, 0, 0), c(1, 1, 1)
        out = np.empty_like(p000)
        conds = [
            (fr >= fg) & (fg >= fb), (fr >= fb) & (fb > fg), (fb > fr) & (fr >= fg),
            (fg > fr) & (fr >= fb), (fg >= fb) & (fb > fr), (fb > fg) & (fg > fr),
        ]
        # (first, second) corner offsets for each tetrahedron
        tets = [
            ((1, 0, 0), (1, 1, 0), fr, fg, fb), ((1, 0, 0), (1, 0, 1), fr, fb, fg),
            ((0, 0, 1), (1, 0, 1), fb, fr, fg), ((0, 1, 0), (1, 1, 0), fg, fr, fb),
            ((0, 1, 0), (0, 1, 1), fg, fb, fr), ((0, 0, 1), (0, 1, 1), fb, fg, fr),
        ]
        out[:] = 0
        for cond, (a, b, t1, t2, t3) in zip(conds, tets, strict=True):
            v = (1 - t1) * p000 + (t1 - t2) * c(*a) + (t2 - t3) * c(*b) + t3 * p111
            out = np.where(cond, v, out)
    return np.clip(out * 255.0 + 0.5, 0, 255).astype(np.uint8)


def main():
    cube, photo = sys.argv[1], sys.argv[2]
    t = time.perf_counter()
    size, lo, hi, lut = parse_cube(cube)
    t_parse = time.perf_counter() - t
    flat = lut.reshape(-1, 3).ravel().tolist()
    t = time.perf_counter()
    filt = ImageFilter.Color3DLUT(size, flat)
    t_build = time.perf_counter() - t

    src = Image.open(photo).convert("RGB")
    big = src.resize((6000, 4000), Image.Resampling.BICUBIC)
    hd = src.copy()
    hd.thumbnail((2000, 2000))
    thumb = src.copy()
    thumb.thumbnail((260, 260))

    print(f"LUT {size}^3  parse {t_parse*1000:.0f} ms  build filter {t_build*1000:.0f} ms")
    for name, im in [("24MP", big), ("2000px", hd), ("260px", thumb)]:
        ts = []
        for _ in range(3):
            t = time.perf_counter()
            im.filter(filt)
            ts.append(time.perf_counter() - t)
        print(f"  Pillow {name:6s} {min(ts)*1000:7.1f} ms")

    pil = np.asarray(hd.filter(filt)).astype(int)
    t = time.perf_counter()
    tri = apply_numpy(hd, size, lut, tetra=False).astype(int)
    t_np = time.perf_counter() - t
    tet = apply_numpy(hd, size, lut, tetra=True).astype(int)
    d1 = np.abs(pil - tri)
    d2 = np.abs(tri - tet)
    print(f"  numpy trilinear 2000px {t_np*1000:.0f} ms")
    print(f"  Pillow vs float trilinear: max {d1.max()}  mean {d1.mean():.3f}  >1: {(d1>1).mean()*100:.3f}%")
    print(f"  trilinear vs tetrahedral : max {d2.max()}  mean {d2.mean():.3f}  >2: {(d2>2).mean()*100:.3f}%")


if __name__ == "__main__":
    main()
