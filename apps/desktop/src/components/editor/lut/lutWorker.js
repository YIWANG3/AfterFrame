// LUT worker: parses .cube text once per LUT and grades pixel buffers off the
// main thread (lutPool.js sends the work). Parsed LUTs stay cached, the most
// recently used kept: a 65³ table is ~3 MB as floats.

import { parseCube, CubeError } from "../../../../shared/cubeLut.mjs";
import { applyLut, prepareLut } from "./lutKernel";

const CACHE_MAX = 8;
const cache = new Map(); // id → prepared LUT, in use order

function remember(id, lut) {
  cache.delete(id);
  cache.set(id, lut);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

self.onmessage = (event) => {
  const msg = event.data;
  try {
    if (msg.type === "load") {
      if (!cache.has(msg.id)) remember(msg.id, prepareLut(parseCube(msg.text)));
      self.postMessage({ reqId: msg.reqId, ok: true });
      return;
    }
    if (msg.type === "has") {
      self.postMessage({ reqId: msg.reqId, ok: true, has: cache.has(msg.id) });
      return;
    }
    if (msg.type === "apply") {
      const lut = cache.get(msg.id);
      if (!lut) {
        // Let go of to make room for others: say so, and hand the pixels
        // back so the caller can load it again and retry with them.
        self.postMessage({ reqId: msg.reqId, ok: false, error: "not_loaded", buffer: msg.buffer }, [msg.buffer]);
        return;
      }
      remember(msg.id, lut);
      const pixels = new Uint8ClampedArray(msg.buffer);
      applyLut(pixels, lut, msg.strength ?? 1);
      self.postMessage({ reqId: msg.reqId, ok: true, buffer: msg.buffer }, [msg.buffer]);
    }
  } catch (error) {
    self.postMessage({
      reqId: msg.reqId,
      ok: false,
      error: error instanceof CubeError ? error.code : "failed",
      detail: error instanceof CubeError ? error.detail : { message: String(error?.message || error) },
      // Hand the pixels back so the caller's buffer isn't lost with the error.
      ...(msg.buffer ? { buffer: msg.buffer } : {}),
    }, msg.buffer ? [msg.buffer] : []);
  }
};
