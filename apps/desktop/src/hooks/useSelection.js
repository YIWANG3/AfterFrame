// Gallery selection state + interaction grammar, extracted from App.jsx
// (review P3-6). Owns the multi-select id list and anchor; the PRIMARY id
// stays in useWorkspace (it drives detail loading) and flows in as
// primaryId/setPrimaryId. Pure selection logic — no IPC, no overlays.

import { useEffect, useMemo, useState } from "react";

export default function useSelection({
  orderedIds,
  itemById,
  currentItems,
  layoutItems,
  displayMode,
  primaryId,
  setPrimaryId,
}) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [anchorId, setAnchorId] = useState(null);
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedIndex = useMemo(
    () => currentItems.findIndex((item) => item.asset_id === primaryId),
    [currentItems, primaryId],
  );

  function commitSelection(nextIds, requestedPrimary, requestedAnchor = requestedPrimary) {
    const deduped = [];
    const seen = new Set();
    for (const id of nextIds) {
      if (!id || seen.has(id) || !itemById.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    const nextPrimary = requestedPrimary && itemById.has(requestedPrimary) ? requestedPrimary : deduped[0] || null;
    // Marquee drags call this on every pointermove — bail when nothing changed.
    // (Compare against the CURRENT primary prop, not the requested one.)
    if (
      nextPrimary === primaryId &&
      deduped.length === selectedIds.length &&
      deduped.every((id, i) => id === selectedIds[i])
    ) {
      return;
    }
    setSelectedIds(deduped);
    setAnchorId(requestedAnchor && itemById.has(requestedAnchor) ? requestedAnchor : nextPrimary);
    setPrimaryId(nextPrimary);
  }

  function selectSingle(id) {
    commitSelection(id ? [id] : [], id, id);
  }

  function toggleSelection(id) {
    if (!id) return;
    if (selectedIdSet.has(id)) {
      const nextIds = selectedIds.filter((existingId) => existingId !== id);
      const nextPrimary =
        primaryId === id ? nextIds[nextIds.length - 1] || null : primaryId;
      commitSelection(nextIds, nextPrimary, anchorId === id ? nextPrimary : anchorId);
      return;
    }
    commitSelection([...selectedIds, id], id, anchorId || id);
  }

  function selectRange(id, append = false) {
    if (!id) return;
    const anchor = anchorId || primaryId || id;
    const anchorIndex = orderedIds.indexOf(anchor);
    const targetIndex = orderedIds.indexOf(id);
    if (anchorIndex < 0 || targetIndex < 0) {
      selectSingle(id);
      return;
    }
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const rangeIds = orderedIds.slice(start, end + 1);
    const nextIds = append ? [...selectedIds, ...rangeIds] : rangeIds;
    commitSelection(nextIds, id, anchor);
  }

  function handleItemSelect(assetId, event) {
    if (!event) {
      selectSingle(assetId);
      return;
    }
    const isToggle = event.metaKey || event.ctrlKey;
    if (event.shiftKey) {
      selectRange(assetId, isToggle);
      return;
    }
    if (isToggle) {
      toggleSelection(assetId);
      return;
    }
    selectSingle(assetId);
  }

  function handleContextSelect(assetId) {
    if (selectedIdSet.has(assetId)) {
      setPrimaryId(assetId);
      return;
    }
    selectSingle(assetId);
  }

  function handleSelectionGroup(ids, primaryId, anchorId = primaryId) {
    commitSelection(ids, primaryId, anchorId);
  }

  function clearSelection() {
    setSelectedIds([]);
    setAnchorId(null);
    setPrimaryId(null);
  }

  function prepareDragSelection(assetId) {
    if (selectedIdSet.has(assetId) && selectedIds.length > 1) {
      setPrimaryId(assetId);
      const imagePaths = selectedIds.map((id) => itemById.get(id)?.image_path).filter(Boolean);
      return { assetIds: selectedIds, imagePaths };
    }
    selectSingle(assetId);
    const item = itemById.get(assetId);
    return {
      assetIds: [assetId].filter(Boolean),
      imagePaths: [item?.image_path].filter(Boolean),
    };
  }

  function selectByIndex(index) {
    const next = currentItems[index];
    if (!next) return;
    selectSingle(next.asset_id);
  }

  function moveSelection(offset) {
    if (!currentItems.length) return;
    if (selectedIndex < 0) {
      selectByIndex(offset >= 0 ? 0 : currentItems.length - 1);
      return;
    }
    const nextIndex = selectedIndex + offset;
    if (nextIndex < 0 || nextIndex >= currentItems.length) return;
    selectByIndex(nextIndex);
  }

  function selectByDirection(direction) {
    if (!currentItems.length) return;
    if (!primaryId) {
      selectByIndex(0);
      return;
    }

    const current = layoutItems.find((item) => item.assetId === primaryId);
    if (!current) {
      moveSelection(direction === "left" || direction === "up" ? -1 : 1);
      return;
    }

    const isForward = direction === "right" || direction === "down";
    const curCenterX = current.left + current.width / 2;
    const curCenterY = current.top + current.height / 2;

    function groupByPosition(items, getPos, tolerance) {
      const groups = [];
      for (const item of items) {
        const pos = getPos(item);
        const existing = groups.find((g) => Math.abs(g.key - pos) < tolerance);
        if (existing) {
          existing.items.push(item);
        } else {
          groups.push({ key: pos, items: [item] });
        }
      }
      groups.sort((a, b) => a.key - b.key);
      return groups;
    }

    if (displayMode === "grid" || displayMode === "tiles") {
      if (direction === "left" || direction === "right") {
        moveSelection(isForward ? 1 : -1);
      } else {
        const colCount = layoutItems.filter((c) => Math.abs(c.top - current.top) < 2).length || 1;
        moveSelection(isForward ? colCount : -colCount);
      }
      return;
    }

    if (displayMode === "justified") {
      if (direction === "left" || direction === "right") {
        moveSelection(isForward ? 1 : -1);
        return;
      }
      const rows = groupByPosition(layoutItems, (item) => item.top, 8);
      const curRowIdx = rows.findIndex((r) => r.items.some((item) => item.assetId === current.assetId));
      const targetRowIdx = isForward ? curRowIdx + 1 : curRowIdx - 1;
      if (targetRowIdx < 0 || targetRowIdx >= rows.length) return;
      const targetRow = rows[targetRowIdx].items;
      let best = targetRow[0];
      let bestDist = Infinity;
      for (const item of targetRow) {
        const dist = Math.abs(item.left + item.width / 2 - curCenterX);
        if (dist < bestDist) { bestDist = dist; best = item; }
      }
      selectSingle(best.assetId);
      return;
    }

    if (displayMode === "waterfall") {
      const columns = groupByPosition(layoutItems, (item) => item.left, 4);
      for (const col of columns) col.items.sort((a, b) => a.top - b.top);
      const curColIdx = columns.findIndex((c) => c.items.some((item) => item.assetId === current.assetId));
      const curCol = columns[curColIdx];
      const curItemInColIdx = curCol.items.findIndex((item) => item.assetId === current.assetId);

      if (direction === "left" || direction === "right") {
        const targetColIdx = isForward ? curColIdx + 1 : curColIdx - 1;
        if (targetColIdx < 0 || targetColIdx >= columns.length) return;
        const targetCol = columns[targetColIdx].items;
        let best = targetCol[0];
        let bestDist = Infinity;
        for (const item of targetCol) {
          const dist = Math.abs(item.top + item.height / 2 - curCenterY);
          if (dist < bestDist) { bestDist = dist; best = item; }
        }
        selectSingle(best.assetId);
      } else {
        const targetIdx = isForward ? curItemInColIdx + 1 : curItemInColIdx - 1;
        if (targetIdx < 0 || targetIdx >= curCol.items.length) return;
        selectSingle(curCol.items[targetIdx].assetId);
      }
      return;
    }
  }

  // Reconcile against the loaded item set: drop ids that no longer exist,
  // keep/restore the primary, repair the anchor.
  useEffect(() => {
    const validIds = new Set(orderedIds);
    setSelectedIds((current) => {
      const next = current.filter((id) => validIds.has(id));
      const validPrimary =
        primaryId && validIds.has(primaryId) ? primaryId : null;
      if (validPrimary) {
        if (!next.length) return [validPrimary];
        if (!next.includes(validPrimary)) return [validPrimary];
        return next;
      }
      return next;
    });
    setAnchorId((current) => {
      if (current && validIds.has(current)) return current;
      if (primaryId && validIds.has(primaryId)) {
        return primaryId;
      }
      return orderedIds[0] || null;
    });
  }, [orderedIds, primaryId]);

  return {
    selectedIds,
    setSelectedIds,
    anchorId,
    setAnchorId,
    selectedIdSet,
    selectedIndex,
    commitSelection,
    selectSingle,
    toggleSelection,
    selectRange,
    handleItemSelect,
    handleContextSelect,
    handleSelectionGroup,
    clearSelection,
    prepareDragSelection,
    selectByIndex,
    moveSelection,
    selectByDirection,
  };
}
