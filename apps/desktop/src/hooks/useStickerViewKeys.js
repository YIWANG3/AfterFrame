// Keyboard navigation of the Stickers view, extracted from App.jsx (review
// S2): the arrows move the selection — linearly in the lightbox (a single
// image pager), by rows in the grid, where the column count is measured from
// the DOM so up/down jump rows the same way Gallery does — and Esc closes the
// lightbox. `items` is the sticker list shaped for the Lightbox (asset_id =
// sticker id). Returns a handler for App's global keydown: true when the key
// was the view's, so nothing else acts on it.

export default function useStickerViewKeys({ stickerView, items, lightboxOpen, setLightboxOpen }) {
  function selectIndex(index) {
    const item = items[index];
    const sticker = stickerView.stickers.find((s) => s.id === item?.asset_id);
    if (sticker) stickerView.setSelected(sticker);
  }

  function gridColumns() {
    const grid = document.querySelector("[data-sticker-grid='true']");
    if (!grid) return 1;
    const cards = grid.querySelectorAll("[data-sticker-card]");
    if (!cards.length) return 1;
    const firstTop = cards[0].offsetTop;
    return Array.from(cards).filter((el) => Math.abs(el.offsetTop - firstTop) < 2).length || 1;
  }

  return function handleStickerKey(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    const { key } = event;
    if (key === "ArrowLeft" || key === "ArrowUp" || key === "ArrowRight" || key === "ArrowDown") {
      if (!items.length) return false;
      event.preventDefault();
      const current = stickerView.selected
        ? items.findIndex((it) => it.asset_id === stickerView.selected.id)
        : -1;
      const dir = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;
      const last = items.length - 1;
      let next;
      if (lightboxOpen) {
        next = current < 0 ? (dir === 1 ? 0 : last) : (current + dir + items.length) % items.length;
      } else if (key === "ArrowLeft" || key === "ArrowRight") {
        next = current < 0 ? (dir === 1 ? 0 : last) : Math.max(0, Math.min(last, current + dir));
      } else {
        next = current < 0 ? 0 : Math.max(0, Math.min(last, current + dir * gridColumns()));
      }
      selectIndex(next);
      return true;
    }
    // Esc closes the lightbox (here, so it does not fall through to the
    // gallery's keys).
    if (key === "Escape" && lightboxOpen) {
      event.preventDefault();
      setLightboxOpen(false);
      return true;
    }
    return false;
  };
}
