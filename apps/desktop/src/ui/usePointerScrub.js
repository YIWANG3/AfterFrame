// A surface the pointer scrubs across (a hue strip, a saturation square): the
// first press takes pointer capture on the element so the drag keeps
// reporting after the pointer leaves it, and every press or captured move
// reports the event to `onScrub`. Spread the result onto the element.

export default function usePointerScrub(ref, onScrub) {
  return {
    onPointerDown: (event) => {
      event.preventDefault();
      ref.current.setPointerCapture(event.pointerId);
      onScrub(event);
    },
    onPointerMove: (event) => {
      if (!ref.current.hasPointerCapture(event.pointerId)) return;
      onScrub(event);
    },
  };
}
