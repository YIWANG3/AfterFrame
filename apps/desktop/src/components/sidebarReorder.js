// Dragging the sidebar's entries and sections into another order
// (sidebarLayout.js keeps it). An entry is dragged by itself, a section by
// its heading; an entry lands among the entries, a section among the
// sections. A line shows where it will land.
//
// The nav takes these drags in the capture phase and stops them there, so
// what is inside never sees one: a collection row would read it as photos or
// a Finder drop, and the Collections heading as a collection moved to the
// top level. Drags that aren't these pass through untouched.

import { useState } from "react";

const MIME = "application/x-afterframe-sidebar-entry";

// `onMove(id, target, place)` moves `id` before or after `target`.
export function useSidebarReorder(onMove) {
  // { group, id } being dragged, and { id, place } where it would land.
  const [dragging, setDragging] = useState(null);
  const [target, setTarget] = useState(null);
  const end = () => { setDragging(null); setTarget(null); };

  // Where a drag over `event` would land: the item of the dragged group under
  // the pointer, before it in its top half and after it in its bottom half.
  // Over the item being dragged, nowhere; between items, where it last was.
  const landing = (event) => {
    const item = event.target.closest?.(`[data-reorder-group='${dragging.group}']`);
    if (!item) return undefined;
    const id = item.dataset.reorderItem;
    if (id === dragging.id) return null;
    const box = item.getBoundingClientRect();
    return { id, place: event.clientY < box.top + box.height / 2 ? "before" : "after" };
  };

  return {
    dragging,
    // What starts a drag: an entry's own button, a section's heading.
    handle: (group, id) => ({
      draggable: true,
      onDragStart: (event) => {
        event.stopPropagation();
        event.dataTransfer.setData(MIME, id);
        event.dataTransfer.effectAllowed = "move";
        setDragging({ group, id });
      },
      onDragEnd: end,
    }),
    // What a drag lands on: the entry, or the section's whole root.
    item: (group, id) => ({
      "data-reorder-group": group,
      "data-reorder-item": id,
      "data-reorder-drop": target?.id === id ? target.place : undefined,
      "data-reorder-dragging": dragging?.id === id ? "true" : undefined,
    }),
    // On the nav.
    container: {
      onDragEnterCapture: (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.stopPropagation();
      },
      onDragOverCapture: (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const next = landing(event);
        if (next === undefined) return;
        setTarget((current) => (current?.id === next?.id && current?.place === next?.place ? current : next));
      },
      onDragLeaveCapture: (event) => {
        if (!dragging) return;
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget)) setTarget(null);
      },
      onDropCapture: (event) => {
        if (!dragging) return;
        event.preventDefault();
        event.stopPropagation();
        if (target) onMove(dragging.id, target.id, target.place);
        end();
      },
    },
  };
}
