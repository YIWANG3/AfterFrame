"""Camera names as people say them, and each camera's crop factor.

EXIF names a camera the way its maker's firmware does: Sony writes
"ILCE-7CM2" for the A7C II, Ricoh "RICOH IMAGING COMPANY, LTD." for the make,
Nikon "NIKON Z 6_2". The statistics page shows `camera_label`, and keeps the
EXIF model alongside it for the gallery filter, which matches the stored
value.

`crop_factor` turns a physical focal length into its 35 mm equivalent
(stats: the focal-length chart). It is a table of known bodies, not an EXIF
read: the catalog stores the physical focal length only. Phones, drones and
anything not listed answer None, and the chart leaves them out rather than
guess.
"""
from __future__ import annotations

import re

# EXIF make → the brand as written. Anything else: its first word, title-cased
# when the maker shouts it ("PENTAX" → "Pentax").
_BRANDS = {
    "fujifilm": "Fujifilm",
    "sony": "Sony",
    "canon": "Canon",
    "nikon": "Nikon",
    "nikon corporation": "Nikon",
    "ricoh": "Ricoh",
    "ricoh imaging company, ltd.": "Ricoh",
    "pentax": "Pentax",
    "pentax corporation": "Pentax",
    "olympus": "Olympus",
    "olympus corporation": "Olympus",
    "olympus imaging corp.": "Olympus",
    "om digital solutions": "OM System",
    "panasonic": "Panasonic",
    "leica": "Leica",
    "leica camera ag": "Leica",
    "hasselblad": "Hasselblad",
    "sigma": "Sigma",
    "dji": "DJI",
    "apple": "Apple",
    "google": "Google",
    "samsung": "Samsung",
    "xiaomi": "Xiaomi",
    "huawei": "Huawei",
}
# Brands whose model already says what it is: "iPhone 16 Pro", "Pixel 9".
_MODEL_ONLY = {"Apple", "Google"}
_ROMAN = {"2": "II", "3": "III", "4": "IV", "5": "V", "6": "VI", "7": "VII", "8": "VIII"}


def _brand(make: str | None, model: str) -> str | None:
    if make and make.strip():
        key = make.strip().lower()
        if key in _BRANDS:
            return _BRANDS[key]
        word = make.strip().split()[0].rstrip(",")
        return word.title() if word.isupper() and len(word) > 3 else word
    # No make: a model that starts with a known brand still names it.
    first = model.split()[0].lower() if model.split() else ""
    return _BRANDS.get(first)


def _sony(model: str) -> str:
    # ILCE-7CM2 → A7C II, ILCE-7RM5 → A7R V, ILCE-6700 → A6700, ILCE-1 → A1.
    match = re.fullmatch(r"ILCE-(\w+?)(?:M(\d))?", model)
    if match:
        body, mark = match.groups()
        return f"A{body}" + (f" {_ROMAN.get(mark, mark)}" if mark else "")
    match = re.fullmatch(r"(DSC-RX\w+?)(?:M(\d))?", model)
    if match:
        body, mark = match.groups()
        return body.replace("DSC-", "") + (f" {_ROMAN.get(mark, mark)}" if mark else "")
    return model


def camera_label(make: str | None, model: str | None) -> str | None:
    """"Sony A7C II" for ("SONY", "ILCE-7CM2"); None without a model."""
    if not model or not model.strip():
        return None
    model = " ".join(model.split())
    brand = _brand(make, model)
    rest = model
    if brand and rest.lower().startswith(brand.lower()):
        rest = rest[len(brand):].strip()
    if brand == "Ricoh" and rest.upper().startswith("PENTAX "):
        # Pentax bodies made since Ricoh bought the brand carry Ricoh's make.
        brand, rest = "Pentax", rest[7:]
    if brand == "Sony":
        rest = _sony(rest)
    elif brand == "Nikon":
        rest = re.sub(r"_(\d)$", lambda m: f" {_ROMAN.get(m.group(1), m.group(1))}", rest)
    if not rest:
        return brand
    if not brand or brand in _MODEL_ONLY:
        return rest
    return f"{brand} {rest}"


# (brand, model pattern, crop factor), first match wins; matched against
# camera_label's model part. Medium format is 0.79, full frame 1.
_CROPS: list[tuple[str, str, float]] = [
    ("Fujifilm", r"GFX.*", 0.79),
    ("Fujifilm", r"X.*", 1.5),
    ("Sony", r"A(7\w*|9\w*|1)( .*)?|RX1R?( .*)?|ILME-FX[36]", 1.0),
    ("Sony", r"A\d{4}.*|A5\d{3}.*|ZV-E10.*|NEX.*|ILME-FX30", 1.5),
    ("Sony", r"RX100.*|ZV-1.*|RX10.*", 2.7),
    ("Canon", r"EOS R(7|10|50|100)\b.*|EOS (\d{2,4}D|M\d*|Rebel.*|Kiss.*)", 1.6),
    ("Canon", r"EOS (R\w*|1D.*|5D.*|6D.*)", 1.0),
    ("Canon", r"PowerShot G(5|7) X.*", 2.7),
    ("Nikon", r"Z ?(30|50|fc)\b.*|D(3\d{3}|5\d{3}|7\d{3}|300\w*|500)\b.*", 1.5),
    ("Nikon", r"Z ?(5|6|7|8|9|f)\b.*|D(3|4|5|6|600|610|700|750|780|800|810|850)\w*\b.*|Df", 1.0),
    ("Ricoh", r"GR.*", 1.53),
    ("Pentax", r"K-1.*", 1.0),
    ("Pentax", r"K.*", 1.5),
    ("Olympus", r".*", 2.0),
    ("OM System", r".*", 2.0),
    ("Panasonic", r"DC-S\d.*", 1.0),
    ("Panasonic", r"(DC|DMC)-G.*", 2.0),
    ("Leica", r"(CL|TL\d?)\b.*", 1.5),
    ("Leica", r"(Q|M|SL).*", 1.0),
    ("Hasselblad", r".*", 0.79),
    ("Sigma", r"fp.*", 1.0),
]


def crop_factor(label: str | None) -> float | None:
    """The crop factor for a camera_label, or None when it isn't known."""
    if not label:
        return None
    for brand, pattern, factor in _CROPS:
        if label == brand or not label.startswith(brand + " "):
            continue
        if re.fullmatch(pattern, label[len(brand) + 1:]):
            return factor
    return None
