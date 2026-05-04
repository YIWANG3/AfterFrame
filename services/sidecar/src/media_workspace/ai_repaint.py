from __future__ import annotations

import base64
import json
import mimetypes
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
OPENAI_API_BASE = "https://api.openai.com/v1"
DEFAULT_GEMINI_MODEL = "gemini-3-pro-image-preview"
DEFAULT_OPENAI_MODEL = "gpt-image-1"
NANOBANANA_PROVIDER = "nanobanana"
OPENAI_PROVIDER = "openai"
OPENAI_COMPATIBLE_PROVIDER = "openai_compatible"
JIMENG_PROVIDER = "jimeng"

JIMENG_MODELS = [
    {"id": "jimeng_t2i_v40", "name": "即梦 图片生成 4.0"},
    {"id": "jimeng_seedream46_cvtob", "name": "即梦 图片生成 4.6"},
    {"id": "jimeng_i2i_seed3_tilesr_cvtob", "name": "即梦 智能超清"},
]
DEFAULT_JIMENG_MODEL = "jimeng_t2i_v40"
GEMINI_MODELS_WITH_IMAGE_SIZE = {
    "gemini-3.1-flash-image-preview",
    "gemini-3-pro-image-preview",
}


GEMINI_FALLBACK_MODELS = [
    {"id": "gemini-2.0-flash-exp-image-generation", "name": "Gemini 2.0 Flash (Image)"},
    {"id": "gemini-2.0-flash-preview-image-generation", "name": "Gemini 2.0 Flash Preview"},
    {"id": "gemini-3-pro-image-preview", "name": "Gemini 3 Pro (Image)"},
    {"id": "gemini-3.1-flash-image-preview", "name": "Gemini 3.1 Flash (Image)"},
]

OPENAI_FALLBACK_MODELS = [
    {"id": "gpt-image-1", "name": "GPT Image 1"},
]


def list_gemini_models(api_key: str) -> list[dict[str, str]]:
    """Fetch Gemini models that support image generation."""
    request = Request(
        url=f"{GEMINI_API_BASE}/models",
        headers={"x-goog-api-key": api_key},
        method="GET",
    )
    try:
        with urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError):
        return GEMINI_FALLBACK_MODELS

    results: list[dict[str, str]] = []
    for m in body.get("models", []):
        name = m.get("name", "")
        model_id = name.split("/")[-1] if "/" in name else name
        methods = m.get("supportedGenerationMethods", [])
        if "generateContent" in methods and "image" in model_id.lower():
            results.append({"id": model_id, "name": m.get("displayName", model_id)})
    return results if results else GEMINI_FALLBACK_MODELS


def list_openai_models(api_key: str, base_url: str = OPENAI_API_BASE) -> list[dict[str, str]]:
    """Fetch OpenAI models that are image-related."""
    request = Request(
        url=f"{base_url}/models",
        headers={"Authorization": f"Bearer {api_key}", "User-Agent": "Framebase/1.0"},
        method="GET",
    )
    try:
        with urlopen(request, timeout=15) as response:
            body = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError):
        return OPENAI_FALLBACK_MODELS

    results: list[dict[str, str]] = []
    for m in body.get("data", []):
        mid = m.get("id", "")
        if "image" in mid or "dall-e" in mid:
            results.append({"id": mid, "name": mid})
    return results if results else OPENAI_FALLBACK_MODELS


def list_provider_models(provider: str, api_key: str, base_url: str | None = None) -> list[dict[str, str]]:
    """Return available models for a given provider."""
    if provider == OPENAI_PROVIDER:
        return list_openai_models(api_key)
    if provider == OPENAI_COMPATIBLE_PROVIDER:
        return list_openai_models(api_key, base_url=base_url or OPENAI_API_BASE)
    if provider == JIMENG_PROVIDER:
        return JIMENG_MODELS
    # nanobanana uses Gemini under the hood
    return list_gemini_models(api_key)


@dataclass(slots=True)
class RepaintResult:
    provider: str
    model: str
    output_path: str
    mime_type: str
    prompt: str
    notes: list[str]


def _detect_mime_type(path: Path) -> str:
    mime_type, _ = mimetypes.guess_type(str(path))
    if not mime_type or not mime_type.startswith("image/"):
        raise ValueError(f"Unsupported image type for {path}")
    return mime_type


def _image_ext_from_mime(mime_type: str) -> str:
    if mime_type == "image/png":
        return ".png"
    if mime_type == "image/webp":
        return ".webp"
    return ".jpg"


