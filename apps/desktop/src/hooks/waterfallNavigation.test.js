import { describe, expect, it } from "vitest";
import { CAPTION_HEIGHT, buildWaterfallLayout } from "../components/galleryLayout";
import { waterfallTarget } from "./waterfallNavigation";

// Three columns of uneven heights:
//   a  b  c
//   a  e  c
//   d  e  f
//   d  e  f
//   g  h  i
const box = (assetId, left, top, height) => ({ assetId, left, top, width: 188, height });
const layout = [
  box("a", 0, 0, 300), box("b", 200, 0, 150), box("c", 400, 0, 250),
  box("e", 200, 162, 400), box("f", 400, 262, 250), box("d", 0, 312, 200),
  box("g", 0, 524, 300), box("i", 400, 524, 200), box("h", 200, 574, 100),
];
const go = (from, direction, lineY) => waterfallTarget(layout, from, direction, lineY)?.assetId ?? null;

describe("arrow keys in the waterfall layout", () => {
  it("Left and Right step to the photo nearest in height in the next column", () => {
    expect(go("b", "right")).toBe("c");
    expect(go("e", "left")).toBe("d");
    expect(go("d", "right")).toBe("e");
  });

  it("Right in the last column wraps to the photo below this line in the first column", () => {
    expect(go("c", "right")).toBe("d");
    // f is on d's line, so the next line starts at g
    expect(go("f", "right")).toBe("g");
  });

  it("Left in the first column wraps to the photo above this line in the last column", () => {
    expect(go("g", "left")).toBe("f");
    // d is on f's line, so the line before it ends at c
    expect(go("d", "left")).toBe("c");
  });

  it("stops at the first and the last line", () => {
    expect(go("a", "left")).toBeNull();
    expect(go("i", "right")).toBeNull();
  });

  it("a run of Left/Right keeps to the line it started on", () => {
    //   p  q  s
    //   p  r  s
    //   p  r  t
    //      r  t
    const steps = [box("p", 0, 0, 400), box("q", 200, 0, 100), box("r", 200, 112, 400), box("s", 400, 0, 200), box("t", 400, 212, 300)];
    const first = waterfallTarget(steps, "p", "right");
    expect(first).toEqual({ assetId: "r", lineY: 200 });
    // from r on p's line the nearest in the last column is s; a fresh line through r would pick t
    expect(waterfallTarget(steps, "r", "right", first.lineY).assetId).toBe("s");
    expect(waterfallTarget(steps, "r", "right").assetId).toBe("t");
  });

  it("a wrap moves the line to the photo it lands on", () => {
    expect(waterfallTarget(layout, "c", "right")).toEqual({ assetId: "d", lineY: 412 });
  });

  it("Up and Down walk the column, stop at its ends and drop the line", () => {
    expect(waterfallTarget(layout, "b", "down")).toEqual({ assetId: "e", lineY: null });
    expect(go("e", "down")).toBe("h");
    expect(go("h", "down")).toBeNull();
    expect(go("b", "up")).toBeNull();
  });

  it("in a single column Right and Left behave like Down and Up", () => {
    const single = [box("x", 0, 0, 100), box("y", 0, 112, 100)];
    expect(waterfallTarget(single, "x", "right").assetId).toBe("y");
    expect(waterfallTarget(single, "y", "left").assetId).toBe("x");
    expect(waterfallTarget(single, "y", "right")).toBeNull();
  });

  it("holding Right or Left on a real layout runs to the end without looping", () => {
    const sizes = [[3, 2], [2, 3], [1, 1], [4, 3], [3, 4], [16, 9], [2, 3], [3, 2], [1, 1], [9, 16], [3, 2], [2, 3], [4, 5], [5, 4], [3, 2], [2, 3], [1, 1], [3, 2], [2, 3], [16, 9]];
    const items = sizes.map(([width, height], i) => ({ asset_id: `p${i}`, image_metadata: { width, height } }));
    const { positions } = buildWaterfallLayout(items, 900, 200);
    const boxes = positions.map((p) => ({ assetId: p.item.asset_id, left: p.left, top: p.top, width: p.width, height: p.imgHeight + CAPTION_HEIGHT }));
    const columnLefts = [...new Set(boxes.map((b) => b.left))].sort((x, y) => x - y);

    // A tall photo can be on two lines and be passed twice; what must hold is
    // that the line only ever moves one way, so the run ends.
    const hold = (startId, direction) => {
      const visited = [startId];
      let lineY = null;
      for (let step = 0; step < boxes.length * 4; step += 1) {
        const move = waterfallTarget(boxes, visited.at(-1), direction, lineY);
        if (!move) return visited;
        if (lineY != null) {
          if (direction === "right") expect(move.lineY).toBeGreaterThanOrEqual(lineY);
          else expect(move.lineY).toBeLessThanOrEqual(lineY);
        }
        visited.push(move.assetId);
        lineY = move.lineY;
      }
      throw new Error("did not stop");
    };

    const right = hold(boxes[0].assetId, "right");
    const rightEnd = boxes.find((b) => b.assetId === right.at(-1));
    expect(rightEnd.left).toBe(columnLefts.at(-1));

    const lastInLastColumn = boxes.filter((b) => b.left === columnLefts.at(-1)).at(-1);
    const left = hold(lastInLastColumn.assetId, "left");
    const leftEnd = boxes.find((b) => b.assetId === left.at(-1));
    expect(leftEnd.left).toBe(columnLefts[0]);
  });

  it("returns null for a photo that is not in the layout", () => {
    expect(go("missing", "right")).toBeNull();
  });
});
