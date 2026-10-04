"""ICC profiles the previews need that Pillow can't make.

A camera set to Adobe RGB records that in EXIF (ColorSpace 0xFFFF,
"uncalibrated", with interoperability index R03) and renders its embedded
JPEG in Adobe RGB without an ICC profile. Shown as sRGB it looks flat. The
preview gets this profile so it shows as the camera rendered it.
"""

from __future__ import annotations

import struct
from functools import cache

# Adobe RGB (1998): its primaries adapted to the ICC's D50 connection space
# (Bradford), as in Adobe's own profile, and a pure gamma of 563/256.
_D50 = (0.9642, 1.0, 0.8249)
_D65_WHITE = (0.95045, 1.0, 1.08905)
_RED = (0.60974, 0.31111, 0.01947)
_GREEN = (0.20528, 0.62567, 0.06087)
_BLUE = (0.14919, 0.06322, 0.74457)
_GAMMA = 563  # u8Fixed8: 2.19921875


def _s15f16(value: float) -> bytes:
    return struct.pack(">i", round(value * 65536))


def _xyz(xyz: tuple[float, float, float]) -> bytes:
    return b"XYZ " + bytes(4) + b"".join(_s15f16(v) for v in xyz)


def _text(text: str) -> bytes:
    return b"text" + bytes(4) + text.encode("ascii") + b"\x00"


def _desc(text: str) -> bytes:
    ascii_text = text.encode("ascii") + b"\x00"
    # textDescriptionType: ASCII, then empty Unicode and ScriptCode parts.
    return b"desc" + bytes(4) + struct.pack(">I", len(ascii_text)) + ascii_text + bytes(4 + 4 + 2 + 1 + 67)


def _curve(gamma_u8f8: int) -> bytes:
    return b"curv" + bytes(4) + struct.pack(">IH", 1, gamma_u8f8) + bytes(2)


@cache
def adobe_rgb_icc() -> bytes:
    """An ICC v2 matrix/TRC display profile equivalent to Adobe RGB (1998)."""
    trc = _curve(_GAMMA)
    tags = [
        (b"desc", _desc("Adobe RGB (1998) compatible")),
        (b"cprt", _text("No copyright, use freely")),
        (b"wtpt", _xyz(_D65_WHITE)),
        (b"rXYZ", _xyz(_RED)),
        (b"gXYZ", _xyz(_GREEN)),
        (b"bXYZ", _xyz(_BLUE)),
        (b"rTRC", trc),
        (b"gTRC", trc),
        (b"bTRC", trc),
    ]
    offset = 128 + 4 + 12 * len(tags)
    table, data = [], b""
    shared: dict[bytes, int] = {}
    for signature, body in tags:
        if body in shared:  # the three TRCs share one curve
            table.append(struct.pack(">4sII", signature, shared[body], len(body)))
            continue
        while (offset + len(data)) % 4:
            data += b"\x00"
        shared[body] = offset + len(data)
        table.append(struct.pack(">4sII", signature, offset + len(data), len(body)))
        data += body
    body = struct.pack(">I", len(tags)) + b"".join(table) + data
    size = 128 + len(body)
    header = (
        struct.pack(">I", size) + b"none" + struct.pack(">I", 0x02100000) + b"mntr" + b"RGB " + b"XYZ "
        + bytes(12) + b"acsp" + b"APPL" + bytes(4) + bytes(4) + bytes(4) + bytes(8) + struct.pack(">I", 0)
        + b"".join(_s15f16(v) for v in _D50) + bytes(4) + bytes(16) + bytes(28)
    )
    assert len(header) == 128
    return header + body