def _write_output_bytes(target: Path, image_bytes: bytes, mime_type: str) -> Path:
    resolved = target
    if target.is_dir():
        resolved = target / f"ai-repaint-output{_image_ext_from_mime(mime_type)}"
    elif not target.suffix:
        resolved = target.with_suffix(_image_ext_from_mime(mime_type))
    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_bytes(image_bytes)
    return resolved


def run_mock_repaint(input_path: Path, output_path: Path, prompt: str) -> RepaintResult:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(input_path, output_path)
    return RepaintResult(
        provider="mock",
        model="mock-pass-through",
        output_path=str(output_path),
        mime_type=_detect_mime_type(input_path),
        prompt=prompt,
        notes=["Mock mode copied the input image to validate the local repaint flow."],
    )


def run_gemini_repaint(
    input_path: Path,
    output_path: Path,
    prompt: str,
    *,
    api_key: str | None,
    model: str = DEFAULT_GEMINI_MODEL,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
) -> RepaintResult:
    effective_key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not effective_key:
        raise ValueError("Missing Gemini API key. Set GEMINI_API_KEY or pass --api-key.")

    mime_type = _detect_mime_type(input_path)
    image_bytes = input_path.read_bytes()
    payload: dict[str, Any] = {
        "contents": [
            {
                "parts": [
                    {"text": prompt},
                    {
                        "inline_data": {
                            "mime_type": mime_type,
                            "data": base64.b64encode(image_bytes).decode("utf-8"),
                        }
                    },
                ]
            }
        ],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
        },
    }

    image_config: dict[str, Any] = {}
    if aspect_ratio:
        image_config["aspectRatio"] = aspect_ratio
    if image_size and model in GEMINI_MODELS_WITH_IMAGE_SIZE:
        image_config["imageSize"] = image_size
    if image_config:
        payload["generationConfig"]["imageConfig"] = image_config

    request = Request(
        url=f"{GEMINI_API_BASE}/models/{model}:generateContent",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": effective_key,
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=300) as response:
            body = response.read().decode("utf-8")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Gemini request failed: HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"Gemini request failed: {error.reason}") from error

    payload = json.loads(body)
    parts = (
        payload.get("candidates", [{}])[0]
        .get("content", {})
        .get("parts", [])
    )
    text_notes: list[str] = []
    output_bytes: bytes | None = None
    output_mime = "image/png"

    for part in parts:
        text = part.get("text")
        if text:
            text_notes.append(text)
        inline_data = part.get("inlineData") or part.get("inline_data")
        if inline_data and inline_data.get("data"):
            output_bytes = base64.b64decode(inline_data["data"])
            output_mime = inline_data.get("mimeType") or inline_data.get("mime_type") or output_mime
            break

    if output_bytes is None:
        raise RuntimeError(f"Gemini returned no image output: {json.dumps(payload, indent=2)}")

    written_path = _write_output_bytes(output_path, output_bytes, output_mime)
    return RepaintResult(
        provider="gemini",
        model=model,
        output_path=str(written_path),
        mime_type=output_mime,
        prompt=prompt,
        notes=text_notes,
    )


def run_nanobanana_repaint(
    input_path: Path,
    output_path: Path,
    prompt: str,
    *,
    api_key: str | None,
    model: str = DEFAULT_GEMINI_MODEL,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
) -> RepaintResult:
    result = run_gemini_repaint(
        input_path=input_path,
        output_path=output_path,
        prompt=prompt,
        api_key=api_key,
        model=model,
        aspect_ratio=aspect_ratio,
        image_size=image_size,
    )
    return RepaintResult(
        provider=NANOBANANA_PROVIDER,
        model=result.model,
        output_path=result.output_path,
        mime_type=result.mime_type,
        prompt=result.prompt,
        notes=result.notes,
    )


def _openai_size_from_resolution(resolution: str | None, aspect_ratio: str | None) -> str:
    """Map resolution + aspect_ratio hints to an OpenAI image size string."""
    if aspect_ratio == "1:1":
        return "1024x1024"
    if aspect_ratio in ("9:16", "3:4"):
        return "1024x1536"
    if aspect_ratio in ("16:9", "4:3"):
        return "1536x1024"
    # Default: auto (let the API decide based on input)
    return "auto"


