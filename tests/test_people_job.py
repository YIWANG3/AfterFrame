from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, create_job, get_job, init_db, request_job_resume, set_catalog_path
from media_workspace.job_runner import JobPaused, run_people_index_job


class PeopleIndexJobTest(unittest.TestCase):
    def test_worker_results_are_checkpointed_and_second_run_skips(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            source = root / "portrait.jpg"
            source.write_bytes(b"not-a-real-image-the-fake-worker-does-not-decode-it")
            worker = self._write_fake_worker(root)
            model = root / "ArcFaceR100.mlpackage"
            model.write_bytes(b"model-placeholder")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            connection.execute(
                """
                INSERT INTO assets (
                    asset_id, asset_type, canonical_path, stem, normalized_stem,
                    stem_key, extension, fingerprint, file_size, modified_time
                ) VALUES (?, 'image', ?, 'portrait', 'portrait', 'portrait', '.jpg', 'fingerprint', 1, '2026-07-10T00:00:00Z')
                """,
                ("asset-1", str(source)),
            )
            connection.commit()

            first = create_job(connection, "people_index", priority=100)
            first_result = run_people_index_job(
                connection,
                first["job_id"],
                model_id="arcface-r100",
                model_version="test-v1",
                model_path=model,
                manifest_hash="manifest-hash",
                worker_path=worker,
            )
            self.assertEqual(first_result["analyzed"], 1)
            self.assertEqual(first_result["faces"], 1)
            self.assertEqual(get_job(connection, first["job_id"])["resume_cursor"], {"offset": 1, "total": 1})

            second = create_job(connection, "people_index")
            second_result = run_people_index_job(
                connection,
                second["job_id"],
                model_id="arcface-r100",
                model_version="test-v1",
                model_path=model,
                manifest_hash="manifest-hash",
                worker_path=worker,
            )
            self.assertEqual(second_result["analyzed"], 0)
            self.assertEqual(second_result["skipped"], 1)
            self.assertEqual(get_job(connection, second["job_id"])["status"], "succeeded")

    def test_paused_job_resumes_from_the_last_committed_asset(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            catalog = ensure_catalog(root / "demo.afcatalog")
            worker = self._write_fake_worker(root)
            model = root / "ArcFaceR100.mlpackage"
            model.write_bytes(b"model-placeholder")

            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            for index in (1, 2):
                source = root / f"portrait-{index}.jpg"
                source.write_bytes(f"photo-{index}".encode())
                connection.execute(
                    """
                    INSERT INTO assets (
                        asset_id, asset_type, canonical_path, stem, normalized_stem,
                        stem_key, extension, fingerprint, file_size, modified_time
                    ) VALUES (?, 'image', ?, ?, ?, ?, '.jpg', 'fingerprint', 1, '2026-07-10T00:00:00Z')
                    """,
                    (f"asset-{index}", str(source), f"portrait-{index}", f"portrait-{index}", f"portrait-{index}"),
                )
            connection.commit()

            job = create_job(connection, "people_index")
            # Simulate a user pause after the first face set committed. This is
            # the exact checkpoint boundary used by the production loop.
            with patch("media_workspace.job_runner._check_pause", side_effect=[None, JobPaused()]):
                paused = run_people_index_job(
                    connection,
                    job["job_id"],
                    model_id="arcface-r100",
                    model_version="test-v1",
                    model_path=model,
                    manifest_hash="manifest-hash",
                    worker_path=worker,
                )
            self.assertEqual(paused["processed"], 1)
            self.assertEqual(get_job(connection, job["job_id"])["status"], "paused")
            self.assertEqual(get_job(connection, job["job_id"])["resume_cursor"], {"offset": 1, "total": 2})

            request_job_resume(connection, job["job_id"])
            resumed = run_people_index_job(
                connection,
                job["job_id"],
                model_id="arcface-r100",
                model_version="test-v1",
                model_path=model,
                manifest_hash="manifest-hash",
                worker_path=worker,
            )
            self.assertEqual(resumed["processed"], 2)
            self.assertEqual(resumed["groups"], 1)
            self.assertEqual(get_job(connection, job["job_id"])["status"], "succeeded")

    def _write_fake_worker(self, root: Path) -> Path:
        worker = root / "fake-people-worker.py"
        embedding = [1.0 / math.sqrt(512)] * 512
        code = f'''#!{sys.executable}
import json
import sys

embedding = {json.dumps(embedding)}
for line in sys.stdin:
    request = json.loads(line)
    if request.get("known_input_hash") == "input-hash-a":
        response = {{"id": request["id"], "ok": True, "skipped": True, "input_hash": "input-hash-a", "image_size": {{"width": 100, "height": 100}}, "faces": [], "error": None}}
    else:
        response = {{"id": request["id"], "ok": True, "skipped": False, "input_hash": "input-hash-a", "image_size": {{"width": 100, "height": 100}}, "faces": [{{"bounding_box": [0.1, 0.1, 0.5, 0.5], "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.1, 0.3, 0.2, 0.3], "confidence": 1.0, "quality": "standard", "embedding": embedding}}], "error": None}}
    print(json.dumps(response), flush=True)
'''
        worker.write_text(code, encoding="utf-8")
        worker.chmod(worker.stat().st_mode | os.stat(worker).st_mode | 0o111)
        return worker


if __name__ == "__main__":
    unittest.main()
