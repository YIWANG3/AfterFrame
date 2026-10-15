// The free-angle ruler under the crop stage: a strip of degree ticks the
// user drags sideways to turn the photo by tenths of a degree; a double
// click puts it back to 0.

import { useEffect, useRef } from "react";
import { clamp } from "../../../utils/math";
import { MIN_FREE_ANGLE, MAX_FREE_ANGLE } from "../cropMath";

const RULER_W = 600;
const TICK_RANGE = 45;
const PX_PER_DEG = RULER_W / (TICK_RANGE * 2);

export default function AngleRuler({ value, viewportWidth, viewportHeight, centerX, onChangeStart, onChange, onChangeEnd }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;

    function angleFromX(clientX) {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      return clamp(Math.round(((clientX - cx) / PX_PER_DEG) * 10) / 10, MIN_FREE_ANGLE, MAX_FREE_ANGLE);
    }

    function onPointerDown(e) {
      e.preventDefault();
      e.stopPropagation();
      draggingRef.current = true;
      el.setPointerCapture(e.pointerId);
      onChangeStart?.();
      onChange(angleFromX(e.clientX));
    }

    function onPointerMove(e) {
      if (!draggingRef.current) return;
      onChange(angleFromX(e.clientX));
    }

    function onPointerUp(e) {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      onChangeEnd?.();
    }

    function onDblClick(e) {
      e.preventDefault();
      e.stopPropagation();
      onChangeStart?.();
      onChange(0);
      onChangeEnd?.();
    }

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("dblclick", onDblClick);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("dblclick", onDblClick);
    };
  }, [onChangeStart, onChange, onChangeEnd]);

  const vw = viewportWidth || 0;
  const top = viewportHeight - 88;
  const left = centerX !== undefined ? centerX - RULER_W / 2 : (vw - RULER_W) / 2;

  const ticks = [];
  for (let deg = -TICK_RANGE; deg <= TICK_RANGE; deg++) {
    const isMajor = deg % 10 === 0;
    const isMid = deg % 5 === 0 && !isMajor;
    const h = isMajor ? 16 : isMid ? 11 : 6;
    const opacity = isMajor ? 0.6 : isMid ? 0.4 : 0.2;
    ticks.push(
      <div
        key={deg}
        style={{
          position: "absolute",
          left: `${RULER_W / 2 + deg * PX_PER_DEG}px`,
          top: 0,
          width: "1px",
          height: `${h}px`,
          background: "rgb(var(--text-color))",
          opacity,
          transform: "translateX(-0.5px)",
        }}
      />,
    );
    if (isMajor) {
      ticks.push(
        <div
          key={`l${deg}`}
          style={{
            position: "absolute",
            left: `${RULER_W / 2 + deg * PX_PER_DEG}px`,
            top: `${h + 6}px`,
            transform: "translateX(-50%)",
            fontSize: "10px",
            color: "rgb(var(--text-color))",
            opacity: deg === 0 ? 0.6 : 0.3,
            whiteSpace: "nowrap",
          }}
        >
          {deg}°
        </div>,
      );
    }
  }

  const indicatorX = RULER_W / 2 + value * PX_PER_DEG;

  return (
    <div
      className="pointer-events-auto absolute select-none"
      style={{ left: `${left}px`, top: `${top}px`, width: `${RULER_W}px`, zIndex: 60 }}
    >
      <div
        ref={trackRef}
        data-testid="angle-ruler"
        style={{
          position: "relative",
          width: `${RULER_W}px`,
          height: "32px",
          cursor: "ew-resize",
          touchAction: "none",
        }}
      >
        {ticks}
        <div
          style={{
            position: "absolute",
            left: `${indicatorX}px`,
            top: 0,
            width: "2px",
            height: "14px",
            background: "rgb(var(--accent-color))",
            borderRadius: "1px",
            transform: "translateX(-1px)",
            opacity: 0.9,
          }}
        />
      </div>
      <div className="mt-0.5 text-center text-[11px] font-medium tabular-nums text-muted">
        {value.toFixed(1)}°
      </div>
    </div>
  );
}
