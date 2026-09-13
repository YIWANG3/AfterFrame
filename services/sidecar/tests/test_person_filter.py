"""Person facet correctness and bounded query work on a large gallery."""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from media_workspace.db.browse import _facet_clauses  # noqa: E402


class PersonFilterTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE assets (asset_id TEXT PRIMARY KEY, app_rating INTEGER);
            CREATE TABLE asset_faces (face_id TEXT PRIMARY KEY, asset_id TEXT);
            CREATE INDEX face_asset ON asset_faces(asset_id);
            CREATE TABLE person_group_faces (
                group_id TEXT, face_id TEXT UNIQUE, membership_state TEXT,
                PRIMARY KEY(group_id, face_id)
            );
        """)
        self.db.executemany("INSERT INTO assets VALUES (?, ?)",
                            [(f"asset-{i:05}", i % 5) for i in range(6000)])
        # Two faces per photo: filtering must not duplicate photos. Include
        # rejected membership, accepted membership and another person's face.
        self.db.executemany("INSERT INTO asset_faces VALUES (?, ?)",
                            [(f"face-{i}", f"asset-{i // 2:05}") for i in range(400)])
        self.db.executemany("INSERT INTO person_group_faces VALUES (?, ?, ?)",
                            [("large-person", f"face-{i}", "automatic") for i in range(398)]
                            + [("large-person", "face-398", "rejected"),
                               ("other-person", "face-399", "confirmed")])

    def tearDown(self):
        self.db.close()

    def query(self, filters, limit=1000, offset=0):
        clause, params = _facet_clauses(filters)
        return [r[0] for r in self.db.execute(
            f"SELECT assets.asset_id FROM assets WHERE 1=1 {clause} "
            "ORDER BY assets.asset_id LIMIT ? OFFSET ?", [*params, limit, offset])]

    def test_membership_deduplication_pagination_and_other_facets(self):
        filters = {"person_group": "large-person"}
        expected = [f"asset-{i:05}" for i in range(199)]
        self.assertEqual(self.query(filters), expected)
        self.assertEqual(self.query(filters, 10, 180), expected[180:190])
        self.assertEqual(self.query({**filters, "rating_min": 4}), expected[4::5])
        self.assertEqual(self.query({"person_group": "other-person"}), ["asset-00199"])
        self.assertEqual(self.query({"person_group": "missing"}), [])

    def test_large_group_does_not_rescan_members_for_every_asset(self):
        # Count SQLite VM work instead of wall time so this guard also runs
        # reliably on slow CI machines. The correlated query exceeds this
        # budget by repeatedly walking 400 memberships for 6,000 assets.
        callbacks = 0

        def budget():
            nonlocal callbacks
            callbacks += 1
            return callbacks > 300

        self.db.set_progress_handler(budget, 1000)
        try:
            self.assertEqual(len(self.query({"person_group": "large-person"})), 199)
        finally:
            self.db.set_progress_handler(None, 0)


if __name__ == "__main__":
    unittest.main()
