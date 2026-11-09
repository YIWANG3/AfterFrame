"""Tags as entities (db/tags.py): groups, aliases, the vocabulary, and the
library-level edits (move, rename, merge, delete, pin), with what each does
to the photos, the facets and the smart collections that name a tag."""
from __future__ import annotations

import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from media_workspace import annotation as ann
from media_workspace import cli
from media_workspace.catalog import ensure_catalog
from media_workspace.db import (
    connect,
    create_collection,
    get_facet_values,
    init_db,
    list_collections,
    list_image_assets,
    search_facet_values,
    upsert_image_asset,
    upsert_registry,
)
from media_workspace.db import tags as tag_entities
from media_workspace.db.facets import FACET_KEYS
from media_workspace.db.smart_rules import normalize_rules
from media_workspace.models import ImageCandidate, MatchDecision

STEMS = ("a", "b", "c", "d")


def result(*tags: str, groups: dict[str, str] | None = None) -> ann.AnnotationResult:
    return ann.AnnotationResult(
        caption="A photo", tags=list(tags), tag_groups=groups or {}, location=None, detected_text=None,
        raw_response="{}", provider="mock", model="m",
    )


class TagGroupsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.catalog = ensure_catalog(root / "groups.afcatalog")
        self.connection = connect(self.catalog.db_path)
        self.addCleanup(self.connection.close)
        init_db(self.connection)
        for stem in STEMS:
            path = root / f"{stem}.jpg"
            path.write_bytes(b"x")
            candidate = ImageCandidate(
                asset_id=f"image_{stem}", path=path, stem=stem, normalized_stem=stem, stem_key=stem,
                extension=".jpg", fingerprint=f"fp-{stem}", file_size=1, modified_time="2026-01-01T00:00:00",
                capture_time=None, rating=None, camera_make=None, camera_model=None,
                lens_model=None, software=None, iso=None, aperture=None, shutter_speed=None, focal_length=None,
                flash=None, white_balance=None, color_space=None, lens_specification=None,
                gps_latitude=None, gps_longitude=None, width=600, height=400,
            )
            upsert_image_asset(self.connection, candidate)
            upsert_registry(self.connection, MatchDecision(
                image_asset_id=candidate.asset_id, image_path=path, status="unmatched", score=0.0,
                raw_asset_id=None, feature_vector={},
            ))
        self.connection.commit()

    # ── helpers ──
    def run_cli(self, *argv: str) -> dict | list:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(cli.main(["--catalog", str(self.catalog.root), *argv]), 0)
        return json.loads(out.getvalue())

    def tags_of(self, stem: str) -> list[str]:
        return tag_entities.get_asset_tags(self.connection, f"image_{stem}")

    def group_of(self, tag: str) -> str | None:
        row = self.connection.execute("SELECT group_id FROM tags WHERE tag = ?", (tag,)).fetchone()
        return row[0] if row else None

    def aliases_of(self, tag: str) -> set[str]:
        return {r[0] for r in self.connection.execute("SELECT alias FROM tag_aliases WHERE tag = ?", (tag,))}

    def ids(self, **filters) -> set[str]:
        return {row["asset_id"] for row in list_image_assets(self.connection, "all", filters=filters)}

    # ── the built-ins ──
    def test_a_new_catalog_has_the_builtin_groups_and_no_tags(self):
        groups = tag_entities.list_tag_groups(self.connection)
        self.assertEqual([g["group_id"] for g in groups], [g for g, _, _ in tag_entities.BUILTIN_GROUPS])
        self.assertEqual({g["kind"] for g in groups}, {"builtin"})
        self.assertEqual({g["group_id"] for g in groups if not g["ai_fill"]}, {"workflow"})
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM tags").fetchone()[0], 0)

    def test_the_vocabulary_is_well_formed(self):
        groups = {g for g, _, _ in tag_entities.BUILTIN_GROUPS}
        seen: dict[str, str] = {}
        for concept in tag_entities.vocabulary():
            self.assertIn(concept.group, groups, concept)
            for spelling in concept.spellings():
                norm = tag_entities.normalize_tag(spelling)
                self.assertEqual(spelling, spelling.strip())
                self.assertNotIn(norm, seen, f"{spelling} is in two concepts: {seen.get(norm)} and {concept}")
                seen[norm] = concept.en
        self.assertGreater(len(tag_entities.vocabulary()), 150)

    # ── resolving spellings ──
    def test_a_vocabulary_tag_takes_its_group_and_its_other_language_as_an_alias(self):
        ann.add_asset_tag(self.connection, "image_a", "Sunset")
        self.assertEqual(self.tags_of("a"), ["sunset"])
        self.assertEqual(self.group_of("sunset"), "time")
        self.assertEqual(self.aliases_of("sunset"), {"日落"})
        # The Chinese spelling is the same tag, on the same photo once.
        self.assertEqual(ann.add_asset_tag(self.connection, "image_a", "日落")["tags"], ["sunset"])
        self.assertEqual(ann.add_asset_tag(self.connection, "image_b", "日落")["tags"], ["sunset"])
        # Whichever spelling the library met first is its spelling.
        ann.add_asset_tag(self.connection, "image_a", "海滩")
        self.assertEqual(ann.add_asset_tag(self.connection, "image_b", "beach")["tags"], ["sunset", "海滩"])
        self.assertEqual(self.group_of("海滩"), "place")

    def test_an_unknown_tag_is_ungrouped_unless_a_group_is_given(self):
        ann.add_asset_tag(self.connection, "image_a", "Grandma's 80th")
        self.assertIsNone(self.group_of("Grandma's 80th"))
        ann.add_asset_tag(self.connection, "image_a", "keepers", group_id="workflow")
        self.assertEqual(self.group_of("keepers"), "workflow")
        # An existing tag keeps its group; the picker only places new ones.
        ann.add_asset_tag(self.connection, "image_b", "keepers", group_id="mood")
        self.assertEqual(self.group_of("keepers"), "workflow")
        # A group that does not exist is no group.
        ann.add_asset_tag(self.connection, "image_b", "stray", group_id="grp_nope")
        self.assertIsNone(self.group_of("stray"))

    def test_batch_add_and_remove_many(self):
        added = tag_entities.add_asset_tags(self.connection, ["image_a", "image_b", "image_zz"], ["Rain", "雨", "trip"])
        self.assertEqual(added["tags"], ["rain", "trip"])
        self.assertEqual(added["missing"], ["image_zz"])
        self.assertEqual(self.tags_of("a"), ["rain", "trip"])
        selection = tag_entities.list_selection_tags(self.connection, ["image_a", "image_b"])
        self.assertEqual([(t["tag"], t["count"], t["group_id"]) for t in selection], [("rain", 2, "weather"), ("trip", 2, None)])
        removed = tag_entities.remove_asset_tags(self.connection, ["image_a", "image_b"], ["雨"])
        self.assertEqual(removed["removed"], 2)
        self.assertEqual(self.tags_of("a"), ["trip"])

    # ── the annotation run ──
    def test_grouped_model_output_places_new_tags_but_never_moves_known_ones(self):
        tag_entities.create_group(self.connection, "Pets")
        pets = next(g for g in tag_entities.list_tag_groups(self.connection) if g["name"] == "Pets")["group_id"]
        ann.add_asset_tag(self.connection, "image_a", "mochi", group_id=pets)
        tags, groups = ann.parse_tags({"subject": ["cat", "mochi"], "mood": ["cozy"], "other": ["blanket"], "workflow": ["client"]}, 10)
        self.assertEqual(tags, ["cat", "mochi", "cozy", "blanket", "client"])
        self.assertEqual(groups, {"cat": "subject", "mochi": "subject", "cozy": "mood", "client": "workflow"})
        saved = ann.save_annotation(self.connection, "image_a", result(*tags, groups=groups))
        self.assertEqual(saved["tags"], ["mochi", "cat", "cozy", "blanket", "client"])
        self.assertEqual(self.group_of("cat"), "subject")      # vocabulary agrees
        self.assertEqual(self.group_of("mochi"), pets)         # the user's group stays
        self.assertEqual(self.group_of("cozy"), "mood")
        self.assertIsNone(self.group_of("blanket"))            # "other" is no group
        self.assertIsNone(self.group_of("client"))             # workflow is not the model's to fill

    def test_a_model_group_wins_over_the_vocabulary_only_for_tags_it_does_not_know(self):
        saved = ann.save_annotation(self.connection, "image_a", result("neon", "rooftop bar", groups={"neon": "light", "rooftop bar": "place"}))
        self.assertEqual(saved["tags"], ["neon", "rooftop bar"])
        self.assertEqual(self.group_of("neon"), "color")          # the vocabulary's, not the model's
        self.assertEqual(self.group_of("rooftop bar"), "place")   # the model's, for a tag the vocabulary lacks

    def test_flat_model_output_still_finds_groups_through_the_vocabulary(self):
        tags, groups = ann.parse_tags(["Sunset", "beach", "something else"], 2)
        self.assertEqual((tags, groups), (["Sunset", "beach"], {}))
        ann.save_annotation(self.connection, "image_a", result(*tags))
        self.assertEqual(self.tags_of("a"), ["sunset", "beach"])
        self.assertEqual((self.group_of("sunset"), self.group_of("beach")), ("time", "place"))

    def test_the_prompt_lists_the_fillable_groups_with_the_librarys_tags(self):
        ann.add_asset_tag(self.connection, "image_a", "sunset")
        ann.add_asset_tag(self.connection, "image_a", "keepers", group_id="workflow")
        ann.add_asset_tag(self.connection, "image_a", "mystery")
        hints = ann.reuse_hints(self.connection)
        by_id = {h["id"]: h for h in hints}
        self.assertNotIn("workflow", by_id)
        self.assertEqual(by_id["time"]["examples"], ["sunset"])
        self.assertEqual(by_id["other"]["examples"], ["mystery"])
        prompt = ann.build_system_prompt(languages=["en"], max_tags=8, max_caption_chars=100, custom_instructions=None, tag_groups=hints)
        self.assertIn("- time (Time of day): sunset", prompt)
        self.assertIn("- weather (Weather)\n", prompt)
        self.assertNotIn("workflow", prompt)
        self.assertIn("8 tags in all", prompt)
        # A Chinese-only run is not shown English examples.
        zh = ann.build_system_prompt(languages=["zh"], max_tags=8, max_caption_chars=100, custom_instructions=None, tag_groups=hints)
        self.assertIn("- time (Time of day)\n", zh)

    # ── library-level edits ──
    def test_move_rename_pin(self):
        ann.add_asset_tag(self.connection, "image_a", "trip")
        tag_entities.set_tag_group(self.connection, ["trip"], "event")
        self.assertEqual(self.group_of("trip"), "event")
        tag_entities.set_tag_group(self.connection, ["trip"], None)
        self.assertIsNone(self.group_of("trip"))
        with self.assertRaises(ValueError):
            tag_entities.set_tag_group(self.connection, ["trip"], "grp_nope")

        renamed = tag_entities.rename_tag(self.connection, "trip", "Trips")
        self.assertEqual(renamed, {"tag": "Trips", "from": "trip", "merged": False})
        self.assertEqual(self.tags_of("a"), ["Trips"])
        self.assertEqual(self.aliases_of("Trips"), {"trip"})
        # The old spelling still lands on the renamed tag.
        self.assertEqual(ann.add_asset_tag(self.connection, "image_b", "TRIP")["tags"], ["Trips"])

        self.assertEqual(tag_entities.pin_tag(self.connection, "Trips", True), {"tag": "Trips", "pinned": True})
        listed = tag_entities.list_tags_grouped(self.connection)
        self.assertEqual([(t["tag"], t["pinned"], t["count"], t["aliases"]) for t in listed["ungrouped"]], [("Trips", True, 2, ["trip"])])

    def test_merge_keeps_every_photo_once_and_the_users_claim(self):
        ann.add_asset_tag(self.connection, "image_a", "nite")                    # user's
        ann.save_annotation(self.connection, "image_a", result("night"))        # AI's "night" on the same photo
        ann.save_annotation(self.connection, "image_b", result("nite"))
        ann.add_asset_tag(self.connection, "image_c", "night time")
        tag_entities.pin_tag(self.connection, "nite", True)
        merged = tag_entities.merge_tags(self.connection, ["nite", "night time"], "night")
        self.assertEqual(merged, {"target": "night", "merged": ["nite", "night time"], "photos": 3})
        self.assertEqual((self.tags_of("a"), self.tags_of("b"), self.tags_of("c")), (["night"], ["night"], ["night"]))
        sources = dict(self.connection.execute("SELECT asset_id, source FROM asset_tags WHERE tag = 'night'").fetchall())
        self.assertEqual(sources["image_a"], "user")
        self.assertEqual(self.aliases_of("night"), {"夜晚", "nite", "night time"})
        row = self.connection.execute("SELECT group_id, pinned FROM tags WHERE tag = 'night'").fetchone()
        self.assertEqual((row["group_id"], row["pinned"]), ("time", 1))
        self.assertIsNone(self.connection.execute("SELECT 1 FROM tags WHERE tag = 'nite'").fetchone())
        # Merging into a brand-new name makes it, in the first source's group.
        ann.add_asset_tag(self.connection, "image_d", "snack", group_id="event")
        tag_entities.merge_tags(self.connection, ["snack"], "snacks")
        self.assertEqual((self.tags_of("d"), self.group_of("snacks")), (["snacks"], "event"))
        # Renaming onto an existing tag is a merge.
        self.assertTrue(tag_entities.rename_tag(self.connection, "snacks", "night")["merged"])
        self.assertEqual(self.tags_of("d"), ["night"])

    def test_merge_and_delete_follow_into_smart_collections(self):
        ann.add_asset_tag(self.connection, "image_a", "nite")
        ann.add_asset_tag(self.connection, "image_b", "cafe")
        rules = {"version": 1, "status": "all", "search": "", "filters": {"tag": ["nite", "cafe"], "tag_match": "all",
                 "any_of": [{"tag": "nite"}, {"rating_min": 5}]}, "base": {"version": 1, "status": "all", "search": "", "filters": {"tag": "nite"}}}
        created = create_collection(self.connection, "Nights", kind="smart", rules_json=json.dumps(rules))
        tag_entities.merge_tags(self.connection, ["nite"], "night")
        saved = next(c for c in list_collections(self.connection) if c["collection_id"] == created["collection_id"])["rules"]
        self.assertEqual(saved["filters"]["tag"], ["night", "cafe"])
        self.assertEqual(saved["filters"]["any_of"][0], {"tag": "night"})
        self.assertEqual(saved["base"]["filters"]["tag"], "night")
        deleted = tag_entities.delete_tag(self.connection, "cafe")
        self.assertEqual(deleted, {"tag": "cafe", "photos": 1})
        self.assertEqual(self.tags_of("b"), [])
        saved = next(c for c in list_collections(self.connection) if c["collection_id"] == created["collection_id"])["rules"]
        self.assertEqual(saved["filters"]["tag"], "night")
        self.assertNotIn("tag_match", saved["filters"])

    def test_groups_are_created_renamed_and_deleted(self):
        group = tag_entities.create_group(self.connection, "Pets", ai_fill=False)
        self.assertEqual((group["kind"], group["ai_fill"]), ("custom", 0))
        tag_entities.update_group(self.connection, group["group_id"], name="Animals", ai_fill=True)
        listed = next(g for g in tag_entities.list_tag_groups(self.connection) if g["group_id"] == group["group_id"])
        self.assertEqual((listed["name"], listed["ai_fill"]), ("Animals", 1))
        ann.add_asset_tag(self.connection, "image_a", "mochi", group_id=group["group_id"])
        rules = {"version": 1, "status": "all", "search": "", "filters": {"tag_group": group["group_id"], "rating_min": 1}}
        created = create_collection(self.connection, "Pets", kind="smart", rules_json=json.dumps(rules))
        deleted = tag_entities.delete_group(self.connection, group["group_id"])
        self.assertEqual(deleted, {"group_id": group["group_id"], "ungrouped": 1})
        self.assertIsNone(self.group_of("mochi"))
        saved = next(c for c in list_collections(self.connection) if c["collection_id"] == created["collection_id"])["rules"]
        self.assertEqual(saved["filters"], {"rating_min": 1})
        # A deleted built-in group stays deleted across inits.
        tag_entities.delete_group(self.connection, "workflow")
        init_db(self.connection)
        self.assertNotIn("workflow", {g["group_id"] for g in tag_entities.list_tag_groups(self.connection)})
        with self.assertRaises(ValueError):
            tag_entities.delete_group(self.connection, "grp_nope")

    def test_regroup_by_vocabulary_only_moves_the_ungrouped(self):
        self.connection.execute("INSERT INTO tags (tag) VALUES ('sunset'), ('mystery')")
        self.connection.execute("INSERT INTO tags (tag, group_id) VALUES ('beach', 'mood')")
        self.connection.commit()
        self.assertEqual(tag_entities.regroup_by_vocabulary(self.connection), {"regrouped": 1})
        self.assertEqual((self.group_of("sunset"), self.group_of("beach"), self.group_of("mystery")), ("time", "mood", None))
        self.assertEqual(self.aliases_of("beach"), {"海滩"})

    # ── filtering ──
    def test_tag_match_by_group_and_the_group_facet(self):
        tag_entities.add_asset_tags(self.connection, ["image_a"], ["sunny", "street"])
        tag_entities.add_asset_tags(self.connection, ["image_b"], ["cloudy", "street"])
        tag_entities.add_asset_tags(self.connection, ["image_c"], ["sunny"])
        tag_entities.add_asset_tags(self.connection, ["image_d"], ["street", "trip"])
        picked = ["sunny", "cloudy", "street"]
        self.assertEqual(self.ids(tag=picked), {"image_a", "image_b", "image_c", "image_d"})
        self.assertEqual(self.ids(tag=picked, tag_match="all"), set())
        # (sunny OR cloudy) AND street.
        self.assertEqual(self.ids(tag=picked, tag_match="by_group"), {"image_a", "image_b"})
        # An ungrouped tag is a condition of its own.
        self.assertEqual(self.ids(tag=["sunny", "trip"], tag_match="by_group"), set())
        self.assertEqual(self.ids(tag=["street", "trip"], tag_match="by_group"), {"image_d"})
        self.assertEqual(self.ids(tag=picked, tag_match="by_group", exclude="tag"), {"image_c", "image_d"})
        # Any tag of a group; none of them.
        self.assertEqual(self.ids(tag_group="weather"), {"image_a", "image_b", "image_c"})
        self.assertEqual(self.ids(tag_group=["weather", "event"]), {"image_a", "image_b", "image_c"})
        self.assertEqual(self.ids(tag_group="weather", exclude="tag_group"), {"image_d"})
        # Saved as a smart collection.
        rules = normalize_rules({"filters": {"tag": picked, "tag_match": "by_group", "tag_group": "subject"}})
        self.assertEqual(rules["filters"], {"tag": picked, "tag_match": "by_group", "tag_group": "subject"})
        self.assertIn("tag_group", FACET_KEYS)

    def test_facet_options_come_by_group_with_the_groups_counts(self):
        tag_entities.add_asset_tags(self.connection, ["image_a", "image_b"], ["sunny", "street"])
        tag_entities.add_asset_tags(self.connection, ["image_c"], ["cloudy", "trip"])
        tag_entities.pin_tag(self.connection, "trip", True)
        facets = get_facet_values(self.connection)
        self.assertEqual(
            [(t["value"], t["count"], t["group_id"], t["pinned"]) for t in facets["tags"]],
            [("sunny", 2, "weather", False), ("cloudy", 1, "weather", False), ("street", 2, "subject", False), ("trip", 1, None, True)],
        )
        groups = {g["group_id"]: (g["asset_count"], g["shown_count"]) for g in facets["tag_groups"]}
        self.assertEqual(groups["weather"], (3, 2))
        self.assertEqual(groups["subject"], (2, 1))
        self.assertEqual(groups["mood"], (0, 0))
        self.assertEqual(facets["ungrouped_tag_count"], 1)
        # A picked tag that no longer matches is still listed; counts follow the other filters.
        narrowed = get_facet_values(self.connection, filters={"tag": "trip", "tag_group": "subject"})
        self.assertEqual([t["value"] for t in narrowed["tags"]], ["sunny", "street"])
        # Server-side search, by group, through an alias.
        found = search_facet_values(self.connection, "tag", "晴", 10)
        self.assertEqual([(t["value"], t["group_id"]) for t in found], [("sunny", "weather")])
        self.assertEqual([t["value"] for t in search_facet_values(self.connection, "tag", "", 10, group="weather")], ["sunny", "cloudy"])
        self.assertEqual([t["value"] for t in search_facet_values(self.connection, "tag", "", 10, group="ungrouped")], ["trip"])
        # The search box finds a photo through the alias too.
        self.assertEqual({r["asset_id"] for r in list_image_assets(self.connection, "all", search="晴天")}, {"image_a", "image_b"})

    # ── the CLI ──
    def test_the_cli_commands(self):
        self.run_cli("add-asset-tags", "--asset-id", "image_a", "--asset-id", "image_b", "--tag", "sunset", "--tag", "trip")
        listed = self.run_cli("list-tags")
        self.assertEqual(listed["count"], 2)
        time_group = next(g for g in listed["groups"] if g["group_id"] == "time")
        self.assertEqual([t["tag"] for t in time_group["tags"]], ["sunset"])
        self.assertEqual([t["tag"] for t in listed["ungrouped"]], ["trip"])
        self.assertEqual(self.run_cli("list-tags", "--flat"), ["sunset", "trip"])
        self.assertEqual([t["tag"] for t in self.run_cli("list-tags", "--query", "日落")["groups"][2]["tags"]], ["sunset"])

        created = self.run_cli("manage-tag-groups", "--action", "create", "--name", "Trips")
        self.run_cli("set-tag-group", "--tag", "trip", "--group", created["group_id"])
        self.assertEqual(self.group_of("trip"), created["group_id"])
        self.run_cli("manage-tag-groups", "--action", "rename", "--group", created["group_id"], "--name", "Journeys")
        self.run_cli("manage-tag-groups", "--action", "ai-fill", "--group", created["group_id"], "--ai-fill", "0")
        groups = {g["group_id"]: g for g in self.run_cli("list-tag-groups")["groups"]}
        self.assertEqual((groups[created["group_id"]]["name"], groups[created["group_id"]]["ai_fill"]), ("Journeys", 0))

        self.assertEqual(self.run_cli("rename-tag", "--tag", "trip", "--to", "journey")["tag"], "journey")
        self.assertEqual(self.run_cli("pin-tag", "--tag", "journey", "--pinned", "1"), {"tag": "journey", "pinned": True})
        self.run_cli("add-asset-tag", "--asset-id", "image_c", "--tag", "voyage")
        self.assertEqual(self.run_cli("merge-tags", "--tag", "voyage", "--into", "journey")["photos"], 1)
        self.assertEqual(self.tags_of("c"), ["journey"])
        selection = self.run_cli("list-selection-tags", "--asset-id", "image_a", "--asset-id", "image_c")
        self.assertEqual([(t["tag"], t["count"]) for t in selection["tags"]], [("journey", 2), ("sunset", 1)])
        self.assertEqual(self.run_cli("remove-asset-tags", "--asset-id", "image_a", "--asset-id", "image_c", "--tag", "journey")["removed"], 2)
        self.assertEqual(self.run_cli("delete-tag", "--tag", "journey")["photos"], 1)
        self.assertEqual(self.run_cli("manage-tag-groups", "--action", "delete", "--group", created["group_id"])["ungrouped"], 0)
        self.connection.execute("INSERT INTO tags (tag) VALUES ('beach')")
        self.connection.commit()
        self.assertEqual(self.run_cli("regroup-tags"), {"regrouped": 1})


if __name__ == "__main__":
    unittest.main()
