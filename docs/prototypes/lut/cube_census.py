"""Census of the .cube files on a machine: what a real-world parser meets.

    mdfind -name .cube | grep -iE '\\.cube$' > cubes.txt
    python cube_census.py cubes.txt

Reports sizes, header keywords, BOM / CRLF, 1D-only and 1D+3D (shaper) files,
domains other than 0..1, tables with values outside 0..1, byte-identical
duplicates, and how many look like Log / camera-input LUTs by name or folder.
Reads every file in full: on an external drive with a few GB of LUTs this takes
minutes.
"""
import collections
import hashlib
import os
import re
import sys

LOG_NAME = re.compile(
    r"s-?log|f-?log|v-?log|c-?log|d-?log|n-?log|l-?log|i-?log|logc|log[ _-]?film|alexa|\blog\b|red ?log|hlg|bmpcc|bmd ?film|to ?rec ?709|709 ?to",
    re.I,
)


def main(listing):
    paths = [p for p in open(listing, encoding="utf-8").read().splitlines() if p.strip()]
    keywords, sizes, odd, domains = (collections.Counter() for _ in range(4))
    hashes, dupes, out_of_range, log_named = set(), 0, 0, 0
    for path in paths:
        try:
            data = open(path, "rb").read()
        except OSError:
            odd["unreadable"] += 1
            continue
        digest = hashlib.sha1(data).hexdigest()
        if digest in hashes:
            dupes += 1
        hashes.add(digest)
        if data.startswith(b"\xef\xbb\xbf"):
            odd["bom"] += 1
        if b"\r\n" in data:
            odd["crlf"] += 1
        if LOG_NAME.search(os.path.basename(path)) or LOG_NAME.search(os.path.basename(os.path.dirname(path))):
            log_named += 1
        has1d = has3d = False
        lo, hi = 1e9, -1e9
        for line in data.decode("utf-8", "replace").splitlines():
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            if s[0].isalpha():
                key = s.split()[0]
                keywords[key] += 1
                if key == "LUT_3D_SIZE":
                    sizes[f"3D {s.split()[1]}"] += 1
                    has3d = True
                elif key == "LUT_1D_SIZE":
                    sizes[f"1D {s.split()[1]}"] += 1
                    has1d = True
                elif key.startswith("DOMAIN") or key.endswith("INPUT_RANGE"):
                    values = [float(v) for v in s.split()[1:]]
                    if any(abs(v) > 1e-6 and abs(v - 1) > 1e-6 for v in values):
                        domains[os.path.basename(path)] += 1
                continue
            try:
                values = [float(v) for v in s.split()[:3]]
            except ValueError:
                continue
            lo, hi = min(lo, *values), max(hi, *values)
        if has1d and has3d:
            odd["1D+3D shaper"] += 1
        elif has1d:
            odd["1D only"] += 1
        if lo < -1e-4 or hi > 1 + 1e-4:
            out_of_range += 1
    print(f"{len(paths)} files, {len(hashes)} unique ({dupes} byte-identical duplicates)")
    print("sizes:", sizes.most_common())
    print("keywords:", keywords.most_common())
    print("oddities:", dict(odd))
    print(f"domains other than 0..1: {len(domains)} files, e.g. {list(domains)[:8]}")
    print(f"tables with values outside 0..1: {out_of_range}")
    print(f"named for Log / camera input (file or folder name): {log_named}")


if __name__ == "__main__":
    main(sys.argv[1])
