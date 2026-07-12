from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    assign_face_to_group,
    connect,
    get_person_group_detail,
    remove_face_from_group,
    remove_faces_from_group,
    get_people_asset_index,
    init_db,
    list_asset_faces,
    list_image_assets,
    list_person_groups,
    list_similar_person_groups,
    merge_person_groups,
    rebuild_candidate_groups,
    replace_asset_faces,
    set_catalog_path,
    set_person_group_name,
    set_person_group_cover,
    set_person_group_state,
    set_person_groups_state,
    upsert_face_model,
)


class PeoplePersistenceTest(unittest.TestCase):
    def test_replacing_faces_keeps_model_versions_isolated(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            catalog = ensure_catalog(Path(temp_dir) / "demo.afcatalog")
            connection = connect(catalog.db_path)
            init_db(connection)
            set_catalog_path(connection, catalog.root)
            connection.execute(
                """
                INSERT INTO assets (
                    asset_id, asset_type, canonical_path, stem, normalized_stem,
                    stem_key, extension, fingerprint, file_size, modified_time
                ) VALUES (?, 'image', ?, 'portrait', 'portrait', 'portrait', '.jpg', 'asset-fingerprint', 1, '2026-07-10T00:00:00Z')
                """,
                ("asset-1", str(catalog.root / "portrait.jpg")),
            )
            connection.commit()

            upsert_face_model(
                connection,
                model_id="arcface-r100",
                model_version="1.0.0",
                kind="arcface",
                manifest_hash="manifest-a",
            )
            embedding = [1.0 / math.sqrt(512)] * 512
            faces = replace_asset_faces(
                connection,
                asset_id="asset-1",
                model_id="arcface-r100",
                model_version="1.0.0",
                input_hash="people-input-a",
                faces=[
                    {
                        "bounding_box": [0.1, 0.2, 0.3, 0.4],
                        "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.11, 0.3, 0.19, 0.3],
                        "quality": "standard",
                        "confidence": 0.99,
                        "embedding": embedding,
                    }
                ],
            )

            self.assertEqual(len(faces), 1)
            index = get_people_asset_index(
                connection,
                asset_id="asset-1",
                model_id="arcface-r100",
                model_version="1.0.0",
            )
            self.assertEqual(index["input_hash"], "people-input-a")
            self.assertEqual(index["face_count"], 1)
            stored = list_asset_faces(
                connection,
                asset_id="asset-1",
                model_id="arcface-r100",
                model_version="1.0.0",
                include_embedding=True,
            )
            self.assertEqual(len(stored), 1)
            self.assertEqual(len(stored[0]["embedding"]), 512)
            self.assertAlmostEqual(sum(value * value for value in stored[0]["embedding"]), 1.0, places=5)

            replace_asset_faces(
                connection,
                asset_id="asset-1",
                model_id="arcface-r100",
                model_version="1.0.0",
                input_hash="people-input-b",
                faces=[],
            )
            self.assertEqual(
                list_asset_faces(
                    connection,
                    asset_id="asset-1",
                    model_id="arcface-r100",
                    model_version="1.0.0",
                ),
                [],
            )
            updated = get_people_asset_index(
                connection,
                asset_id="asset-1",
                model_id="arcface-r100",
                model_version="1.0.0",
            )
            self.assertEqual(updated["input_hash"], "people-input-b")
            self.assertEqual(updated["face_count"], 0)


class CandidateClusteringTest(unittest.TestCase):
    """The clustering rules from docs/people-recognition-design.md §7."""

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        catalog = ensure_catalog(Path(self._temp.name) / "demo.afcatalog")
        self.connection = connect(catalog.db_path)
        init_db(self.connection)
        set_catalog_path(self.connection, catalog.root)
        upsert_face_model(
            self.connection,
            model_id="arcface-r100",
            model_version="1.0.0",
            kind="arcface",
            manifest_hash="manifest-a",
        )

    def tearDown(self) -> None:
        self.connection.close()
        self._temp.cleanup()

    def _insert_asset(self, asset_id: str, faces: list[list[float]]) -> list[str]:
        self.connection.execute(
            """
            INSERT INTO assets (
                asset_id, asset_type, canonical_path, stem, normalized_stem,
                stem_key, extension, fingerprint, file_size, modified_time
            ) VALUES (?, 'image', ?, ?, ?, ?, '.jpg', ?, 1, '2026-07-10T00:00:00Z')
            """,
            (asset_id, f"/tmp/{asset_id}.jpg", asset_id, asset_id, asset_id, f"fp-{asset_id}"),
        )
        inserted = replace_asset_faces(
            self.connection,
            asset_id=asset_id,
            model_id="arcface-r100",
            model_version="1.0.0",
            input_hash=f"hash-{asset_id}",
            faces=[
                {
                    "bounding_box": [0.1, 0.2, 0.3, 0.4],
                    "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.11, 0.3, 0.19, 0.3],
                    "quality": "standard",
                    "confidence": 0.99,
                    "embedding": embedding,
                }
                for embedding in faces
            ],
        )
        return [str(face["face_id"]) for face in inserted]

    @staticmethod
    def _unit(components: dict[int, float]) -> list[float]:
        vector = [0.0] * 512
        for index, value in components.items():
            vector[index] = value
        length = math.sqrt(sum(value * value for value in vector))
        return [value / length for value in vector]

    def _group_members(self) -> dict[str, set[str]]:
        rows = self.connection.execute(
            """
            SELECT pgf.group_id, pgf.face_id
            FROM person_group_faces AS pgf
            JOIN person_groups AS pg ON pg.group_id = pgf.group_id
            WHERE pg.state = 'candidate'
            """
        ).fetchall()
        groups: dict[str, set[str]] = {}
        for row in rows:
            groups.setdefault(row["group_id"], set()).add(row["face_id"])
        return groups

    def test_bridge_face_does_not_chain_two_people_together(self) -> None:
        # Person A around axis 0, person B around axis 1, and one ambiguous
        # "bridge" face between them. Every adjacent pair clears the threshold,
        # so single-link merging would collapse all five faces into one person.
        tilt = math.cos(math.radians(20))
        lean = math.sin(math.radians(20))
        a_faces = [self._unit({0: 1.0}), self._unit({0: tilt, 3: lean})]
        b_faces = [self._unit({1: 1.0}), self._unit({1: tilt, 4: lean})]
        bridge = [self._unit({0: 1.0, 1: 1.0})]
        face_ids = {
            "a": self._insert_asset("asset-a", [a_faces[0]]) + self._insert_asset("asset-a2", [a_faces[1]]),
            "b": self._insert_asset("asset-b", [b_faces[0]]) + self._insert_asset("asset-b2", [b_faces[1]]),
            "bridge": self._insert_asset("asset-bridge", bridge),
        }

        result = rebuild_candidate_groups(
            self.connection,
            model_id="arcface-r100",
            model_version="1.0.0",
        )

        self.assertGreaterEqual(result["groups"], 2)
        for members in self._group_members().values():
            has_a = bool(members & set(face_ids["a"]))
            has_b = bool(members & set(face_ids["b"]))
            self.assertFalse(has_a and has_b, "bridge face chained two people into one group")

    def test_faces_in_the_same_photo_never_share_a_group(self) -> None:
        # Identical embeddings, but two of the faces sit in the same photo:
        # they are different people by definition and must not be grouped.
        same = self._unit({0: 1.0})
        duo_ids = self._insert_asset("asset-duo", [same, same])
        solo_ids = self._insert_asset("asset-solo", [same])

        rebuild_candidate_groups(
            self.connection,
            model_id="arcface-r100",
            model_version="1.0.0",
        )

        groups = self._group_members()
        self.assertEqual(len(groups), 1)
        (members,) = groups.values()
        self.assertEqual(len(members), 2)
        self.assertIn(solo_ids[0], members)
        self.assertFalse(set(duo_ids) <= members, "same-photo faces were merged into one person")

    def test_gallery_person_filter_returns_only_that_groups_photos(self) -> None:
        person = self._unit({0: 1.0})
        other = self._unit({1: 1.0})
        person_face_ids = (
            self._insert_asset("asset-person-1", [person])
            + self._insert_asset("asset-person-2", [person])
        )
        self._insert_asset("asset-other", [other])
        for asset_id in ("asset-person-1", "asset-person-2", "asset-other"):
            self.connection.execute(
                """
                INSERT INTO image_lookup_registry (
                    image_path, image_asset_id, match_status, resolver_version
                ) VALUES (?, ?, 'unmatched', 'test')
                """,
                (f"/tmp/{asset_id}.jpg", asset_id),
            )
        rebuild_candidate_groups(
            self.connection,
            model_id="arcface-r100",
            model_version="1.0.0",
        )
        placeholders = ",".join("?" for _ in person_face_ids)
        group_id = self.connection.execute(
            f"SELECT group_id FROM person_group_faces WHERE face_id IN ({placeholders}) LIMIT 1",
            person_face_ids,
        ).fetchone()["group_id"]

        rows = list_image_assets(
            self.connection,
            status="all",
            filters={"person_group": group_id},
        )

        self.assertEqual(
            {row["asset_id"] for row in rows},
            {"asset-person-1", "asset-person-2"},
        )

    def test_naming_confirms_and_merging_moves_faces_with_audit(self) -> None:
        person_a = self._unit({0: 1.0})
        person_a2 = self._unit({0: 0.9, 2: 0.45})
        stray = self._unit({1: 1.0})
        stray2 = self._unit({1: 0.9, 3: 0.45})
        for index, vector in enumerate([person_a, person_a2, stray, stray2]):
            self._insert_asset(f"asset-{index}", [vector])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        groups = list_person_groups(self.connection)
        self.assertEqual(len(groups), 2)

        named = set_person_group_name(self.connection, group_id=groups[0]["group_id"], name="  Wonyoung ")
        self.assertEqual(named["name"], "Wonyoung")
        self.assertEqual(named["state"], "confirmed")
        with self.assertRaises(ValueError):
            set_person_group_name(self.connection, group_id=groups[0]["group_id"], name="   ")

        merged = merge_person_groups(
            self.connection,
            source_group_id=groups[1]["group_id"],
            target_group_id=groups[0]["group_id"],
        )
        self.assertEqual(merged["face_count"], 4)
        self.assertEqual(merged["name"], "Wonyoung")
        moved = self.connection.execute(
            "SELECT COUNT(*) AS n FROM person_group_faces WHERE group_id = ? AND source = 'user_merged'",
            (groups[0]["group_id"],),
        ).fetchone()["n"]
        self.assertEqual(moved, 2)
        self.assertEqual(len(list_person_groups(self.connection)), 1)

        # Confirmed members survive an automatic re-cluster untouched.
        result = rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        self.assertEqual(result["faces"], 0)
        self.assertEqual(list_person_groups(self.connection)[0]["face_count"], 4)

    def test_ignored_groups_leave_the_default_listing(self) -> None:
        same = self._unit({0: 1.0})
        self._insert_asset("asset-a", [same])
        self._insert_asset("asset-b", [same])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)

        ignored = set_person_group_state(self.connection, group_id=group["group_id"], state="ignored")
        self.assertEqual(ignored["state"], "ignored")
        self.assertEqual(list_person_groups(self.connection), [])
        self.assertEqual(len(list_person_groups(self.connection, state="ignored")), 1)

    def test_multiple_groups_can_be_ignored_atomically(self) -> None:
        person_a = self._unit({0: 1.0})
        person_b = self._unit({1: 1.0})
        self._insert_asset("asset-a1", [person_a])
        self._insert_asset("asset-a2", [person_a])
        self._insert_asset("asset-b1", [person_b])
        self._insert_asset("asset-b2", [person_b])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        groups = list_person_groups(self.connection)
        self.assertEqual(len(groups), 2)
        ids = [str(group["group_id"]) for group in groups]

        with self.assertRaises(ValueError):
            set_person_groups_state(self.connection, group_ids=[ids[0], "missing-group"], state="ignored")
        self.assertEqual(len(list_person_groups(self.connection)), 2, "partial batch update escaped")

        result = set_person_groups_state(self.connection, group_ids=ids, state="ignored")
        self.assertEqual(result["updated"], 2)
        self.assertEqual(list_person_groups(self.connection), [])
        self.assertEqual(len(list_person_groups(self.connection, state="ignored")), 2)

    def test_face_corrections_reject_and_reassign_with_audit(self) -> None:
        person_a = self._unit({0: 1.0})
        person_b = self._unit({1: 1.0})
        self._insert_asset("asset-a1", [person_a])
        self._insert_asset("asset-a2", [person_a])
        self._insert_asset("asset-b1", [person_b])
        self._insert_asset("asset-b2", [person_b])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        groups = list_person_groups(self.connection)
        self.assertEqual(len(groups), 2)
        group_a, group_b = groups[0], groups[1]

        member = self.connection.execute(
            "SELECT face_id FROM person_group_faces WHERE group_id = ? LIMIT 1",
            (group_a["group_id"],),
        ).fetchone()["face_id"]

        # Reject: face leaves the group, audit row survives as user_split…
        remove_face_from_group(self.connection, face_id=member)
        audit = self.connection.execute(
            "SELECT membership_state, source FROM person_group_faces WHERE face_id = ?",
            (member,),
        ).fetchone()
        self.assertEqual((audit["membership_state"], audit["source"]), ("rejected", "user_split"))
        # …the asset payload treats it as unmatched…
        from media_workspace.db import get_asset_people
        asset_id = self.connection.execute(
            "SELECT asset_id FROM asset_faces WHERE face_id = ?", (member,),
        ).fetchone()["asset_id"]
        payload = get_asset_people(self.connection, asset_id=asset_id)
        self.assertIsNone(payload["faces"][0]["group_id"])
        # …and a rebuild does not pull it back into a candidate group.
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        still = self.connection.execute(
            "SELECT membership_state FROM person_group_faces WHERE face_id = ?", (member,),
        ).fetchone()
        self.assertEqual(still["membership_state"], "rejected")

        # Reassign: the rejected face lands in person B's group (re-fetched —
        # the rebuild recreated candidate groups under new ids) as a user
        # confirmation.
        (group_b,) = list_person_groups(self.connection)
        target = assign_face_to_group(self.connection, face_id=member, group_id=group_b["group_id"])
        self.assertEqual(target["face_count"], 3)
        moved = self.connection.execute(
            "SELECT group_id, membership_state, source FROM person_group_faces WHERE face_id = ?",
            (member,),
        ).fetchone()
        self.assertEqual(
            (moved["group_id"], moved["membership_state"], moved["source"]),
            (group_b["group_id"], "confirmed", "user_confirmed"),
        )

    def test_batch_removal_is_atomic_when_one_face_fails(self) -> None:
        same = self._unit({0: 1.0})
        self._insert_asset("asset-a", [same])
        self._insert_asset("asset-b", [same])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)
        member = self.connection.execute(
            "SELECT face_id FROM person_group_faces WHERE group_id = ? LIMIT 1",
            (group["group_id"],),
        ).fetchone()["face_id"]

        with self.assertRaises(ValueError):
            remove_faces_from_group(self.connection, face_ids=[member, "face_does_not_exist"])

        untouched = self.connection.execute(
            "SELECT membership_state FROM person_group_faces WHERE face_id = ?",
            (member,),
        ).fetchone()
        self.assertEqual(untouched["membership_state"], "automatic",
                         "a failing batch must roll back its earlier removals")

    def test_group_detail_faces_paginate(self) -> None:
        vector = self._unit({0: 1.0})
        for index in range(3):
            self._insert_asset(f"asset-{index}", [vector])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)

        first = get_person_group_detail(self.connection, group_id=group["group_id"], face_limit=2)
        second = get_person_group_detail(
            self.connection, group_id=group["group_id"], face_limit=2, face_offset=2,
        )
        self.assertEqual(len(first["faces"]), 2)
        self.assertEqual(len(second["faces"]), 1)
        self.assertEqual(first["face_count"], 3)
        ids = {face["face_id"] for face in first["faces"]} | {face["face_id"] for face in second["faces"]}
        self.assertEqual(len(ids), 3, "pages must not overlap")

    def test_cover_falls_back_when_cover_asset_is_deleted(self) -> None:
        vector = self._unit({0: 1.0})
        self._insert_asset("asset-a", [vector])
        self._insert_asset("asset-b", [vector])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)
        cover_asset = self.connection.execute(
            "SELECT asset_id FROM asset_faces WHERE face_id = ?", (group["cover_face_id"],),
        ).fetchone()["asset_id"]

        self.connection.execute("DELETE FROM assets WHERE asset_id = ?", (cover_asset,))
        self.connection.commit()

        (after,) = list_person_groups(self.connection)
        self.assertIsNotNone(after["cover_face_id"], "cover must fall back to a surviving member")
        self.assertNotEqual(after["cover_face_id"], group["cover_face_id"])
        self.assertEqual(after["face_count"], 1)

    def test_user_cover_falls_back_when_that_face_is_removed(self) -> None:
        vector = self._unit({0: 1.0})
        self._insert_asset("asset-a", [vector])
        self._insert_asset("asset-b", [vector])
        self._insert_asset("asset-c", [vector])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)
        detail = get_person_group_detail(self.connection, group_id=group["group_id"])
        chosen = next(face["face_id"] for face in detail["faces"] if face["face_id"] != group["cover_face_id"])

        updated = set_person_group_cover(self.connection, group_id=group["group_id"], face_id=chosen)
        self.assertEqual(updated["cover_face_id"], chosen)

        remove_face_from_group(self.connection, face_id=chosen)
        after = get_person_group_detail(self.connection, group_id=group["group_id"])
        self.assertIsNotNone(after["cover_face_id"])
        self.assertNotEqual(after["cover_face_id"], chosen)

    def test_similar_groups_rank_by_centroid_similarity_not_size(self) -> None:
        # Person A (axis 0) is bigger, person B (axis 1) is closer to the
        # unnamed source group — B must outrank A in the suggestions.
        a_vec = self._unit({0: 1.0})
        b_vec = self._unit({1: 1.0})
        # Similar enough to rank near B (cos ≈ 0.41) but below the clustering
        # threshold, so the source stays a separate unnamed group.
        near_b = self._unit({1: 0.45, 2: 1.0})
        for index in range(3):
            self._insert_asset(f"asset-a{index}", [a_vec])
        for index in range(2):
            self._insert_asset(f"asset-b{index}", [b_vec])
        for index in range(2):
            self._insert_asset(f"asset-s{index}", [near_b])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        groups = list_person_groups(self.connection)
        by_size = {len(members): group for group, members in (
            (g, self.connection.execute(
                "SELECT face_id FROM person_group_faces WHERE group_id = ?", (g["group_id"],)
            ).fetchall()) for g in groups
        )}
        set_person_group_name(self.connection, group_id=by_size[3]["group_id"], name="Person A")
        set_person_group_name(self.connection, group_id=by_size[2]["group_id"], name="Person B")
        source = next(g for g in list_person_groups(self.connection) if not g["name"])

        ranked = list_similar_person_groups(self.connection, group_id=source["group_id"], limit=10)

        self.assertEqual([g["name"] for g in ranked], ["Person B", "Person A"])
        self.assertGreater(ranked[0]["similarity"], ranked[1]["similarity"])

    def test_ignored_group_faces_do_not_break_or_rejoin_the_rebuild(self) -> None:
        # Regression: faces of an ignored group used to be re-clustered while
        # their old membership rows survived, so the rebuild crashed on the
        # UNIQUE(face_id) insert. They must be left out entirely instead.
        same = self._unit({0: 1.0})
        self._insert_asset("asset-a", [same])
        self._insert_asset("asset-b", [same])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)
        set_person_group_state(self.connection, group_id=group["group_id"], state="ignored")

        result = rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")

        self.assertEqual(result["faces"], 0)
        self.assertEqual(list_person_groups(self.connection), [])
        self.assertEqual(len(list_person_groups(self.connection, state="ignored")), 1)

    def test_rebuild_restores_a_missing_cover_on_surviving_groups(self) -> None:
        vector = self._unit({0: 1.0})
        self._insert_asset("asset-a", [vector])
        self._insert_asset("asset-b", [vector])
        self._insert_asset("asset-c", [vector])
        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")
        (group,) = list_person_groups(self.connection)
        set_person_group_name(self.connection, group_id=group["group_id"], name="Wonyoung")

        # Re-analysis of the cover's asset deletes that face; the FK nulls the
        # confirmed group's cover while the other members stay.
        cover_asset = self.connection.execute(
            "SELECT asset_id FROM asset_faces WHERE face_id = ?",
            (group["cover_face_id"],),
        ).fetchone()["asset_id"]
        replace_asset_faces(
            self.connection,
            asset_id=cover_asset,
            model_id="arcface-r100",
            model_version="1.0.0",
            input_hash="rehashed",
            faces=[],
        )
        self.assertIsNone(self.connection.execute(
            "SELECT cover_face_id FROM person_groups WHERE group_id = ?",
            (group["group_id"],),
        ).fetchone()["cover_face_id"])

        rebuild_candidate_groups(self.connection, model_id="arcface-r100", model_version="1.0.0")

        restored = self.connection.execute(
            "SELECT cover_face_id FROM person_groups WHERE group_id = ?",
            (group["group_id"],),
        ).fetchone()["cover_face_id"]
        self.assertIsNotNone(restored)

    def test_grouping_is_deterministic_across_rebuilds(self) -> None:
        vectors = [
            self._unit({0: 1.0}),
            self._unit({0: 0.9, 2: 0.45}),
            self._unit({1: 1.0}),
            self._unit({1: 0.9, 3: 0.45}),
        ]
        for index, vector in enumerate(vectors):
            self._insert_asset(f"asset-{index}", [vector])

        first = rebuild_candidate_groups(
            self.connection,
            model_id="arcface-r100",
            model_version="1.0.0",
        )
        first_groups = {frozenset(members) for members in self._group_members().values()}
        second = rebuild_candidate_groups(
            self.connection,
            model_id="arcface-r100",
            model_version="1.0.0",
        )
        second_groups = {frozenset(members) for members in self._group_members().values()}

        self.assertEqual(first["groups"], second["groups"])
        self.assertEqual(first_groups, second_groups)
        covers = self.connection.execute(
            "SELECT group_id, cover_face_id FROM person_groups WHERE state = 'candidate' ORDER BY group_id"
        ).fetchall()
        for row in covers:
            self.assertIsNotNone(row["cover_face_id"])


if __name__ == "__main__":
    unittest.main()
