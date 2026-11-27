"""Time the real import (and people index) job runners, in process, without
changing the repository: the sidecar's own functions are wrapped with timers
before the CLI entry point runs them.

usage:
  measure.py import <catalog dir> <photos dir> [--generate-hd]
  measure.py people <catalog dir>

Prints a JSON report: wall time, CPU, and inclusive time per wrapped step,
split into the main (indexing / DB-writing) thread and worker threads.
"""

import contextlib
import io
import json
import os
import resource
import sqlite3
import sys
import threading
import time
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NATIVE = REPO / "apps/desktop/native"
# BENCH_SIDECAR_SRC points at another copy of services/sidecar/src (say an
# export of the commit before a change), to measure before and after on
# the same photos with the same script.
sys.path.insert(0, os.environ.get("BENCH_SIDECAR_SRC") or str(REPO / "services/sidecar/src"))
os.environ["EXIFTOOL_PATH"] = str(NATIVE / "exiftool")
os.environ["IMAGE_FEATURES_PATH"] = str(NATIVE / "bin/image-features")
os.environ["VIDEO_TOOL_PATH"] = str(NATIVE / "bin/video-tool")
os.environ["PEOPLE_WORKER_PATH"] = str(NATIVE / "bin/people-worker")

STATS: dict[str, list] = defaultdict(lambda: [0, 0.0])
LOCK = threading.Lock()
MAIN = threading.main_thread()
STATE = {"phase": "setup"}


def _record(label: str, seconds: float) -> None:
    where = "main" if threading.current_thread() is MAIN else "thread"
    with LOCK:
        entry = STATS[f"{where} | {label}"]
        entry[0] += 1
        entry[1] += seconds


def timed(label, fn):
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        try:
            return fn(*args, **kwargs)
        finally:
            _record(label() if callable(label) else label, time.perf_counter() - start)

    wrapper.__wrapped__ = fn
    return wrapper


def timed_gen(label, fn):
    """Time spent inside a generator's next(), i.e. producing items."""

    def wrapper(*args, **kwargs):
        gen = fn(*args, **kwargs)
        while True:
            start = time.perf_counter()
            try:
                item = next(gen)
            except StopIteration:
                _record(label, time.perf_counter() - start)
                return
            _record(label, time.perf_counter() - start)
            yield item

    return wrapper


def patch(owner, name, label=None, gen=False):
    """Wrap owner.name with a timer. Names an older checkout lacks are
    skipped, so one script measures before and after a change."""
    original = getattr(owner, name, None)
    if original is None:
        return
    owner_name = getattr(owner, "__name__", type(owner).__name__).replace("media_workspace.", "")
    label = label or f"{owner_name}.{name}"
    setattr(owner, name, (timed_gen if gen else timed)(label, original))


class TimedConnection(sqlite3.Connection):
    def commit(self):
        start = time.perf_counter()
        try:
            return super().commit()
        finally:
            _record(f"sqlite commit [{STATE['phase']}]", time.perf_counter() - start)

    def execute(self, *args, **kwargs):
        start = time.perf_counter()
        try:
            return super().execute(*args, **kwargs)
        finally:
            _record(f"sqlite execute [{STATE['phase']}]", time.perf_counter() - start)


_real_connect = sqlite3.connect


def _connect(*args, **kwargs):
    kwargs.setdefault("factory", TimedConnection)
    return _real_connect(*args, **kwargs)


sqlite3.connect = _connect

from media_workspace import cli, exiftool, job_runner, metadata, preview_service, reverse_lookup  # noqa: E402

# ── indexing (resolve_image_batch's loop, main thread) ──────────────────────
patch(reverse_lookup, "count_image_files", "index: walk #1 (count_image_files)")
patch(reverse_lookup, "iter_image_files", "index: walk #2 (iter_image_files next)", gen=True)
patch(reverse_lookup, "resolve_image", "index: resolve_image (per JPG/HEIC, incl.)")
patch(reverse_lookup, "index_raw_file", "index: index_raw_file (incl.)")
patch(reverse_lookup, "index_video_file", "index: index_video_file (incl.)")
patch(reverse_lookup, "extract_image_candidate", "index: extract_image_candidate (incl.)")
patch(metadata, "read_metadata", "index: read_metadata (incl.)")
patch(exiftool, "read", "index: exiftool.read (wait for tags)")
patch(metadata, "quick_fingerprint", "index: quick_fingerprint")
patch(metadata, "_pillow_size", "index: _pillow_size fallback")
for name in (
    "claim_moved_original", "_previous_asset_signature", "upsert_catalog_root", "upsert_image_asset",
    "get_registry", "shortlist_candidates", "score_candidate", "upsert_registry", "pair_asset",
    "report_progress", "validate_source_ready",
):
    patch(reverse_lookup, name, f"index: {name}")

_real_resolve_batch = job_runner.resolve_image_batch


def _resolve_batch(*args, **kwargs):
    STATE["phase"] = "index"
    start = time.perf_counter()
    try:
        return _real_resolve_batch(*args, **kwargs)
    finally:
        _record("PHASE index (resolve_image_batch incl. inline previews)", time.perf_counter() - start)
        STATE["phase"] = "after-index"


job_runner.resolve_image_batch = _resolve_batch

# ── previews ────────────────────────────────────────────────────────────────
_real_generate_batch = preview_service.PreviewService.generate_batch


