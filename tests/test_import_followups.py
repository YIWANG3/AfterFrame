"""After an import: which ended imports still have their follow-ups to get
(people, annotation), which photos they added, and the app's own pause of a
people job while an import runs (db/import_followups.py, db/jobs.py)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import connect, get_job, init_db, list_assets_for_annotation, request_job_pause, request_job_resume
from media_workspace.db.import_followups import (
    followups_since,
    import_scope,
    mark_import_followups,
    new_asset_count,
    pending_import_followups,
)


class ImportFollowupsTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        catalog = ensure_catalog(self.root / "demo.afcatalog")
        self.connection = connect(catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        self.connection.execute(
            "INSERT INTO app_settings (setting_key, value_json) VALUES ('import_followups_since', ?)",
            (json.dumps("2026-11-20 00:00:00"),),
        )
        self.connection.commit()

    def job(self, job_id: str, status: str, created: str, updated: str, *, dirs: list[str], job_type: str = "import",
            result: dict | None = None) -> None:
        self.connection.execute(
            """
            INSERT INTO jobs (job_id, job_type, status, payload_json, result_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (job_id, job_type, status, json.dumps({"image_dirs": dirs, "raw_dirs": [], "mode": "processed_only"}),
             json.dumps(result or {}), created, updated),
        )
        self.connection.commit()

    def asset(self, asset_id: str, path: Path, created: str, asset_type: str = "image") -> None:
        self.connection.execute(
            """
            INSERT INTO assets (asset_id, asset_type, canonical_path, stem, normalized_stem, stem_key, extension,
                                fingerprint, file_size, modified_time, created_at)
            VALUES (?, ?, ?, ?, ?, ?, '.jpg', ?, 1, '2026-01-01T00:00:00', ?)
            """,
            (asset_id, asset_type, str(path), path.stem, path.stem, path.stem, f"fp-{asset_id}", created),
        )
        self.connection.commit()

    def test_the_photos_an_import_added_are_the_ones_made_while_it_ran_under_its_folders(self):
        shoot, other = self.root / "Shoot", self.root / "Other"
        self.job("import-1", "succeeded", "2026-11-26 10:00:00", "2026-11-26 10:05:00", dirs=[str(shoot)])
        self.asset("a", shoot / "a.jpg", "2026-11-26 10:01:00")
        self.asset("b", shoot / "day 2" / "b.jpg", "2026-11-26 10:05:00")  # the last second counts
        self.asset("old", shoot / "old.jpg", "2026-11-25 09:00:00")  # was there before
        self.asset("elsewhere", other / "c.jpg", "2026-11-26 10:02:00")  # someone else's
        self.asset("sibling", self.root / "Shoot 2" / "d.jpg", "2026-11-26 10:02:00")  # a folder named alike
        self.assertEqual(new_asset_count(self.connection, "import-1"), 2)

    def test_a_dropped_file_and_a_folder_with_a_percent_sign_are_their_own_scope(self):
        odd = self.root / "100% film_scans"
        lone = self.root / "Desktop" / "one.jpg"
        self.job("import-1", "succeeded", "2026-11-26 10:00:00", "2026-11-26 10:05:00", dirs=[str(odd), str(lone)])
        self.asset("a", odd / "a.jpg", "2026-11-26 10:01:00")
        self.asset("lone", lone, "2026-11-26 10:01:00")
        self.asset("lookalike", self.root / "100X filmXscans" / "b.jpg", "2026-11-26 10:01:00")
        self.asset("beside", self.root / "Desktop" / "two.jpg", "2026-11-26 10:01:00")
        self.assertEqual(new_asset_count(self.connection, "import-1"), 2)

    def test_pending_imports_are_the_ended_ones_since_the_app_first_asked_without_their_followups(self):
        shoot = self.root / "Shoot"
        self.job("before", "succeeded", "2026-11-19 10:00:00", "2026-11-19 10:05:00", dirs=[str(shoot)])
        self.job("done", "succeeded", "2026-11-26 09:00:00", "2026-11-26 09:05:00", dirs=[str(shoot)],
                 result={"followups": {"people": "started", "done": True}})
        self.job("cancelled", "cancelled", "2026-11-26 10:00:00", "2026-11-26 10:01:00", dirs=[str(shoot)])
        self.job("half", "failed", "2026-11-26 11:00:00", "2026-11-26 11:01:00", dirs=[str(shoot)],
                 result={"followups": {"annotation": "started"}})
        self.job("running", "running", "2026-11-26 12:00:00", "2026-11-26 12:00:00", dirs=[str(shoot)])
        self.job("people", "succeeded", "2026-11-26 13:00:00", "2026-11-26 13:00:00", dirs=[str(shoot)], job_type="people_index")
        self.asset("a", shoot / "a.jpg", "2026-11-26 10:00:30")

        pending = pending_import_followups(self.connection)
        self.assertEqual([row["job_id"] for row in pending], ["cancelled", "half"])
        self.assertEqual([row["new_assets"] for row in pending], [1, 0])
        self.assertEqual(pending[1]["followups"], {"annotation": "started"})

    def test_a_catalog_new_to_followups_starts_from_now(self):
        self.connection.execute("DELETE FROM app_settings WHERE setting_key = 'import_followups_since'")
        self.connection.commit()
        self.job("old", "succeeded", "2026-11-01 10:00:00", "2026-11-01 10:05:00", dirs=[str(self.root)])
        since = followups_since(self.connection)
        self.assertGreater(since, "2026-11-01 10:00:00")
        self.assertEqual(followups_since(self.connection), since)  # set once
        self.assertEqual(pending_import_followups(self.connection), [])

    def test_marking_merges_and_keeps_the_window_where_it_was(self):
        self.job("import-1", "succeeded", "2026-11-26 10:00:00", "2026-11-26 10:05:00", dirs=[str(self.root)])
        mark_import_followups(self.connection, "import-1", {"annotation": "started"})
        merged = mark_import_followups(self.connection, "import-1", {"people": "waiting"})
        self.assertEqual(merged, {"annotation": "started", "people": "waiting"})
        job = get_job(self.connection, "import-1")
        self.assertEqual(job["result"]["followups"], merged)
        self.assertEqual(job["updated_at"], "2026-11-26 10:05:00")
        self.assertIsNone(mark_import_followups(self.connection, "nope", {"done": True}))

    def test_annotating_on_import_takes_only_that_imports_photos(self):
        shoot = self.root / "Shoot"
        self.job("import-1", "succeeded", "2026-11-26 10:00:00", "2026-11-26 10:05:00", dirs=[str(shoot)])
        self.job("import-2", "succeeded", "2026-11-26 11:00:00", "2026-11-26 11:05:00", dirs=[str(shoot)])
        self.asset("first", shoot / "a.jpg", "2026-11-26 10:01:00")
        self.asset("second", shoot / "b.jpg", "2026-11-26 11:01:00")
        self.asset("library", self.root / "Library" / "c.jpg", "2026-11-01 10:00:00")
        self.asset("annotated", shoot / "d.jpg", "2026-11-26 10:02:00")
        self.connection.execute(
            "INSERT INTO asset_ai_annotations (asset_id, provider, model, caption) VALUES ('annotated', 'x', 'x', 'x')"
        )
        self.connection.commit()

        def ids(**scope):
            return sorted(row["asset_id"] for row in list_assets_for_annotation(self.connection, **scope))

        self.assertEqual(ids(), ["first", "library", "second"])  # the whole library, as before
        self.assertEqual(ids(import_job_ids=["import-1"]), ["first"])
        self.assertEqual(ids(import_job_ids=["import-1", "import-2"]), ["first", "second"])
        self.assertEqual(ids(import_job_ids=["import-1"], only_missing=False), ["annotated", "first"])
        self.assertEqual(ids(import_job_ids=[]), [])
        self.assertEqual(import_scope(self.connection, ["not-a-job"]), ("0", []))


