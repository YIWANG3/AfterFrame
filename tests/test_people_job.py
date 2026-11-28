from __future__ import annotations

import json
import math
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, create_job, get_job, init_db, request_job_resume, set_catalog_path
from media_workspace.job_runner import JobCancelled, JobPaused, run_people_index_job


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
            # The unchanged file was skipped by the stat gate — the worker never
            # received a second request.
            worker_log = root / "worker-requests.log"
            self.assertEqual(len(worker_log.read_text().splitlines()), 1)

            # A changed mtime defeats the stat gate; the worker's pixel-hash
            # tier answers "skipped" and the stored stat is refreshed…
            os.utime(source, (source.stat().st_atime, source.stat().st_mtime + 5))
            third = create_job(connection, "people_index")
            third_result = run_people_index_job(
                connection,
                third["job_id"],
                model_id="arcface-r100",
                model_version="test-v1",
                model_path=model,
                manifest_hash="manifest-hash",
                worker_path=worker,
            )
            self.assertEqual(third_result["skipped"], 1)
            self.assertEqual(len(worker_log.read_text().splitlines()), 2)

            # …so the next run is back to skipping without a worker round trip.
            fourth = create_job(connection, "people_index")
            fourth_result = run_people_index_job(
                connection,
                fourth["job_id"],
                model_id="arcface-r100",
                model_version="test-v1",
                model_path=model,
                manifest_hash="manifest-hash",
                worker_path=worker,
            )
            self.assertEqual(fourth_result["skipped"], 1)
            self.assertEqual(len(worker_log.read_text().splitlines()), 2)
            connection.close()

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
            connection.close()

    def test_candidates_appear_mid_scan_with_periodic_clustering(self) -> None:
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

            # With cluster_every=1 the runner re-clusters after every analyzed
            # asset, so candidates surface mid-scan instead of only at the end:
            # two interim passes plus the final one.
            import media_workspace.job_runner as job_runner_module
            real_rebuild = job_runner_module.rebuild_candidate_groups
            calls: list[int] = []

            def counting_rebuild(*args, **kwargs):
                calls.append(1)
                return real_rebuild(*args, **kwargs)

            job = create_job(connection, "people_index")
            with patch.object(job_runner_module, "rebuild_candidate_groups", side_effect=counting_rebuild):
                result = run_people_index_job(
                    connection,
                    job["job_id"],
                    model_id="arcface-r100",
                    model_version="test-v1",
                    model_path=model,
                    manifest_hash="manifest-hash",
                    worker_path=worker,
                    cluster_every=1,
                )
            self.assertEqual(len(calls), 3, "expected 2 interim clustering passes + 1 final")
            self.assertEqual(result["groups"], 1)
            connection.close()

    def test_a_worker_chatty_on_stderr_does_not_stall_the_scan(self) -> None:
        # Frameworks inside the worker print to stderr (the real worker sends
        # their stdout chatter there too). More than a pipe holds must not
        # block the worker, so the runner has to read stderr as it goes.
        outcome: dict[str, dict] = {}

        def scan() -> None:
            with tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                connection, model = self._seed_catalog(root, assets=3)
                worker = self._write_fake_worker(root, stderr_per_request=256 * 1024)
                job = create_job(connection, "people_index")
                outcome["result"] = run_people_index_job(
                    connection,
                    job["job_id"],
                    model_id="arcface-r100",
                    model_version="test-v1",
                    model_path=model,
                    manifest_hash="manifest-hash",
                    worker_path=worker,
                )
                connection.close()

        runner = threading.Thread(target=scan, daemon=True)
        runner.start()
        runner.join(timeout=60)
        self.assertFalse(runner.is_alive(), "the worker blocked writing to a full stderr pipe")
        self.assertEqual(outcome["result"]["analyzed"], 3)

    def test_a_worker_that_dies_reports_what_it_printed_to_stderr(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, model = self._seed_catalog(root, assets=1)
            worker = self._write_worker(
                root,
                "import sys\n"
                "sys.stdin.readline()\n"
                "sys.stderr.write('Unable to load the Core ML model\\n')\n"
                "sys.exit(2)\n",
            )
            job = create_job(connection, "people_index")
            with self.assertRaisesRegex(RuntimeError, "Unable to load the Core ML model"):
                run_people_index_job(
                    connection,
                    job["job_id"],
                    model_id="arcface-r100",
                    model_version="test-v1",
                    model_path=model,
                    manifest_hash="manifest-hash",
                    worker_path=worker,
                )
            failed = get_job(connection, job["job_id"])
            self.assertEqual(failed["status"], "failed")
            self.assertIn("Unable to load the Core ML model", failed["error"])
            connection.close()

    def _slow_first_worker(self, root: Path) -> Path:
        """A worker that logs "pid id" per request, each process in a file of
        its own (two processes appending to one file can overwrite each
        other's line on Windows); asset-1, the first photo of the job, takes
        a second, the rest next to none."""
        embedding = [1.0 / math.sqrt(512)] * 512
        return self._write_worker(root, f'''import json, os, pathlib, sys, time
embedding = {json.dumps(embedding)}
log = pathlib.Path({json.dumps(str(root))}) / f"worker-requests-{{os.getpid()}}.log"
for line in sys.stdin:
    request = json.loads(line)
    with log.open("a") as fh:
        fh.write(f"{{os.getpid()}} {{request['id']}}\\n")
    time.sleep(1.0 if request["id"] == "asset-1" else 0.05)
    face = {{"bounding_box": [0.1, 0.1, 0.5, 0.5], "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.1, 0.3, 0.2, 0.3], "confidence": 1.0, "quality": "standard", "embedding": embedding}}
    print(json.dumps({{"id": request["id"], "ok": True, "skipped": False, "input_hash": "h-" + request["id"], "image_size": {{"width": 100, "height": 100}}, "faces": [face], "error": None}}), flush=True)
''')

    def _requests(self, root: Path) -> list[tuple[str, str]]:
        return [
            tuple(line.split(" ", 1))
            for log in sorted(root.glob("worker-requests-*.log"))
            for line in log.read_text().splitlines()
        ]

    def _index(self, connection, worker: Path, job_id: str, **kwargs) -> dict:
        return run_people_index_job(
            connection, job_id, model_id="arcface-r100", model_version="test-v1",
            model_path=Path(connection.execute("PRAGMA database_list").fetchone()[2]).parent.parent / "ArcFaceR100.mlpackage",
            manifest_hash="manifest-hash", worker_path=worker, **kwargs,
        )

    def test_several_workers_share_the_photos_and_every_result_is_written(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, _ = self._seed_catalog(root, assets=6)
            worker = self._slow_first_worker(root)
            job = create_job(connection, "people_index")
            result = self._index(connection, worker, job["job_id"], workers=3)
            self.assertEqual((result["analyzed"], result["faces"], result["processed"]), (6, 6, 6))
            requests = self._requests(root)
            self.assertEqual(sorted(asset for _, asset in requests), [f"asset-{index}" for index in range(1, 7)])
            self.assertEqual(len({pid for pid, _ in requests}), 3)
            self.assertEqual(get_job(connection, job["job_id"])["resume_cursor"], {"offset": 6, "total": 6})
            connection.close()

    def test_a_cancel_keeps_the_photos_done_past_the_one_still_running(self) -> None:
        # The first photo takes a second; the next two finish meanwhile and
        # the cancel comes before the fourth. The resume point stays at the
        # first, with the two after it recorded as done, and a resumed run
        # asks only for the first and the fourth.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, _ = self._seed_catalog(root, assets=4)
            worker = self._slow_first_worker(root)
            job = create_job(connection, "people_index")
            with patch("media_workspace.job_runner._check_cancel", side_effect=[None, None, None, JobCancelled()]):
                cancelled = self._index(connection, worker, job["job_id"], workers=2)
            order = get_job(connection, job["job_id"])["payload"]["resolved_asset_ids"]
            self.assertEqual(order[0], "asset-1")
            self.assertEqual(cancelled["processed"], 2)
            self.assertEqual(get_job(connection, job["job_id"])["resume_cursor"], {"offset": 0, "total": 4, "done": [1, 2]})

            for log in root.glob("worker-requests-*.log"):
                log.unlink()
            resumed = self._index(connection, worker, job["job_id"], workers=2)
            self.assertEqual(sorted(asset for _, asset in self._requests(root)), sorted([order[0], order[3]]))
            self.assertEqual(resumed["processed"], 4)
            self.assertEqual(resumed["analyzed"], 4)
            self.assertEqual(get_job(connection, job["job_id"])["resume_cursor"], {"offset": 4, "total": 4})
            connection.close()

    def test_a_pause_lets_the_photos_already_sent_finish(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, _ = self._seed_catalog(root, assets=3)
            worker = self._slow_first_worker(root)
            job = create_job(connection, "people_index")
            with patch("media_workspace.job_runner._check_pause", side_effect=[None, None, JobPaused()]):
                paused = self._index(connection, worker, job["job_id"], workers=2)
            self.assertEqual((paused["processed"], paused["faces"]), (2, 2))
            self.assertEqual(get_job(connection, job["job_id"])["status"], "paused")
            self.assertEqual(get_job(connection, job["job_id"])["resume_cursor"], {"offset": 2, "total": 3})
            connection.close()

    def test_how_many_workers_a_mac_gets(self) -> None:
        from media_workspace import job_runner

        def machine(cores: int, gigabytes: float):
            pages = {"SC_PAGE_SIZE": 4096, "SC_PHYS_PAGES": int(gigabytes * 2**30 / 4096)}
            return (patch.object(job_runner.os, "cpu_count", return_value=cores),
                    # Windows has no os.sysconf: the Mac's is made up there.
                    patch.object(job_runner.os, "sysconf", side_effect=lambda name: pages[name], create=True))

        for cores, gigabytes, expected in ((12, 18, 3), (8, 16, 2), (8, 8, 1), (4, 64, 1), (24, 128, 3)):
            cpu, memory = machine(cores, gigabytes)
            with self.subTest(cores=cores, gigabytes=gigabytes), cpu, memory, patch.dict(os.environ, {"PEOPLE_WORKERS": ""}):
                self.assertEqual(job_runner.people_worker_count(), expected)
        with patch.dict(os.environ, {"PEOPLE_WORKERS": "2"}):
            self.assertEqual(job_runner.people_worker_count(), 2)

    def _seed_catalog(self, root: Path, *, assets: int):
        catalog = ensure_catalog(root / "demo.afcatalog")
        model = root / "ArcFaceR100.mlpackage"
        model.write_bytes(b"model-placeholder")
        connection = connect(catalog.db_path)
        init_db(connection)
        set_catalog_path(connection, catalog.root)
        for index in range(1, assets + 1):
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
        return connection, model

    def _pet_job_setup(self, root: Path):
        catalog = ensure_catalog(root / "demo.afcatalog")
        source = root / "dog.jpg"
        source.write_bytes(b"pixels-the-fake-worker-never-reads")
        face_model = root / "ArcFaceR100.mlpackage"
        face_model.write_bytes(b"face-model")
        pet_model = root / "PetEmbedding.mlpackage"
        pet_model.write_bytes(b"pet-model")
        connection = connect(catalog.db_path)
        init_db(connection)
        set_catalog_path(connection, catalog.root)
        connection.execute(
            """
            INSERT INTO assets (
                asset_id, asset_type, canonical_path, stem, normalized_stem,
                stem_key, extension, fingerprint, file_size, modified_time
            ) VALUES ('asset-1', 'image', ?, 'dog', 'dog', 'dog', '.jpg', 'fingerprint', 1, '2026-07-10T00:00:00Z')
            """,
            (str(source),),
        )
        connection.commit()
        return connection, face_model, pet_model

    def _run(self, connection, worker: Path, face_model: Path, pet_model: Path | None) -> dict:
        job = create_job(connection, "people_index")
        pets = {
            "pet_model_id": "dinov2-small",
            "pet_model_version": "test",
            "pet_model_path": pet_model,
            "pet_manifest_hash": "pet-manifest",
        } if pet_model else {}
        return run_people_index_job(
            connection, job["job_id"], model_id="arcface-r100", model_version="test-v1",
            model_path=face_model, manifest_hash="manifest-hash", worker_path=worker, **pets,
        )

    def test_pets_ride_along_in_the_same_pass_and_skip_on_their_own(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, face_model, pet_model = self._pet_job_setup(root)
            worker = self._write_fake_worker(root)

            first = self._run(connection, worker, face_model, pet_model)
            self.assertEqual((first["analyzed"], first["faces"], first["pets"]), (1, 1, 1))
            subjects = sorted(row["subject"] for row in connection.execute("SELECT subject FROM asset_faces"))
            self.assertEqual(subjects, ["dog", "person"])
            indexed = {row["model_id"]: row["status"] for row in connection.execute("SELECT model_id, status FROM people_asset_index")}
            self.assertEqual(indexed, {"arcface-r100": "indexed", "dinov2-small": "indexed"})
            # The worker was started with both models, and nowhere to keep them compiled.
            self.assertIn("--pet-model", (root / "worker-argv.log").read_text())
            self.assertNotIn("compiled-model", (root / "worker-argv.log").read_text())

            second = self._run(connection, worker, face_model, pet_model)
            self.assertEqual((second["analyzed"], second["skipped"]), (0, 1))
            self.assertEqual(len((root / "worker-requests.log").read_text().splitlines()), 1)
            connection.close()

    def test_the_workers_are_told_where_both_models_are_kept_compiled(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, face_model, pet_model = self._pet_job_setup(root)
            worker = self._write_fake_worker(root)
            compiled_face = root / "compiled" / "face.mlmodelc"
            compiled_pet = root / "compiled" / "pet.mlmodelc"
            job = create_job(connection, "people_index")
            run_people_index_job(
                connection, job["job_id"], model_id="arcface-r100", model_version="test-v1",
                model_path=face_model, manifest_hash="manifest-hash", worker_path=worker,
                compiled_model_path=compiled_face, pet_model_id="dinov2-small", pet_model_version="test",
                pet_model_path=pet_model, pet_manifest_hash="pet-manifest", pet_compiled_model_path=compiled_pet,
                workers=2,
            )
            argv = (root / "worker-argv.log").read_text()
            self.assertIn(f"--model {face_model} --compiled-model {compiled_face}", argv)
            self.assertIn(f"--pet-model {pet_model} --pet-compiled-model {compiled_pet}", argv)
            connection.close()

    def test_a_library_analyzed_for_faces_gets_its_pets_without_redoing_faces(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, face_model, pet_model = self._pet_job_setup(root)
            worker = self._write_fake_worker(root)
            self._run(connection, worker, face_model, None)
            face_ids = [row["face_id"] for row in connection.execute("SELECT face_id FROM asset_faces")]

            result = self._run(connection, worker, face_model, pet_model)

            # The stat gate let the photo through for its pets only: the worker
            # got the face hash, skipped the faces and found the dog.
            self.assertEqual((result["analyzed"], result["faces"], result["pets"]), (1, 0, 1))
            requests = (root / "worker-requests.log").read_text().splitlines()
            self.assertEqual(len(requests), 2)
            self.assertEqual(
                [row["face_id"] for row in connection.execute("SELECT face_id FROM asset_faces WHERE subject = 'person'")],
                face_ids,
            )
            connection.close()

    def test_turning_on_pets_keeps_the_faces_even_when_the_pixel_hash_drifted(self) -> None:
        # A macOS update can change how a photo decodes, so the pixel hash of
        # an untouched file no longer matches. With the face half's size and
        # mtime unchanged, its faces (and the people they belong to) stay put.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, face_model, pet_model = self._pet_job_setup(root)
            self._run(connection, self._write_fake_worker(root), face_model, None)
            (face_id,) = [row["face_id"] for row in connection.execute("SELECT face_id FROM asset_faces")]
            connection.execute(
                "INSERT INTO person_groups (group_id, model_id, model_version, name, state, cover_face_id)"
                " VALUES ('ann', 'arcface-r100', 'test-v1', 'Ann', 'confirmed', ?)",
                (face_id,),
            )
            connection.execute("INSERT INTO person_group_faces (group_id, face_id) VALUES ('ann', ?)", (face_id,))
            connection.commit()

            drifted = self._write_fake_worker(root, input_hash="input-hash-b")
            result = self._run(connection, drifted, face_model, pet_model)

            self.assertEqual((result["analyzed"], result["faces"], result["pets"]), (1, 0, 1))
            self.assertEqual(
                [(row["face_id"], row["group_id"]) for row in connection.execute(
                    "SELECT f.face_id, pgf.group_id FROM asset_faces AS f"
                    " JOIN person_group_faces AS pgf ON pgf.face_id = f.face_id WHERE f.subject = 'person'"
                )],
                [(face_id, "ann")],
            )
            index = connection.execute(
                "SELECT input_hash FROM people_asset_index WHERE model_id = 'arcface-r100'"
            ).fetchone()
            self.assertEqual(index["input_hash"], "input-hash-a")
            # Both halves pass the stat gate now: the next scan doesn't decode.
            again = self._run(connection, drifted, face_model, pet_model)
            self.assertEqual((again["analyzed"], again["skipped"]), (0, 1))
            self.assertEqual(len((root / "worker-requests.log").read_text().splitlines()), 2)
            connection.close()

    def test_an_edited_photo_is_analyzed_again_and_keeps_its_person(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, face_model, _pet_model = self._pet_job_setup(root)
            self._run(connection, self._write_fake_worker(root), face_model, None)
            (face_id,) = [row["face_id"] for row in connection.execute("SELECT face_id FROM asset_faces")]
            connection.execute(
                "INSERT INTO person_groups (group_id, model_id, model_version, name, state)"
                " VALUES ('ann', 'arcface-r100', 'test-v1', 'Ann', 'confirmed')"
            )
            connection.execute("INSERT INTO person_group_faces (group_id, face_id) VALUES ('ann', ?)", (face_id,))
            connection.commit()
            source = root / "dog.jpg"
            source.write_bytes(b"edited-pixels")

            result = self._run(connection, self._write_fake_worker(root, input_hash="input-hash-b"), face_model, None)

            self.assertEqual((result["analyzed"], result["faces"]), (1, 1))
            (new_face_id,) = [row["face_id"] for row in connection.execute("SELECT face_id FROM asset_faces")]
            self.assertNotEqual(new_face_id, face_id)
            group = connection.execute(
                "SELECT group_id FROM person_group_faces WHERE face_id = ?", (new_face_id,)
            ).fetchone()
            self.assertEqual(group["group_id"], "ann")
            connection.close()

    def test_a_pet_failure_keeps_the_faces_and_is_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            connection, face_model, pet_model = self._pet_job_setup(root)
            worker = self._write_fake_worker(root, pet_error="Core ML said no")

            result = self._run(connection, worker, face_model, pet_model)

            self.assertEqual((result["analyzed"], result["faces"], result.get("pets")), (1, 1, 0))
            rows = {
                row["model_id"]: (row["status"], row["error_text"])
                for row in connection.execute("SELECT model_id, status, error_text FROM people_asset_index")
            }
            self.assertEqual(rows["arcface-r100"][0], "indexed")
            self.assertEqual(rows["dinov2-small"], ("failed", "Core ML said no"))
            # A failed pet index isn't skipped by the stat gate: the next scan asks again.
            self._run(connection, worker, face_model, pet_model)
            self.assertEqual(len((root / "worker-requests.log").read_text().splitlines()), 2)
            connection.close()

    def _write_fake_worker(
        self, root: Path, *, stderr_per_request: int = 0, pet_error: str | None = None, input_hash: str = "input-hash-a"
    ) -> Path:
        embedding = [1.0 / math.sqrt(512)] * 512
        pet_embedding = [1.0 / math.sqrt(384)] * 384
        code = f'''import json
import pathlib
import sys

embedding = {json.dumps(embedding)}
pet_embedding = {json.dumps(pet_embedding)}
pet_error = {pet_error!r}
input_hash = {input_hash!r}
pets = "--pet-model" in sys.argv
pathlib.Path({json.dumps(str(root / "worker-argv.log"))}).write_text(" ".join(sys.argv[1:]))
log = pathlib.Path({json.dumps(str(root / "worker-requests.log"))})
for line in sys.stdin:
    request = json.loads(line)
    with log.open("a") as fh:
        fh.write(request["id"] + "\\n")
    faces_skipped = request.get("known_input_hash") == input_hash
    animals_skipped = pets and request.get("known_pet_input_hash") == input_hash
    faces = [] if faces_skipped else [{{"bounding_box": [0.1, 0.1, 0.5, 0.5], "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.1, 0.3, 0.2, 0.3], "confidence": 1.0, "quality": "standard", "embedding": embedding}}]
    response = {{"id": request["id"], "ok": True, "skipped": faces_skipped, "input_hash": input_hash, "image_size": {{"width": 100, "height": 100}}, "faces": faces, "error": None}}
    if pets:
        if pet_error:
            response.update(animals=None, animals_skipped=False, animals_error=pet_error)
        else:
            animals = [] if animals_skipped else [{{"subject": "dog", "bounding_box": [0.5, 0.4, 0.4, 0.5], "landmarks": [], "confidence": 0.9, "quality": "standard", "source": "recognizer", "embedding": pet_embedding}}]
            response.update(animals=animals, animals_skipped=animals_skipped)
    if {stderr_per_request}:
        sys.stderr.write("x" * {stderr_per_request} + "\\n")
        sys.stderr.flush()
    print(json.dumps(response), flush=True)
'''
        return self._write_worker(root, code)

    def _write_worker(self, root: Path, code: str) -> Path:
        script = root / "fake-people-worker.py"
        script.write_text(f"#!{sys.executable}\n{code}", encoding="utf-8")
        if os.name == "nt":
            # Windows runs programs, not scripts with a #! line: wrap it in a
            # .cmd that hands it to this Python, as npm does for its scripts.
            worker = root / "fake-people-worker.cmd"
            worker.write_text(f'@"{sys.executable}" "{script}" %*\r\n', encoding="utf-8")
            return worker
        script.chmod(script.stat().st_mode | 0o111)
        return script


if __name__ == "__main__":
    unittest.main()