def _generate_batch(self, connection, kind, asset_type=None, **kwargs):
    outer = STATE["phase"]
    label = (
        "PREVIEWS inline batches during index" if outer == "index"
        else f"PREVIEWS pass after index ({kind}, {asset_type or 'all'})"
    )
    STATE["phase"] = "previews-inline" if outer == "index" else "previews-pass"
    start = time.perf_counter()
    try:
        return _real_generate_batch(self, connection, kind, asset_type, **kwargs)
    finally:
        _record(label, time.perf_counter() - start)
        STATE["phase"] = outer


preview_service.PreviewService.generate_batch = _generate_batch
patch(preview_service.PreviewService, "generate_for_row", "render: generate_for_row (incl.)")
patch(preview_service.PreviewService, "_render_with_pillow", "render: _render_with_pillow")
patch(preview_service.PreviewService, "_render_raw", "render: _render_raw")
patch(preview_service.PreviewService, "_preview_on_disk", "previews: _preview_on_disk")
patch(preview_service.VisualAnalyzer, "measure", "render: VisualAnalyzer.measure (hash + feature print)")
patch(preview_service.VisualAnalyzer, "store", "previews: VisualAnalyzer.store")
patch(preview_service, "wait", "previews: wait() for a render (idle)")
patch(preview_service, "analyze_asset_colors", "previews: analyze_asset_colors")
patch(preview_service, "extract_palette", "render: extract_palette")
patch(preview_service, "replace_asset_colors", "previews: replace_asset_colors")
patch(preview_service, "set_display_shape", "previews: set_display_shape")
patch(preview_service, "preview_shape", "previews: preview_shape")
patch(preview_service, "upsert_preview_entry", "previews: upsert_preview_entry")
patch(preview_service, "list_assets_for_preview", "previews: list_assets_for_preview")
patch(job_runner, "update_job", "job: update_job (progress writes)")
if os.environ.get("BENCH_WORKERS"):
    preview_service._MAX_WORKERS = int(os.environ["BENCH_WORKERS"])


def _report(wall: float, cpu_self: float, cpu_children: float, extra: dict) -> None:
    rows = sorted(STATS.items(), key=lambda kv: -kv[1][1])
    out = {
        "wall_s": round(wall, 2),
        "cpu_self_s": round(cpu_self, 2),
        "cpu_children_s": round(cpu_children, 2),
        "avg_cores_busy": round((cpu_self + cpu_children) / wall, 2) if wall else None,
        **extra,
        "steps": {label: {"calls": calls, "total_s": round(total, 3)} for label, (calls, total) in rows},
    }
    print(json.dumps(out, indent=1, ensure_ascii=False))


def _new_job(catalog_dir: Path, job_type: str, payload: dict) -> str:
    with contextlib.redirect_stdout(io.StringIO()) as buf:
        cli.main(["--catalog", str(catalog_dir), "create-job", "--job-type", job_type, "--payload-json", json.dumps(payload)])
    return json.loads(buf.getvalue())["job_id"]


def _run(argv: list[str]) -> str:
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = cli.main(argv)
    if code not in (0, None):
        raise SystemExit(f"runner exited {code}")
    return out.getvalue()


def main() -> None:
    what = sys.argv[1]
    catalog_dir = Path(sys.argv[2])
    usage0 = resource.getrusage(resource.RUSAGE_SELF)
    child0 = resource.getrusage(resource.RUSAGE_CHILDREN)
    extra: dict = {}
    if what == "import":
        photos = Path(sys.argv[3])
        job_id = _new_job(catalog_dir, "import", {"image_dirs": [str(photos)], "mode": "processed_only"})
        STATE["phase"] = "job"
        start = time.perf_counter()
        argv = ["--catalog", str(catalog_dir), "run-import-job", "--job-id", job_id, "--mode", "processed_only",
                "--image-dir", str(photos)]
        if "--generate-hd" in sys.argv:
            argv.append("--generate-hd")
        result = json.loads(_run(argv))
        wall = time.perf_counter() - start
        extra["phase_results"] = result.get("phase_results")
    elif what == "people":
        job_id = _new_job(catalog_dir, "people_index", {})
        STATE["phase"] = "people"
        start = time.perf_counter()
        _run([
            "--catalog", str(catalog_dir), "run-people-index-job", "--job-id", job_id,
            "--model-id", "arcface-r100-coreml", "--model-version", "b51b655",
            "--model-path", str(NATIVE / "FaceEmbedding.mlpackage"),
            "--manifest-hash", "743cae41246e637e62e67224211bafd71f2b297dcc696523ed8b4aeaa7613d6c",
            "--worker-path", str(NATIVE / "bin/people-worker"),
        ])
        wall = time.perf_counter() - start
    else:
        raise SystemExit("import | people")
    # Close the ExifTool pool so its processes are reaped and their CPU counted.
    pool = exiftool._shared
    if pool is not None:
        pool.close()
    usage1 = resource.getrusage(resource.RUSAGE_SELF)
    child1 = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu_self = (usage1.ru_utime + usage1.ru_stime) - (usage0.ru_utime + usage0.ru_stime)
    cpu_children = (child1.ru_utime + child1.ru_stime) - (child0.ru_utime + child0.ru_stime)
    _report(wall, cpu_self, cpu_children, extra)


if __name__ == "__main__":
    main()