def run_openai_repaint(
    input_path: Path,
    output_path: Path,
    prompt: str,
    *,
    api_key: str | None,
    model: str = DEFAULT_OPENAI_MODEL,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
    base_url: str = OPENAI_API_BASE,
) -> RepaintResult:
    effective_key = api_key or os.environ.get("OPENAI_API_KEY")
    if not effective_key:
        raise ValueError("Missing OpenAI API key. Set OPENAI_API_KEY or pass --api-key.")

    mime_type = _detect_mime_type(input_path)
    image_bytes = input_path.read_bytes()

    # Build multipart/form-data request
    boundary = f"----FormBoundary{base64.b64encode(os.urandom(12)).decode()}"
    parts: list[bytes] = []

    def _add_field(name: str, value: str) -> None:
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n".encode("utf-8")
        )

    def _add_file(name: str, filename: str, content: bytes, content_type: str) -> None:
        parts.append(
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
            + content
            + b"\r\n"
        )

    _add_field("model", model)
    _add_field("prompt", prompt)
    _add_file("image[]", input_path.name, image_bytes, mime_type)

    size = _openai_size_from_resolution(image_size, aspect_ratio)
    _add_field("size", size)

    body = b"".join(parts) + f"--{boundary}--\r\n".encode("utf-8")

    request = Request(
        url=f"{base_url}/images/edits",
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {effective_key}",
            "User-Agent": "Framebase/1.0",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=300) as response:
            resp_body = response.read().decode("utf-8")
    except HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenAI request failed: HTTP {error.code}: {detail}") from error
    except URLError as error:
        raise RuntimeError(f"OpenAI request failed: {error.reason}") from error

    payload = json.loads(resp_body)
    data_items = payload.get("data", [])
    if not data_items:
        raise RuntimeError(f"OpenAI returned no image data: {json.dumps(payload, indent=2)}")

    item = data_items[0]
    b64 = item.get("b64_json")
    img_url = item.get("url")
    if b64:
        output_bytes = base64.b64decode(b64)
        output_mime = "image/png"
    elif img_url:
        with urlopen(img_url, timeout=120) as dl_resp:
            output_bytes = dl_resp.read()
        ct = dl_resp.headers.get("Content-Type", "image/png") if hasattr(dl_resp, "headers") else "image/png"
        output_mime = "image/jpeg" if "jpeg" in ct or "jpg" in ct else "image/png"
    else:
        raise RuntimeError("OpenAI response missing both b64_json and url.")

    written_path = _write_output_bytes(output_path, output_bytes, output_mime)
    return RepaintResult(
        provider=OPENAI_PROVIDER,
        model=model,
        output_path=str(written_path),
        mime_type=output_mime,
        prompt=prompt,
        notes=[],
    )


def _get_image_dimensions(data: bytes) -> tuple[int, int]:
    """Extract width, height from JPEG or PNG header bytes."""
    import struct
    if data[:8] == b'\x89PNG\r\n\x1a\n':
        # PNG: IHDR chunk starts at byte 16
        w, h = struct.unpack('>II', data[16:24])
        return w, h
    if data[:2] == b'\xff\xd8':
        # JPEG: scan for SOFn markers
        i = 2
        while i < len(data) - 9:
            if data[i] != 0xFF:
                break
            marker = data[i + 1]
            if marker in (0xC0, 0xC1, 0xC2):
                h, w = struct.unpack('>HH', data[i + 5:i + 9])
                return w, h
            length = struct.unpack('>H', data[i + 2:i + 4])[0]
            i += 2 + length
    raise ValueError("Cannot determine image dimensions")


def _make_white_mask_png(w: int, h: int) -> bytes:
    """Create a grayscale PNG of given dimensions, all pixels 255 (white)."""
    import struct
    import zlib
    # Grayscale 8-bit PNG
    ihdr_data = struct.pack('>IIBBBBB', w, h, 8, 0, 0, 0, 0)
    raw_rows = b''
    for _ in range(h):
        raw_rows += b'\x00' + b'\xff' * w  # filter byte + pixel data
    compressed = zlib.compress(raw_rows)

    def chunk(ctype: bytes, data: bytes) -> bytes:
        c = ctype + data
        crc = zlib.crc32(c) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)

    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr_data) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')


def _jimeng_size_params(aspect_ratio: str | None, image_size: str | None) -> dict[str, Any]:
    """Return width/height or size params for Jimeng based on aspect_ratio and resolution."""
    res_map = {"1k": 1024, "2k": 2048, "4k": 4096}
    base = res_map.get((image_size or "2k").lower(), 2048)
    ratio_map = {
        "1:1": (base, base),
        "4:3": (int(base * 1.155), int(base * 0.866)),
        "3:4": (int(base * 0.866), int(base * 1.155)),
        "16:9": (int(base * 1.333), int(base * 0.75)),
        "9:16": (int(base * 0.75), int(base * 1.333)),
    }
    if aspect_ratio and aspect_ratio in ratio_map:
        w, h = ratio_map[aspect_ratio]
        return {"width": w, "height": h}
    return {"size": base * base}


