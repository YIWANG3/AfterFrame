"""What each photo looks like (asset_visual): its perceptual hash, its
feature print when a Mac made one, and the near-duplicate group it fell
into. Written by the visual job (job_runner.run_visual_job) from the 512 px
previews; read by find-similar and the Duplicates view.

Exact duplicates (same bytes) are a different thing: assets.fingerprint
and get_duplicate_assets. These are pictures that *look* the same: another
export of one RAW, a re-encode, a crop."""
from __future__ import annotations

import sqlite3
import uuid
from pathlib import Path

import numpy as np

from ..visual import (
    DUPLICATE_MAX_DISTANCE,
    DUPLICATE_MAX_HAMMING,
    HASH_VERSION,
    distances_to_all,
    from_signed,
    hamming_to_all,
    pack_embedding,
    to_signed,
    unpack_embedding,
)

# How many look-alikes the "photos like this one" view goes down to.
SIMILAR_VIEW_MAX = 200

# Photos and RAWs are compared within their own kind: a RAW and its export
# are the same picture by construction, not a duplicate worth showing.
VISUAL_ASSET_TYPES = ("image", "raw")


def replace_asset_visual(
    connection: sqlite3.Connection,
    asset_id: str,
    *,
    phash: int | None,
    embedding: np.ndarray | None,
    embedding_model: str | None,
    commit: bool = False,
) -> None:
    """Store a photo's hash and (when there is one) feature print. A missing
    feature print keeps the one already stored: the hash pass on a Windows
    box must not wipe the vectors a Mac made."""
    row = connection.execute("SELECT embedding, embedding_model FROM asset_visual WHERE asset_id = ?", (asset_id,)).fetchone()
    blob = pack_embedding(embedding) if embedding is not None else (row["embedding"] if row else None)
    model = embedding_model if embedding is not None else (row["embedding_model"] if row else None)
    connection.execute(
        """
        INSERT INTO asset_visual (asset_id, phash, hash_version, embedding, embedding_model, analyzed_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(asset_id) DO UPDATE SET
            phash = excluded.phash, hash_version = excluded.hash_version,
            embedding = excluded.embedding, embedding_model = excluded.embedding_model,
            analyzed_at = excluded.analyzed_at
        """,
        (asset_id, to_signed(phash) if phash is not None else None, HASH_VERSION, blob, model),
    )
    if commit:
        connection.commit()


_WITH_PREVIEW = """
    FROM assets
    JOIN preview_entries ON preview_entries.asset_id = assets.asset_id
        AND preview_entries.kind = 'preview' AND preview_entries.status = 'ready'
    LEFT JOIN asset_visual v ON v.asset_id = assets.asset_id
    WHERE assets.exists_on_disk = 1 AND assets.asset_type IN ('image', 'raw')
"""


def _missing_clause(embedding_model: str | None) -> str:
    """Rows the job still has to do: no hash, an older hash, or (when this
    machine can make feature prints) no feature print by this model."""
    clause = "AND (v.asset_id IS NULL OR v.hash_version IS NOT ? OR v.phash IS NULL"
    if embedding_model:
        clause += " OR v.embedding IS NULL OR v.embedding_model IS NOT ?"
    return clause + ")"


def _missing_params(embedding_model: str | None) -> tuple:
    return (HASH_VERSION, embedding_model) if embedding_model else (HASH_VERSION,)


def list_assets_missing_visual(
    connection: sqlite3.Connection, *, embedding_model: str | None, limit: int | None = None, force: bool = False
) -> list[sqlite3.Row]:
    scope = _WITH_PREVIEW if force else _WITH_PREVIEW + _missing_clause(embedding_model)
    params = () if force else _missing_params(embedding_model)
    sql = f"SELECT assets.asset_id, assets.asset_type, preview_entries.relative_path {scope} ORDER BY assets.created_at DESC"
    if limit:
        sql += f" LIMIT {int(limit)}"
    return connection.execute(sql, params).fetchall()


def visual_status(connection: sqlite3.Connection, *, embedding_model: str | None = None) -> dict[str, int]:
    hashed = connection.execute("SELECT COUNT(*) FROM asset_visual WHERE phash IS NOT NULL").fetchone()[0]
    embedded = connection.execute("SELECT COUNT(*) FROM asset_visual WHERE embedding IS NOT NULL").fetchone()[0]
    missing = connection.execute(
        f"SELECT COUNT(*) {_WITH_PREVIEW}{_missing_clause(embedding_model)}", _missing_params(embedding_model)
    ).fetchone()[0]
    groups = connection.execute("SELECT COUNT(DISTINCT dup_group) FROM asset_visual WHERE dup_group IS NOT NULL").fetchone()[0]
    return {"hashed": int(hashed), "embedded": int(embedded), "missing": int(missing), "duplicate_groups": int(groups)}


