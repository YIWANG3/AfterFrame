"""Cats and dogs beside people (docs/pet-recognition-design.md): stored as
face rows of a pet model with a subject, grouped per species, filtered and
corrected like people."""
from __future__ import annotations

import math
import tempfile
import unittest
from pathlib import Path

from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    assign_face_to_group,
    connect,
    get_asset_people,
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
    upsert_face_model,
)

FACE = ("arcface-r100", "1.0.0")
PET = ("dinov2-small-coreml", "test")
PET_DIMENSIONS = 384


def unit(components: dict[int, float], size: int) -> list[float]:
    vector = [0.0] * size
    for index, value in components.items():
        vector[index] = value
    length = math.sqrt(sum(value * value for value in vector))
    return [value / length for value in vector]


def animal(subject: str, vector: list[float], *, head: list[float] | None = None) -> dict:
    return {
        "subject": subject,
        "bounding_box": [0.2, 0.3, 0.5, 0.5],
        "landmarks": head if head is not None else [],
        "quality": "standard",
        "confidence": 0.9,
        "source": "recognizer",
        "embedding": vector,
    }


class PetStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        catalog = ensure_catalog(Path(self._temp.name) / "demo.afcatalog")
        self.connection = connect(catalog.db_path)
        init_db(self.connection)
        set_catalog_path(self.connection, catalog.root)
        upsert_face_model(self.connection, model_id=FACE[0], model_version=FACE[1], kind="arcface", manifest_hash="a")
        upsert_face_model(self.connection, model_id=PET[0], model_version=PET[1], kind="pet", manifest_hash="b")

    def tearDown(self) -> None:
        self.connection.close()
        self._temp.cleanup()

    def _asset(self, asset_id: str) -> None:
        self.connection.execute(
            """
            INSERT INTO assets (
                asset_id, asset_type, canonical_path, stem, normalized_stem,
                stem_key, extension, fingerprint, file_size, modified_time
            ) VALUES (?, 'image', ?, ?, ?, ?, '.jpg', ?, 1, '2026-07-10T00:00:00Z')
            """,
            (asset_id, f"/tmp/{asset_id}.jpg", asset_id, asset_id, asset_id, f"fp-{asset_id}"),
        )
        self.connection.execute(
            "INSERT INTO image_lookup_registry (image_path, image_asset_id, match_status, resolver_version) VALUES (?, ?, 'unmatched', 'test')",
            (f"/tmp/{asset_id}.jpg", asset_id),
        )

    def _pets(self, asset_id: str, animals: list[dict]) -> list[str]:
        inserted = replace_asset_faces(
            self.connection, asset_id=asset_id, model_id=PET[0], model_version=PET[1],
            input_hash=f"hash-{asset_id}", faces=animals, pets=True,
        )
        return [str(row["face_id"]) for row in inserted]

    def _face(self, asset_id: str) -> None:
        replace_asset_faces(
            self.connection, asset_id=asset_id, model_id=FACE[0], model_version=FACE[1],
            input_hash=f"hash-{asset_id}",
            faces=[{
                "bounding_box": [0.1, 0.2, 0.3, 0.4],
                "landmarks": [0.1, 0.1, 0.2, 0.1, 0.15, 0.2, 0.11, 0.3, 0.19, 0.3],
                "quality": "standard",
                "confidence": 0.99,
                "embedding": unit({0: 1.0}, 512),
            }],
        )

    def _group_of(self, face_id: str) -> str:
        return str(self.connection.execute(
            "SELECT group_id FROM person_group_faces WHERE face_id = ?", (face_id,)
        ).fetchone()["group_id"])

    def test_pets_are_stored_with_their_species_and_own_vector_size(self) -> None:
        self._asset("a")
        self._pets("a", [animal("cat", unit({0: 1.0}, PET_DIMENSIONS), head=[0.3, 0.3, 0.1, 0.1])])
        [row] = list_asset_faces(self.connection, asset_id="a", model_id=PET[0], model_version=PET[1], include_embedding=True)
        self.assertEqual(row["subject"], "cat")
        self.assertEqual(row["landmarks"], [0.3, 0.3, 0.1, 0.1])
        self.assertEqual(len(row["embedding"]), PET_DIMENSIONS)

    def test_a_pet_row_must_be_a_cat_or_dog_with_a_head_box_or_none(self) -> None:
        self._asset("a")
        vector = unit({0: 1.0}, PET_DIMENSIONS)
        with self.assertRaises(ValueError):
            self._pets("a", [animal("person", vector)])
        with self.assertRaises(ValueError):
            self._pets("a", [animal("cat", vector, head=[0.1, 0.2])])
        with self.assertRaises(ValueError):
            self._pets("a", [animal("dog", [1.0, 0.0])])
        self.assertEqual(self._pets("a", [animal("dog", vector)]).__len__(), 1)

    def test_the_face_badge_counts_people_and_the_inspector_lists_both(self) -> None:
        self._asset("a")
        self._face("a")
        self._pets("a", [animal("dog", unit({0: 1.0}, PET_DIMENSIONS))])
        self._asset("b")
        self._pets("b", [animal("cat", unit({0: 1.0}, PET_DIMENSIONS))])

        people = get_asset_people(self.connection, asset_id="a")
        self.assertEqual((people["has_face"], people["face_count"], people["pet_count"]), (True, 1, 1))
        self.assertEqual(sorted(face["subject"] for face in people["faces"]), ["dog", "person"])
        only_cat = get_asset_people(self.connection, asset_id="b")
        self.assertEqual((only_cat["has_face"], only_cat["pet_count"]), (False, 1))

        badges = {row["asset_id"]: row["has_face"] for row in list_image_assets(self.connection, status="all")}
        self.assertEqual(badges, {"a": True, "b": False})

    def test_filters_tell_faces_cats_and_dogs_apart(self) -> None:
        for asset_id in ("person", "cat", "dog", "nothing"):
            self._asset(asset_id)
        self._face("person")
        self._pets("cat", [animal("cat", unit({0: 1.0}, PET_DIMENSIONS))])
        self._pets("dog", [animal("dog", unit({0: 1.0}, PET_DIMENSIONS))])

        def matching(filters: dict) -> set[str]:
            return {str(row["asset_id"]) for row in list_image_assets(self.connection, status="all", filters=filters)}

        self.assertEqual(matching({"people": "with_faces"}), {"person"})
        self.assertEqual(matching({"people": "without_faces"}), {"cat", "dog", "nothing"})
        self.assertEqual(matching({"pets": "any"}), {"cat", "dog"})
        self.assertEqual(matching({"pets": "cat"}), {"cat"})
        self.assertEqual(matching({"pets": "dog"}), {"dog"})
        self.assertEqual(matching({"pets": "none"}), {"person", "nothing"})

    def test_cats_and_dogs_never_share_a_group_and_groups_know_their_species(self) -> None:
        # The same vector for a cat and a dog: identical by the model, still
        # two groups, because the detector already said which species.
        same = unit({0: 1.0}, PET_DIMENSIONS)
        ids = []
        for index, subject in enumerate(["cat", "cat", "dog", "dog"]):
            self._asset(f"p{index}")
            ids += self._pets(f"p{index}", [animal(subject, same)])
        rebuild_candidate_groups(self.connection, model_id=PET[0], model_version=PET[1], threshold=0.58)

        self.assertEqual(self._group_of(ids[0]), self._group_of(ids[1]))
        self.assertEqual(self._group_of(ids[2]), self._group_of(ids[3]))
        self.assertNotEqual(self._group_of(ids[0]), self._group_of(ids[2]))
        subjects = sorted(str(group["subject"]) for group in list_person_groups(self.connection))
        self.assertEqual(subjects, ["cat", "dog"])

    def test_a_pet_tile_shows_the_head_when_the_pose_found_one(self) -> None:
        vector = unit({0: 1.0}, PET_DIMENSIONS)
        self._asset("a")
        self._asset("b")
        self._pets("a", [animal("cat", vector, head=[0.4, 0.35, 0.1, 0.1])])
        self._pets("b", [animal("cat", vector, head=[0.4, 0.35, 0.1, 0.1])])
        self._asset("c")
        self._asset("d")
        self._pets("c", [animal("dog", vector)])
        self._pets("d", [animal("dog", vector)])
        rebuild_candidate_groups(self.connection, model_id=PET[0], model_version=PET[1], threshold=0.58)

        covers = {group["subject"]: group["cover_bbox"] for group in list_person_groups(self.connection)}
        self.assertEqual(covers["cat"], [0.4, 0.35, 0.1, 0.1])
        self.assertEqual(covers["dog"], [0.2, 0.3, 0.5, 0.5])

    def test_corrections_never_mix_cats_and_dogs(self) -> None:
        vector = unit({0: 1.0}, PET_DIMENSIONS)
        ids = []
        for index, subject in enumerate(["cat", "cat", "dog", "dog"]):
            self._asset(f"p{index}")
            ids += self._pets(f"p{index}", [animal(subject, vector)])
        rebuild_candidate_groups(self.connection, model_id=PET[0], model_version=PET[1], threshold=0.58)
        cats, dogs = self._group_of(ids[0]), self._group_of(ids[2])
        set_person_group_name(self.connection, group_id=cats, name="Mochi")
        set_person_group_name(self.connection, group_id=dogs, name="Bo")

        with self.assertRaisesRegex(ValueError, "cat"):
            merge_person_groups(self.connection, source_group_id=cats, target_group_id=dogs)
        with self.assertRaisesRegex(ValueError, "dog"):
            assign_face_to_group(self.connection, face_id=ids[2], group_id=cats)
        # Merge suggestions stay within the species.
        self.assertEqual(list_similar_person_groups(self.connection, group_id=cats), [])

    def test_the_pet_and_person_filters_combine(self) -> None:
        self._asset("both")
        self._face("both")
        self._pets("both", [animal("dog", unit({0: 1.0}, PET_DIMENSIONS))])
        self._asset("dog-only")
        self._pets("dog-only", [animal("dog", unit({0: 1.0}, PET_DIMENSIONS))])
        rows = list_image_assets(self.connection, status="all", filters={"people": "with_faces", "pets": "dog"})
        self.assertEqual({row["asset_id"] for row in rows}, {"both"})


if __name__ == "__main__":
    unittest.main()