def run_jimeng_repaint(
    input_path: Path,
    output_path: Path,
    prompt: str,
    *,
    access_key_id: str | None,
    secret_access_key: str | None,
    model: str = DEFAULT_JIMENG_MODEL,
    aspect_ratio: str | None = None,
    image_size: str | None = None,
    scale: float | None = None,
) -> RepaintResult:
    ak = access_key_id or os.environ.get("VOLC_ACCESSKEY")
    sk = secret_access_key or os.environ.get("VOLC_SECRETKEY")
    if not ak or not sk:
        raise ValueError("Missing Volcengine AccessKey/SecretKey.")

    from volcengine.visual.VisualService import VisualService

    vs = VisualService()
    vs.set_ak(ak)
    vs.set_sk(sk)

    image_bytes = input_path.read_bytes()
    img_b64 = base64.b64encode(image_bytes).decode("utf-8")

    req_key = model or DEFAULT_JIMENG_MODEL

    # Build submit payload based on model type
    submit_body: dict[str, Any] = {
        "req_key": req_key,
        "prompt": prompt,
    }

    if req_key == "jimeng_i2i_seed3_tilesr_cvtob":
        # 智能超清 — no prompt, just image + resolution
        submit_body = {
            "req_key": req_key,
            "binary_data_base64": [img_b64],
            "resolution": (image_size or "4k").lower(),
        }
        if scale is not None:
            submit_body["scale"] = int(scale * 100)
    elif req_key == "jimeng_image2image_dream_inpaint":
        # Inpainting needs image + mask; for repaint without mask, use full white mask
        import struct
        import zlib
        # Get image dimensions from JPEG/PNG header
        raw = input_path.read_bytes()
        w, h = _get_image_dimensions(raw)
        # Build a grayscale PNG (all 255 = repaint everything)
        mask_png = _make_white_mask_png(w, h)
        mask_b64 = base64.b64encode(mask_png).decode("utf-8")
        submit_body["binary_data_base64"] = [img_b64, mask_b64]
    else:
        # 图片生成 4.0 / 4.6 — image-to-image via binary_data_base64
        submit_body["binary_data_base64"] = [img_b64]
        submit_body["force_single"] = True
        size_params = _jimeng_size_params(aspect_ratio, image_size)
        submit_body.update(size_params)
        if scale is not None:
            submit_body["scale"] = scale

    # Submit task
    submit_resp = vs.cv_sync2async_submit_task(submit_body)
    code = submit_resp.get("code")
    if code != 10000:
        msg = submit_resp.get("message", "Unknown error")
        raise RuntimeError(f"Jimeng submit failed ({code}): {msg}")

    task_id = submit_resp["data"]["task_id"]

    # Poll for result
    import time
    for attempt in range(180):  # up to ~6 minutes
        time.sleep(2)
        try:
            poll_resp = vs.cv_sync2async_get_result({
                "req_key": req_key,
                "task_id": task_id,
            })
        except Exception as exc:
            # Transient network errors — retry
            if attempt < 179:
                continue
            raise

        poll_code = poll_resp.get("code")
        if poll_code == 50430:
            # Concurrent limit — wait and retry
            time.sleep(5)
            continue
        if poll_code != 10000:
            msg = poll_resp.get("message", "Unknown error")
            raise RuntimeError(f"Jimeng poll failed ({poll_code}): {msg}")

        status = poll_resp.get("data", {}).get("status", "")
        if status == "done":
            break
        if status in ("not_found", "expired"):
            raise RuntimeError(f"Jimeng task {status}: {task_id}")
    else:
        raise RuntimeError(f"Jimeng task timed out: {task_id}")

    # Extract result image
    data = poll_resp.get("data", {})
    b64_list = data.get("binary_data_base64") or []
    url_list = data.get("image_urls") or []

    output_bytes: bytes | None = None
    output_mime = "image/png"

    if b64_list and b64_list[0]:
        output_bytes = base64.b64decode(b64_list[0])
    elif url_list:
        # Download from URL
        with urlopen(url_list[0], timeout=60) as resp:
            output_bytes = resp.read()
        content_type = resp.headers.get("Content-Type", "image/png")
        if "jpeg" in content_type or "jpg" in content_type:
            output_mime = "image/jpeg"

    if output_bytes is None:
        raise RuntimeError("Jimeng returned no image data")

    written_path = _write_output_bytes(output_path, output_bytes, output_mime)
    return RepaintResult(
        provider=JIMENG_PROVIDER,
        model=req_key,
        output_path=str(written_path),
        mime_type=output_mime,
        prompt=prompt,
        notes=[],
    )