class VisualIndex:
    """Every hash, feature print and group of one asset type, as arrays: a
    few MB for a large library, and a distance to all of them is one numpy
    call. Grows in place as a pass analyses photos (capacity doubles), so an
    import of thousands stays linear."""

    def __init__(self, connection: sqlite3.Connection, asset_type: str, *, embedding_model: str | None = None) -> None:
        rows = connection.execute(
            """
            SELECT v.asset_id, v.phash, v.embedding, v.embedding_model, v.dup_group
            FROM asset_visual v JOIN assets ON assets.asset_id = v.asset_id
            WHERE assets.asset_type = ? AND assets.exists_on_disk = 1 AND v.phash IS NOT NULL
            """,
            (asset_type,),
        ).fetchall()
        # Only vectors from one model compare; the first seen wins unless asked.
        model = embedding_model or next((row["embedding_model"] for row in rows if row["embedding"] is not None), None)
        self.embedding_model = model
        self.ids: list[str] = []
        self.groups: list[str | None] = []
        self._position: dict[str, int] = {}
        self._n = 0
        self._hashes = np.zeros(max(16, 2 * len(rows)), dtype=np.uint64)
        self._embedded_at = np.full(len(self._hashes), -1, dtype=np.int64)  # position → row in _embeddings
        self._n_embedded = 0
        self._embeddings = np.zeros((0, 0), dtype=np.float32)
        for row in rows:
            blob = row["embedding"] if row["embedding"] is not None and row["embedding_model"] == model else None
            self.add(row["asset_id"], from_signed(row["phash"]), unpack_embedding(blob) if blob is not None else None, row["dup_group"])

    def __len__(self) -> int:
        return self._n

    @property
    def hashes(self) -> np.ndarray:
        return self._hashes[: self._n]

    @property
    def embeddings(self) -> np.ndarray:
        return self._embeddings[: self._n_embedded]

    def position(self, asset_id: str) -> int | None:
        return self._position.get(asset_id)

    def add(self, asset_id: str, phash: int, embedding: np.ndarray | None, group: str | None = None) -> None:
        """A photo analysed after the index was loaded joins it (its vector
        is by the model the index was built for)."""
        if asset_id in self._position:
            return
        if self._n == len(self._hashes):
            self._hashes = np.concatenate([self._hashes, np.zeros(len(self._hashes), dtype=np.uint64)])
            self._embedded_at = np.concatenate([self._embedded_at, np.full(len(self._embedded_at), -1, dtype=np.int64)])
        position = self._n
        self._position[asset_id] = position
        self.ids.append(asset_id)
        self.groups.append(group)
        self._hashes[position] = np.uint64(phash)
        self._n += 1
        if embedding is not None:
            vector = np.asarray(embedding, dtype=np.float32)
            if self._embeddings.size == 0:
                self._embeddings = np.zeros((16, len(vector)), dtype=np.float32)
            elif self._n_embedded == len(self._embeddings):
                self._embeddings = np.concatenate([self._embeddings, np.zeros_like(self._embeddings)])
            self._embeddings[self._n_embedded] = vector
            self._embedded_at[position] = self._n_embedded
            self._n_embedded += 1

    def set_group(self, position: int, group: str | None) -> None:
        self.groups[position] = group

    def embedding_of(self, asset_id: str) -> np.ndarray | None:
        index = self.position(asset_id)
        if index is None or self._embedded_at[index] < 0:
            return None
        return self._embeddings[self._embedded_at[index]]

    def similar(self, asset_id: str, limit: int) -> list[dict]:
        """The photos most like `asset_id`, nearest first, by feature print;
        by hash when there is none. Each: {asset_id, distance, hamming}."""
        index = self.position(asset_id)
        if index is None:
            return []
        hamming = hamming_to_all(self.hashes, int(self._hashes[index]))
        vector = self.embedding_of(asset_id)
        if vector is not None:
            embedded_positions = np.nonzero(self._embedded_at[: self._n] >= 0)[0]
            distances = distances_to_all(self._embeddings[self._embedded_at[embedded_positions]], vector)
            order = np.argsort(distances, kind="stable")
            results = []
            for rank in order:
                row = int(embedded_positions[rank])
                if row == index:
                    continue
                results.append({"asset_id": self.ids[row], "distance": round(float(distances[rank]), 4), "hamming": int(hamming[row])})
                if len(results) >= limit:
                    break
            return results
        order = np.argsort(hamming, kind="stable")
        return [
            {"asset_id": self.ids[row], "distance": None, "hamming": int(hamming[row])}
            for row in order if row != index
        ][:limit]

    def duplicates_of(self, phash: int, embedding: np.ndarray | None) -> list[int]:
        """Positions of the photos that look the same as one with this hash
        (and feature print): close in hash, and close in feature print when
        both sides have one."""
        if self._n == 0:
            return []
        close = np.nonzero(hamming_to_all(self.hashes, phash) <= DUPLICATE_MAX_HAMMING)[0]
        if embedding is None or len(close) == 0:
            return [int(row) for row in close]
        embedded_at = self._embedded_at[close]
        keep = embedded_at < 0  # no print on that side: the hash decides
        with_print = np.nonzero(embedded_at >= 0)[0]
        if len(with_print):
            distances = distances_to_all(self._embeddings[embedded_at[with_print]], np.asarray(embedding, dtype=np.float32))
            keep[with_print] = distances <= DUPLICATE_MAX_DISTANCE
        return [int(row) for row in close[keep]]


