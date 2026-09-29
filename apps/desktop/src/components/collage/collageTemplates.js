/**
 * Each template defines normalized cell rects (0–1).
 * Gap is applied by the renderer, not baked into the template.
 * Cells are rectangles that tile the whole canvas; the layout engine
 * (collageRender.computeCellRects) has no notion of overlap or empty space.
 */

const third = 1 / 3;
// A cols × rows grid filling the rectangle (x0, y0, w, h) of the canvas.
const grid = (cols, rows, x0 = 0, y0 = 0, w = 1, h = 1) => {
  const out = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push({ x: x0 + (c * w) / cols, y: y0 + (r * h) / rows, w: w / cols, h: h / rows });
  }
  return out;
};
// n across the top, one wide strip in the middle, n across the bottom.
const sandwich = (n) => [...grid(n, 1, 0, 0, 1, 0.3), { x: 0, y: 0.3, w: 1, h: 0.4 }, ...grid(n, 1, 0, 0.7, 1, 0.3)];
// One big cell in the middle column, n stacked on each side.
const centre = (n) => [...grid(1, n, 0, 0, 0.25, 1), { x: 0.25, y: 0, w: 0.5, h: 1 }, ...grid(1, n, 0.75, 0, 0.25, 1)];

const TEMPLATES = {
  // Single-image "collage": used by batch mode when a remainder group has 1 image.
  1: [
    { id: "1-full", name: "Full", cells: [{x:0,y:0,w:1,h:1}] },
  ],
  2: [
    { id: "2-lr", name: "Left / Right", cells: [{x:0,y:0,w:.5,h:1},{x:.5,y:0,w:.5,h:1}] },
    { id: "2-tb", name: "Top / Bottom", cells: [{x:0,y:0,w:1,h:.5},{x:0,y:.5,w:1,h:.5}] },
    { id: "2-big-left", name: "Big Left", cells: [{x:0,y:0,w:.65,h:1},{x:.65,y:0,w:.35,h:1}] },
    { id: "2-big-right", name: "Big Right", cells: [{x:0,y:0,w:.35,h:1},{x:.35,y:0,w:.65,h:1}] },
    { id: "2-big-top", name: "Big Top", cells: [{x:0,y:0,w:1,h:.65},{x:0,y:.65,w:1,h:.35}] },
    { id: "2-big-bottom", name: "Big Bottom", cells: [{x:0,y:0,w:1,h:.35},{x:0,y:.35,w:1,h:.65}] },
  ],
  3: [
    { id: "3-cols", name: "3 Columns", cells: [{x:0,y:0,w:1/3,h:1},{x:1/3,y:0,w:1/3,h:1},{x:2/3,y:0,w:1/3,h:1}] },
    { id: "3-rows", name: "3 Rows", cells: [{x:0,y:0,w:1,h:1/3},{x:0,y:1/3,w:1,h:1/3},{x:0,y:2/3,w:1,h:1/3}] },
    { id: "3-left-2r", name: "1 Left + 2 Right", cells: [{x:0,y:0,w:.5,h:1},{x:.5,y:0,w:.5,h:.5},{x:.5,y:.5,w:.5,h:.5}] },
    { id: "3-right-2l", name: "2 Left + 1 Right", cells: [{x:0,y:0,w:.5,h:.5},{x:0,y:.5,w:.5,h:.5},{x:.5,y:0,w:.5,h:1}] },
    { id: "3-top-2b", name: "1 Top + 2 Bottom", cells: [{x:0,y:0,w:1,h:.5},{x:0,y:.5,w:.5,h:.5},{x:.5,y:.5,w:.5,h:.5}] },
    { id: "3-bot-2t", name: "2 Top + 1 Bottom", cells: [{x:0,y:0,w:.5,h:.5},{x:.5,y:0,w:.5,h:.5},{x:0,y:.5,w:1,h:.5}] },
    { id: "3-big-2small", name: "Big + 2 Small", cells: [{x:0,y:0,w:.6,h:1},{x:.6,y:0,w:.4,h:.5},{x:.6,y:.5,w:.4,h:.5}] },
    { id: "3-2small-big", name: "2 Small + Big", cells: [{x:0,y:0,w:.4,h:.5},{x:0,y:.5,w:.4,h:.5},{x:.4,y:0,w:.6,h:1}] },
    { id: "3-center-big", name: "Center + 2 Sides", cells: centre(1) },
    { id: "3-t1-m1-b1", name: "1 + Wide + 1", cells: sandwich(1) },
  ],
  4: [
    { id: "4-grid", name: "2x2 Grid", cells: [{x:0,y:0,w:.5,h:.5},{x:.5,y:0,w:.5,h:.5},{x:0,y:.5,w:.5,h:.5},{x:.5,y:.5,w:.5,h:.5}] },
    { id: "4-cols", name: "4 Columns", cells: [{x:0,y:0,w:.25,h:1},{x:.25,y:0,w:.25,h:1},{x:.5,y:0,w:.25,h:1},{x:.75,y:0,w:.25,h:1}] },
    { id: "4-rows", name: "4 Rows", cells: [{x:0,y:0,w:1,h:.25},{x:0,y:.25,w:1,h:.25},{x:0,y:.5,w:1,h:.25},{x:0,y:.75,w:1,h:.25}] },
    { id: "4-big-3r", name: "1 Big + 3 Right", cells: [{x:0,y:0,w:.6,h:1},{x:.6,y:0,w:.4,h:1/3},{x:.6,y:1/3,w:.4,h:1/3},{x:.6,y:2/3,w:.4,h:1/3}] },
    { id: "4-3l-big", name: "3 Left + 1 Big", cells: [{x:0,y:0,w:.4,h:1/3},{x:0,y:1/3,w:.4,h:1/3},{x:0,y:2/3,w:.4,h:1/3},{x:.4,y:0,w:.6,h:1}] },
    { id: "4-big-3b", name: "1 Big + 3 Bottom", cells: [{x:0,y:0,w:1,h:.6},{x:0,y:.6,w:1/3,h:.4},{x:1/3,y:.6,w:1/3,h:.4},{x:2/3,y:.6,w:1/3,h:.4}] },
    { id: "4-3t-big", name: "3 Top + 1 Big", cells: [{x:0,y:0,w:1/3,h:.4},{x:1/3,y:0,w:1/3,h:.4},{x:2/3,y:0,w:1/3,h:.4},{x:0,y:.4,w:1,h:.6}] },
    { id: "4-t1-b3", name: "1 Top + 3 Bottom", cells: [{x:0,y:0,w:1,h:.5},{x:0,y:.5,w:1/3,h:.5},{x:1/3,y:.5,w:1/3,h:.5},{x:2/3,y:.5,w:1/3,h:.5}] },
    { id: "4-cross", name: "Cross", cells: [{x:0,y:0,w:.6,h:.5},{x:.6,y:0,w:.4,h:.5},{x:0,y:.5,w:.4,h:.5},{x:.4,y:.5,w:.6,h:.5}] },
    { id: "4-big-L", name: "Big + L", cells: [{x:0,y:0,w:2*third,h:2*third},{x:2*third,y:0,w:third,h:2*third},{x:0,y:2*third,w:2*third,h:third},{x:2*third,y:2*third,w:third,h:third}] },
  ],
  5: [
    { id: "5-t2-b3", name: "2 Top + 3 Bottom", cells: [{x:0,y:0,w:.5,h:.5},{x:.5,y:0,w:.5,h:.5},{x:0,y:.5,w:1/3,h:.5},{x:1/3,y:.5,w:1/3,h:.5},{x:2/3,y:.5,w:1/3,h:.5}] },
    { id: "5-t3-b2", name: "3 Top + 2 Bottom", cells: [{x:0,y:0,w:1/3,h:.5},{x:1/3,y:0,w:1/3,h:.5},{x:2/3,y:0,w:1/3,h:.5},{x:0,y:.5,w:.5,h:.5},{x:.5,y:.5,w:.5,h:.5}] },
    { id: "5-big-4r", name: "1 Big + 4 Right", cells: [{x:0,y:0,w:.6,h:1},{x:.6,y:0,w:.4,h:.25},{x:.6,y:.25,w:.4,h:.25},{x:.6,y:.5,w:.4,h:.25},{x:.6,y:.75,w:.4,h:.25}] },
    { id: "5-4l-big", name: "4 Left + 1 Big", cells: [{x:0,y:0,w:.4,h:.25},{x:0,y:.25,w:.4,h:.25},{x:0,y:.5,w:.4,h:.25},{x:0,y:.75,w:.4,h:.25},{x:.4,y:0,w:.6,h:1}] },
    { id: "5-cols", name: "5 Columns", cells: [{x:0,y:0,w:.2,h:1},{x:.2,y:0,w:.2,h:1},{x:.4,y:0,w:.2,h:1},{x:.6,y:0,w:.2,h:1},{x:.8,y:0,w:.2,h:1}] },
    { id: "5-big-t2-b2", name: "Big Left + 2+2", cells: [{x:0,y:0,w:.5,h:1},{x:.5,y:0,w:.25,h:.5},{x:.75,y:0,w:.25,h:.5},{x:.5,y:.5,w:.25,h:.5},{x:.75,y:.5,w:.25,h:.5}] },
    { id: "5-l2-r3", name: "2 Left + 3 Right", cells: [{x:0,y:0,w:.5,h:.5},{x:0,y:.5,w:.5,h:.5},{x:.5,y:0,w:.5,h:1/3},{x:.5,y:1/3,w:.5,h:1/3},{x:.5,y:2/3,w:.5,h:1/3}] },
    { id: "5-big-top-4b", name: "1 Big Top + 4 Bottom", cells: [{x:0,y:0,w:1,h:.55},{x:0,y:.55,w:.25,h:.45},{x:.25,y:.55,w:.25,h:.45},{x:.5,y:.55,w:.25,h:.45},{x:.75,y:.55,w:.25,h:.45}] },
    { id: "5-t2-m1-b2", name: "2 + Wide + 2", cells: sandwich(2) },
    { id: "5-center-big", name: "Center + 2+2 Sides", cells: centre(2) },
  ],
  6: [
    { id: "6-2x3", name: "2x3 Grid", cells: [{x:0,y:0,w:1/3,h:.5},{x:1/3,y:0,w:1/3,h:.5},{x:2/3,y:0,w:1/3,h:.5},{x:0,y:.5,w:1/3,h:.5},{x:1/3,y:.5,w:1/3,h:.5},{x:2/3,y:.5,w:1/3,h:.5}] },
    { id: "6-3x2", name: "3x2 Grid", cells: [{x:0,y:0,w:.5,h:1/3},{x:.5,y:0,w:.5,h:1/3},{x:0,y:1/3,w:.5,h:1/3},{x:.5,y:1/3,w:.5,h:1/3},{x:0,y:2/3,w:.5,h:1/3},{x:.5,y:2/3,w:.5,h:1/3}] },
    { id: "6-cols", name: "6 Columns", cells: [{x:0,y:0,w:1/6,h:1},{x:1/6,y:0,w:1/6,h:1},{x:2/6,y:0,w:1/6,h:1},{x:3/6,y:0,w:1/6,h:1},{x:4/6,y:0,w:1/6,h:1},{x:5/6,y:0,w:1/6,h:1}] },
    { id: "6-rows", name: "6 Rows", cells: [{x:0,y:0,w:1,h:1/6},{x:0,y:1/6,w:1,h:1/6},{x:0,y:2/6,w:1,h:1/6},{x:0,y:3/6,w:1,h:1/6},{x:0,y:4/6,w:1,h:1/6},{x:0,y:5/6,w:1,h:1/6}] },
    { id: "6-big-5r", name: "1 Big + 5 Right", cells: [{x:0,y:0,w:.6,h:1},{x:.6,y:0,w:.4,h:.2},{x:.6,y:.2,w:.4,h:.2},{x:.6,y:.4,w:.4,h:.2},{x:.6,y:.6,w:.4,h:.2},{x:.6,y:.8,w:.4,h:.2}] },
    { id: "6-t1-b5", name: "1 Top + 5 Bottom", cells: [{x:0,y:0,w:1,h:.5},{x:0,y:.5,w:.2,h:.5},{x:.2,y:.5,w:.2,h:.5},{x:.4,y:.5,w:.2,h:.5},{x:.6,y:.5,w:.2,h:.5},{x:.8,y:.5,w:.2,h:.5}] },
    { id: "6-2big-4small", name: "2 Big + 4 Small", cells: [{x:0,y:0,w:.5,h:.6},{x:.5,y:0,w:.5,h:.6},{x:0,y:.6,w:.25,h:.4},{x:.25,y:.6,w:.25,h:.4},{x:.5,y:.6,w:.25,h:.4},{x:.75,y:.6,w:.25,h:.4}] },
    { id: "6-big-5", name: "Big + 5", cells: [{x:0,y:0,w:2*third,h:2*third},{x:2*third,y:0,w:third,h:third},{x:2*third,y:third,w:third,h:third},...grid(3,1,0,2*third,1,third)] },
    { id: "6-t1-m4-b1", name: "Wide + 2x2 + Wide", cells: [{x:0,y:0,w:1,h:.25},...grid(2,2,0,.25,1,.5),{x:0,y:.75,w:1,h:.25}] },
  ],
  7: [
    { id: "7-t3-b4", name: "3 Top + 4 Bottom", cells: [{x:0,y:0,w:1/3,h:.5},{x:1/3,y:0,w:1/3,h:.5},{x:2/3,y:0,w:1/3,h:.5},{x:0,y:.5,w:.25,h:.5},{x:.25,y:.5,w:.25,h:.5},{x:.5,y:.5,w:.25,h:.5},{x:.75,y:.5,w:.25,h:.5}] },
    { id: "7-t4-b3", name: "4 Top + 3 Bottom", cells: [{x:0,y:0,w:.25,h:.5},{x:.25,y:0,w:.25,h:.5},{x:.5,y:0,w:.25,h:.5},{x:.75,y:0,w:.25,h:.5},{x:0,y:.5,w:1/3,h:.5},{x:1/3,y:.5,w:1/3,h:.5},{x:2/3,y:.5,w:1/3,h:.5}] },
    { id: "7-l3-r4", name: "3 Left + 4 Right", cells: [{x:0,y:0,w:.5,h:1/3},{x:0,y:1/3,w:.5,h:1/3},{x:0,y:2/3,w:.5,h:1/3},{x:.5,y:0,w:.5,h:.25},{x:.5,y:.25,w:.5,h:.25},{x:.5,y:.5,w:.5,h:.25},{x:.5,y:.75,w:.5,h:.25}] },
    { id: "7-t2-m3-b2", name: "2+3+2", cells: [{x:0,y:0,w:.5,h:1/3},{x:.5,y:0,w:.5,h:1/3},{x:0,y:1/3,w:1/3,h:1/3},{x:1/3,y:1/3,w:1/3,h:1/3},{x:2/3,y:1/3,w:1/3,h:1/3},{x:0,y:2/3,w:.5,h:1/3},{x:.5,y:2/3,w:.5,h:1/3}] },
    { id: "7-t3-m1-b3", name: "3 + Wide + 3", cells: sandwich(3) },
    { id: "7-center-big", name: "Center + 3+3 Sides", cells: centre(3) },
    { id: "7-big-top-6", name: "Big Top + 6", cells: [{x:0,y:0,w:1,h:.5},...grid(3,2,0,.5,1,.5)] },
    { id: "7-big-left-6", name: "Big Left + 6", cells: [{x:0,y:0,w:.5,h:1},...grid(2,3,.5,0,.5,1)] },
  ],
  8: [
    { id: "8-2x4", name: "2x4 Grid", cells: [{x:0,y:0,w:.25,h:.5},{x:.25,y:0,w:.25,h:.5},{x:.5,y:0,w:.25,h:.5},{x:.75,y:0,w:.25,h:.5},{x:0,y:.5,w:.25,h:.5},{x:.25,y:.5,w:.25,h:.5},{x:.5,y:.5,w:.25,h:.5},{x:.75,y:.5,w:.25,h:.5}] },
    { id: "8-4x2", name: "4x2 Grid", cells: [{x:0,y:0,w:.5,h:.25},{x:.5,y:0,w:.5,h:.25},{x:0,y:.25,w:.5,h:.25},{x:.5,y:.25,w:.5,h:.25},{x:0,y:.5,w:.5,h:.25},{x:.5,y:.5,w:.5,h:.25},{x:0,y:.75,w:.5,h:.25},{x:.5,y:.75,w:.5,h:.25}] },
    { id: "8-t3-m2-b3", name: "3+2+3", cells: [{x:0,y:0,w:1/3,h:1/3},{x:1/3,y:0,w:1/3,h:1/3},{x:2/3,y:0,w:1/3,h:1/3},{x:0,y:1/3,w:.5,h:1/3},{x:.5,y:1/3,w:.5,h:1/3},{x:0,y:2/3,w:1/3,h:1/3},{x:1/3,y:2/3,w:1/3,h:1/3},{x:2/3,y:2/3,w:1/3,h:1/3}] },
    { id: "8-big-7", name: "Big + 7", cells: [{x:0,y:0,w:.75,h:.75},...grid(1,3,.75,0,.25,.75),...grid(4,1,0,.75,1,.25)] },
    { id: "8-2big-6small", name: "2 Big + 6 Small", cells: [...grid(2,1,0,0,1,.6),...grid(3,2,0,.6,1,.4)] },
  ],
  9: [
    { id: "9-3x3", name: "3x3 Grid", cells: [{x:0,y:0,w:1/3,h:1/3},{x:1/3,y:0,w:1/3,h:1/3},{x:2/3,y:0,w:1/3,h:1/3},{x:0,y:1/3,w:1/3,h:1/3},{x:1/3,y:1/3,w:1/3,h:1/3},{x:2/3,y:1/3,w:1/3,h:1/3},{x:0,y:2/3,w:1/3,h:1/3},{x:1/3,y:2/3,w:1/3,h:1/3},{x:2/3,y:2/3,w:1/3,h:1/3}] },
    { id: "9-t4-m1-b4", name: "4+1+4", cells: [{x:0,y:0,w:.25,h:1/3},{x:.25,y:0,w:.25,h:1/3},{x:.5,y:0,w:.25,h:1/3},{x:.75,y:0,w:.25,h:1/3},{x:0,y:1/3,w:1,h:1/3},{x:0,y:2/3,w:.25,h:1/3},{x:.25,y:2/3,w:.25,h:1/3},{x:.5,y:2/3,w:.25,h:1/3},{x:.75,y:2/3,w:.25,h:1/3}] },
    { id: "9-big-8", name: "Big + 8", cells: [{x:0,y:0,w:.5,h:2*third},...grid(2,2,.5,0,.5,2*third),...grid(4,1,0,2*third,1,third)] },
    { id: "9-big-top-8", name: "Big Top + 8", cells: [{x:0,y:0,w:1,h:.5},...grid(4,2,0,.5,1,.5)] },
  ],
  10: [
    { id: "10-2x5", name: "2x5 Grid", cells: [{x:0,y:0,w:.2,h:.5},{x:.2,y:0,w:.2,h:.5},{x:.4,y:0,w:.2,h:.5},{x:.6,y:0,w:.2,h:.5},{x:.8,y:0,w:.2,h:.5},{x:0,y:.5,w:.2,h:.5},{x:.2,y:.5,w:.2,h:.5},{x:.4,y:.5,w:.2,h:.5},{x:.6,y:.5,w:.2,h:.5},{x:.8,y:.5,w:.2,h:.5}] },
    { id: "10-5x2", name: "5x2 Grid", cells: [{x:0,y:0,w:.5,h:.2},{x:.5,y:0,w:.5,h:.2},{x:0,y:.2,w:.5,h:.2},{x:.5,y:.2,w:.5,h:.2},{x:0,y:.4,w:.5,h:.2},{x:.5,y:.4,w:.5,h:.2},{x:0,y:.6,w:.5,h:.2},{x:.5,y:.6,w:.5,h:.2},{x:0,y:.8,w:.5,h:.2},{x:.5,y:.8,w:.5,h:.2}] },
    { id: "10-t3-m4-b3", name: "3+4+3", cells: [{x:0,y:0,w:1/3,h:1/3},{x:1/3,y:0,w:1/3,h:1/3},{x:2/3,y:0,w:1/3,h:1/3},{x:0,y:1/3,w:.25,h:1/3},{x:.25,y:1/3,w:.25,h:1/3},{x:.5,y:1/3,w:.25,h:1/3},{x:.75,y:1/3,w:.25,h:1/3},{x:0,y:2/3,w:1/3,h:1/3},{x:1/3,y:2/3,w:1/3,h:1/3},{x:2/3,y:2/3,w:1/3,h:1/3}] },
    { id: "10-big-left-9", name: "Big Left + 9", cells: [{x:0,y:0,w:.4,h:1},...grid(3,3,.4,0,.6,1)] },
    { id: "10-big-top-9", name: "Big Top + 9", cells: [{x:0,y:0,w:1,h:.4},...grid(3,3,0,.4,1,.6)] },
  ],
  11: [
    { id: "11-t4-m3-b4", name: "4+3+4", cells: [{x:0,y:0,w:.25,h:1/3},{x:.25,y:0,w:.25,h:1/3},{x:.5,y:0,w:.25,h:1/3},{x:.75,y:0,w:.25,h:1/3},{x:0,y:1/3,w:1/3,h:1/3},{x:1/3,y:1/3,w:1/3,h:1/3},{x:2/3,y:1/3,w:1/3,h:1/3},{x:0,y:2/3,w:.25,h:1/3},{x:.25,y:2/3,w:.25,h:1/3},{x:.5,y:2/3,w:.25,h:1/3},{x:.75,y:2/3,w:.25,h:1/3}] },
    { id: "11-t3-m4-b4", name: "3+4+4", cells: [{x:0,y:0,w:1/3,h:1/3},{x:1/3,y:0,w:1/3,h:1/3},{x:2/3,y:0,w:1/3,h:1/3},{x:0,y:1/3,w:.25,h:1/3},{x:.25,y:1/3,w:.25,h:1/3},{x:.5,y:1/3,w:.25,h:1/3},{x:.75,y:1/3,w:.25,h:1/3},{x:0,y:2/3,w:.25,h:1/3},{x:.25,y:2/3,w:.25,h:1/3},{x:.5,y:2/3,w:.25,h:1/3},{x:.75,y:2/3,w:.25,h:1/3}] },
    { id: "11-t4-m4-b3", name: "4+4+3", cells: [{x:0,y:0,w:.25,h:1/3},{x:.25,y:0,w:.25,h:1/3},{x:.5,y:0,w:.25,h:1/3},{x:.75,y:0,w:.25,h:1/3},{x:0,y:1/3,w:.25,h:1/3},{x:.25,y:1/3,w:.25,h:1/3},{x:.5,y:1/3,w:.25,h:1/3},{x:.75,y:1/3,w:.25,h:1/3},{x:0,y:2/3,w:1/3,h:1/3},{x:1/3,y:2/3,w:1/3,h:1/3},{x:2/3,y:2/3,w:1/3,h:1/3}] },
    { id: "11-t5-m1-b5", name: "5 + Wide + 5", cells: sandwich(5) },
    { id: "11-2big-9", name: "2 Big + 9", cells: [...grid(2,1,0,0,1,.4),...grid(3,3,0,.4,1,.6)] },
  ],
  12: [
    { id: "12-3x4", name: "3x4 Grid", cells: [{x:0,y:0,w:.25,h:1/3},{x:.25,y:0,w:.25,h:1/3},{x:.5,y:0,w:.25,h:1/3},{x:.75,y:0,w:.25,h:1/3},{x:0,y:1/3,w:.25,h:1/3},{x:.25,y:1/3,w:.25,h:1/3},{x:.5,y:1/3,w:.25,h:1/3},{x:.75,y:1/3,w:.25,h:1/3},{x:0,y:2/3,w:.25,h:1/3},{x:.25,y:2/3,w:.25,h:1/3},{x:.5,y:2/3,w:.25,h:1/3},{x:.75,y:2/3,w:.25,h:1/3}] },
    { id: "12-4x3", name: "4x3 Grid", cells: [{x:0,y:0,w:1/3,h:.25},{x:1/3,y:0,w:1/3,h:.25},{x:2/3,y:0,w:1/3,h:.25},{x:0,y:.25,w:1/3,h:.25},{x:1/3,y:.25,w:1/3,h:.25},{x:2/3,y:.25,w:1/3,h:.25},{x:0,y:.5,w:1/3,h:.25},{x:1/3,y:.5,w:1/3,h:.25},{x:2/3,y:.5,w:1/3,h:.25},{x:0,y:.75,w:1/3,h:.25},{x:1/3,y:.75,w:1/3,h:.25},{x:2/3,y:.75,w:1/3,h:.25}] },
    { id: "12-2x6", name: "2x6 Grid", cells: [{x:0,y:0,w:1/6,h:.5},{x:1/6,y:0,w:1/6,h:.5},{x:2/6,y:0,w:1/6,h:.5},{x:3/6,y:0,w:1/6,h:.5},{x:4/6,y:0,w:1/6,h:.5},{x:5/6,y:0,w:1/6,h:.5},{x:0,y:.5,w:1/6,h:.5},{x:1/6,y:.5,w:1/6,h:.5},{x:2/6,y:.5,w:1/6,h:.5},{x:3/6,y:.5,w:1/6,h:.5},{x:4/6,y:.5,w:1/6,h:.5},{x:5/6,y:.5,w:1/6,h:.5}] },
    { id: "12-big-11", name: "Big + 11", cells: [{x:0,y:0,w:.4,h:2*third},...grid(3,2,.4,0,.6,2*third),...grid(5,1,0,2*third,1,third)] },
  ],
};

/**
 * Find the best matching template group for a given image count.
 * Returns exact match, or the closest smaller group (images overflow into last cell).
 */
export function getTemplatesForCount(count) {
  if (TEMPLATES[count]) return TEMPLATES[count];
  const keys = Object.keys(TEMPLATES).map(Number).sort((a, b) => a - b);
  for (let i = keys.length - 1; i >= 0; i--) {
    if (keys[i] <= count) return TEMPLATES[keys[i]];
  }
  return TEMPLATES[2];
}

export function getAllTemplateCounts() {
  return Object.keys(TEMPLATES).map(Number).sort((a, b) => a - b);
}

export default TEMPLATES;