class PauseForImportTest(unittest.TestCase):
    def setUp(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        catalog = ensure_catalog(Path(directory.name) / "demo.afcatalog")
        self.connection = connect(catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        self.connection.execute(
            "INSERT INTO jobs (job_id, job_type, status, payload_json, result_json) VALUES ('p', 'people_index', 'running', '{}', '{}')"
        )
        self.connection.commit()

    def test_the_apps_pause_is_told_apart_and_the_users_wins(self):
        paused = request_job_pause(self.connection, "p", for_import=True)
        self.assertTrue(paused["pause_requested"])
        self.assertTrue(paused["paused_for_import"])
        # The user pauses it too: now it's theirs, and stays paused.
        self.assertFalse(request_job_pause(self.connection, "p")["paused_for_import"])
        self.assertFalse(request_job_pause(self.connection, "p", for_import=True)["paused_for_import"])

    def test_cancelling_a_paused_job_ends_it_there_is_no_runner_to_do_it(self):
        from media_workspace.db import request_job_cancel

        request_job_pause(self.connection, "p", for_import=True)
        self.connection.execute("UPDATE jobs SET status = 'paused' WHERE job_id = 'p'")
        self.connection.commit()
        cancelled = request_job_cancel(self.connection, "p")
        self.assertEqual((cancelled["status"], cancelled["cancel_requested"]), ("cancelled", True))
        self.assertEqual(request_job_resume(self.connection, "p")["status"], "cancelled")

    def test_a_queued_job_paused_for_an_import_is_paused_at_once_and_resumes_clean(self):
        self.connection.execute("UPDATE jobs SET status = 'queued' WHERE job_id = 'p'")
        self.connection.commit()
        paused = request_job_pause(self.connection, "p", for_import=True)
        self.assertEqual((paused["status"], paused["paused_for_import"]), ("paused", True))
        resumed = request_job_resume(self.connection, "p")
        self.assertEqual((resumed["status"], resumed["pause_requested"], resumed["paused_for_import"]), ("queued", False, False))


if __name__ == "__main__":
    unittest.main()