def find_similar(connection: sqlite3.Connection, asset_id: str, *, limit: int = 24) -> list[dict]:
    row = connection.execute("SELECT asset_type FROM assets WHERE asset_id = ?", (asset_id,)).fetchone()
    if row is None or row["asset_type"] not in VISUAL_ASSET_TYPES:
        return []
    return VisualIndex(connection, row["asset_type"]).similar(asset_id, limit)


class VisualAnalyzer:
    """Hash (and, with the helper, feature-print) previews and put each photo
    in its look-alike group. The preview pass uses one for a batch, the
    visual job for its catch-up; both commit themselves.

    Measuring (`measure`) is safe from several threads at once — each gets
    its own helper process, so the preview pass takes the prints alongside
    its renders — and storing (`store`) is for the thread that owns the
    connection."""

    def __init__(self, connection: sqlite3.Connection, helper_path: Path | None) -> None:
        import threading

        from ..visual import FeatureHelper, FeatureHelperError

        self.connection = connection
        self.helper_path = helper_path
        self._helpers: list[FeatureHelper] = []
        self._local = threading.local()
        self._lock = threading.Lock()
        self.embedding_model: str | None = None
        if helper_path:
            try:
                self._local.helper = FeatureHelper(helper_path)
                self._helpers.append(self._local.helper)
                self.embedding_model = self._local.helper.model
            except FeatureHelperError:
                self.helper_path = None  # hashes alone, as on a machine without it
        self._indexes: dict[str, VisualIndex] = {}
        self.embedded = 0
        self.grouped = 0

    @property
    def helper(self):
        """This thread's helper, started on first use; None without one."""
        from ..visual import FeatureHelper, FeatureHelperError

        if not self.helper_path:
            return None
        helper = getattr(self._local, "helper", None)
        if helper is None:
            try:
                helper = FeatureHelper(self.helper_path)
            except FeatureHelperError:
                return None
            self._local.helper = helper
            with self._lock:
                self._helpers.append(helper)
        return helper

    def measure(self, asset_id: str, preview_path: Path) -> tuple[int | None, np.ndarray | None]:
        """The hash and (with a helper) the feature print of a preview; the
        hash is None when the preview can't be read."""
        from ..visual import FeatureHelperError, perceptual_hash

        phash = perceptual_hash(preview_path)
        if phash is None:
            return None, None
        vector = None
        helper = self.helper
        if helper is not None:
            try:
                _, vector = helper.embed(asset_id, preview_path)
            except FeatureHelperError:
                vector = None
        return phash, vector

    def analyze(self, asset_id: str, asset_type: str, preview_path: Path) -> bool:
        """Measure and store. False when the preview can't be read (the next
        pass retries)."""
        phash, vector = self.measure(asset_id, preview_path)
        return self.store(asset_id, asset_type, phash, vector)

    def store(self, asset_id: str, asset_type: str, phash: int | None, vector: np.ndarray | None) -> bool:
        if phash is None:
            return False
        if vector is not None:
            self.embedded += 1
        replace_asset_visual(self.connection, asset_id, phash=phash, embedding=vector, embedding_model=self.embedding_model)
        # One index per kind for the whole pass; a photo is matched against
        # what was there before it, then becomes part of it.
        index = self._indexes.get(asset_type)
        if index is None:
            index = self._indexes[asset_type] = VisualIndex(self.connection, asset_type, embedding_model=self.embedding_model)
        group = assign_duplicate_group(self.connection, index, asset_id, phash, vector)
        if group:
            self.grouped += 1
        index.add(asset_id, phash, vector, group)
        return True

    def close(self) -> None:
        with self._lock:
            helpers, self._helpers = self._helpers, []
        for helper in helpers:
            helper.close()
        self.helper_path = None


def similar_assets(connection: sqlite3.Connection, catalog_root: Path, asset_id: str, *, limit: int = 24) -> list[dict]:
    """find_similar with what a strip of thumbnails needs: stem, path and
    preview of each photo."""
    ranked = find_similar(connection, asset_id, limit=limit)
    if not ranked:
        return []
    placeholders = ",".join("?" * len(ranked))
    rows = connection.execute(
        f"""
        SELECT assets.asset_id, assets.stem, assets.canonical_path AS image_path, previews.relative_path AS preview_relative_path
        FROM assets
        LEFT JOIN preview_entries previews ON previews.asset_id = assets.asset_id AND previews.kind = 'preview' AND previews.status = 'ready'
        WHERE assets.asset_id IN ({placeholders})
        """,
        [entry["asset_id"] for entry in ranked],
    ).fetchall()
    by_id = {row["asset_id"]: row for row in rows}
    result = []
    for entry in ranked:
        row = by_id.get(entry["asset_id"])
        if row is None:
            continue
        preview = row["preview_relative_path"]
        result.append({
            **entry, "stem": row["stem"], "image_path": row["image_path"],
            "preview_path": str((catalog_root / preview).resolve()) if preview else None,
        })
    return result


# The gallery's "Look-alikes" view: photos in a group of two or more.
LOOKALIKES_CLAUSE = """assets.asset_id IN (
    SELECT asset_id FROM asset_visual WHERE dup_group IN (
        SELECT dup_group FROM asset_visual WHERE dup_group IS NOT NULL GROUP BY dup_group HAVING COUNT(*) > 1))"""


def assign_duplicate_group(
    connection: sqlite3.Connection, index: VisualIndex, asset_id: str, phash: int, embedding: np.ndarray | None, *, commit: bool = False
) -> str | None:
    """Put a just-analysed photo in the group of the ones it duplicates:
    theirs when they have one, a new one otherwise; groups it bridges are
    merged. Only rows whose group changes are written, so a thousand frames
    of one picture cost a thousand small writes, not a million. Returns the
    group, or None when it duplicates nothing."""
    own = index.position(asset_id)
    matches = [position for position in index.duplicates_of(phash, embedding) if position != own]
    if not matches:
        connection.execute("UPDATE asset_visual SET dup_group = NULL WHERE asset_id = ?", (asset_id,))
        if commit:
            connection.commit()
        return None
    groups = sorted({group_of for group_of in (index.groups[position] for position in matches) if group_of is not None})
    group = groups[0] if groups else uuid.uuid4().hex[:12]
    if len(groups) > 1:
        others = groups[1:]
        connection.execute(f"UPDATE asset_visual SET dup_group = ? WHERE dup_group IN ({','.join('?' * len(others))})", (group, *others))
        merged = set(others)
        for position, current in enumerate(index.groups):
            if current in merged:
                index.set_group(position, group)
    ungrouped = [position for position in matches if index.groups[position] != group]
    if ungrouped:
        ids = [index.ids[position] for position in ungrouped]
        connection.execute(f"UPDATE asset_visual SET dup_group = ? WHERE asset_id IN ({','.join('?' * len(ids))})", (group, *ids))
        for position in ungrouped:
            index.set_group(position, group)
    connection.execute("UPDATE asset_visual SET dup_group = ? WHERE asset_id = ?", (group, asset_id))
    if own is not None:
        index.set_group(own, group)
    if commit:
        connection.commit()
    return group


def list_duplicate_groups(connection: sqlite3.Connection, *, limit: int = 100, offset: int = 0) -> list[dict]:
    """Groups of look-alike photos, largest first, with their members."""
    groups = connection.execute(
        """
        SELECT v.dup_group, COUNT(*) AS size
        FROM asset_visual v JOIN assets ON assets.asset_id = v.asset_id
        WHERE v.dup_group IS NOT NULL AND assets.exists_on_disk = 1
        GROUP BY v.dup_group HAVING COUNT(*) > 1
        ORDER BY size DESC, v.dup_group
        LIMIT ? OFFSET ?
        """,
        (int(limit), int(offset)),
    ).fetchall()
    result = []
    for group in groups:
        members = connection.execute(
            """
            SELECT v.asset_id FROM asset_visual v JOIN assets ON assets.asset_id = v.asset_id
            WHERE v.dup_group = ? AND assets.exists_on_disk = 1 ORDER BY assets.created_at
            """,
            (group["dup_group"],),
        ).fetchall()
        result.append({"group": group["dup_group"], "asset_ids": [row[0] for row in members]})
    return result


def count_duplicate_assets(connection: sqlite3.Connection) -> int:
    return int(
        connection.execute(
            """
            SELECT COUNT(*) FROM asset_visual v JOIN assets ON assets.asset_id = v.asset_id
            WHERE assets.exists_on_disk = 1 AND v.dup_group IN (
                SELECT dup_group FROM asset_visual GROUP BY dup_group HAVING COUNT(*) > 1)
            """
        ).fetchone()[0]
    )
