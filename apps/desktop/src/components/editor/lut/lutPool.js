// Grading pixels with a library LUT, off the main thread (docs/lut-plan.md §3).
//
// Up to four workers. The preview is graded by the first; thumbnails go to
// the worker a LUT's id hashes to, so each LUT is parsed by one worker and
// the panel fills in parallel; a full-resolution save is cut into bands of
// rows, one per worker, so a 100 MP photo is not a multi-second freeze. A
// LUT's text comes from the main process (api.readLut) and is parsed where
// it is used. Where workers can't start, the same kernel runs here, on the
// main thread.
//
// Everything cached here is bounded: a library can hold thousands of LUTs
// of up to 7 MB of text each, and the panel touches every one it shows.

import api from "../../../api";
import { parseCube, CubeError } from "../../../../shared/cubeLut.mjs";
import { applyLut, prepareLut } from "./lutKernel";

const MAX_WORKERS = 4;
const TEXTS_MAX = 6; // LUT texts on their way to workers
const LOADED_MAX = 64; // per worker: what it was sent (its own cache keeps 8)
const INLINE_MAX = 8; // parsed LUTs, main-thread fallback

function lruGet(map, key) {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
}

function lruSet(map, key, value, max) {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value);
}

// A failure the UI can name: `code` is a cubeLut.mjs code, or one of
// "missing" / "unreadable" / "failed".
export class LutError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

const texts = new Map(); // id → Promise<string>, most recently used last
function lutText(id) {
  let p = lruGet(texts, id);
  if (!p) {
    p = api.readLut(id).then((res) => {
      if (typeof res?.text === "string") return res.text;
      throw new LutError(res?.error || "unreadable");
    });
    p.catch(() => texts.delete(id)); // a LUT fixed on disk can be tried again
    lruSet(texts, id, p, TEXTS_MAX);
  }
  return p;
}

// Forget what is known about a LUT (it was deleted, or replaced on disk).
export function forgetLut(id) {
  texts.delete(id);
  inline.delete(id);
  for (const slot of slots || []) slot.loaded.delete(id);
}

// ── workers ─────────────────────────────────────────────────────────────

let slots = null; // [{ worker, loaded: Map<id, Promise>, pending: Map<reqId, {resolve, reject}> }]
let workersBroken = false;
let nextReq = 1;

function spawn() {
  const worker = new Worker(new URL("./lutWorker.js", import.meta.url), { type: "module" });
  const slot = { worker, loaded: new Map(), pending: new Map() };
  worker.onmessage = (event) => {
    const msg = event.data;
    const waiter = slot.pending.get(msg.reqId);
    if (!waiter) return;
    slot.pending.delete(msg.reqId);
    if (msg.ok) waiter.resolve(msg);
    else waiter.reject(Object.assign(new LutError(msg.error, msg.detail), { buffer: msg.buffer }));
  };
  worker.onerror = (event) => {
    // A worker that can't even load (a file:// origin that refuses it):
    // every caller falls back to the main thread from now on.
    event.preventDefault?.();
    workersBroken = true;
    for (const waiter of slot.pending.values()) waiter.reject(new LutError("worker_failed"));
    slot.pending.clear();
  };
  return slot;
}

function workerSlots(count) {
  if (workersBroken || typeof Worker === "undefined") return null;
  try {
    if (!slots) slots = [spawn()];
    const want = Math.min(count, MAX_WORKERS);
    while (slots.length < want) slots.push(spawn());
    return slots.slice(0, want);
  } catch {
    workersBroken = true;
    return null;
  }
}

function send(slot, message, transfer = []) {
  const reqId = nextReq++;
  return new Promise((resolve, reject) => {
    slot.pending.set(reqId, { resolve, reject });
    slot.worker.postMessage({ ...message, reqId }, transfer);
  });
}

function ensureLoaded(slot, id) {
  let p = lruGet(slot.loaded, id);
  if (!p) {
    p = lutText(id).then((text) => send(slot, { type: "load", id, text }));
    p.catch(() => slot.loaded.delete(id));
    lruSet(slot.loaded, id, p, LOADED_MAX);
  }
  return p;
}

async function applyInWorker(slot, id, pixels, strength) {
  await ensureLoaded(slot, id);
  const buffer = pixels.buffer.byteLength === pixels.byteLength ? pixels.buffer : pixels.slice().buffer;
  try {
    const res = await send(slot, { type: "apply", id, buffer, strength }, [buffer]);
    return new Uint8ClampedArray(res.buffer);
  } catch (error) {
    if (error.code === "not_loaded") {
      // The worker's cache let it go: load again and retry once.
      slot.loaded.delete(id);
      await ensureLoaded(slot, id);
      const res = await send(slot, { type: "apply", id, buffer: error.buffer, strength }, [error.buffer]);
      return new Uint8ClampedArray(res.buffer);
    }
    throw error;
  }
}

// ── main-thread fallback ────────────────────────────────────────────────

const inline = new Map(); // id → Promise<prepared LUT>
function inlineLut(id) {
  let p = lruGet(inline, id);
  if (!p) {
    p = lutText(id).then((text) => {
      try {
        return prepareLut(parseCube(text));
      } catch (error) {
        throw error instanceof CubeError ? new LutError(error.code, error.detail) : error;
      }
    });
    p.catch(() => inline.delete(id));
    lruSet(inline, id, p, INLINE_MAX);
  }
  return p;
}

function hashId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// ── API ─────────────────────────────────────────────────────────────────

/**
 * Grades RGBA pixels with LUT `id` and resolves to the graded copy (the
 * array passed in may be detached: its buffer travels to a worker). For
 * small images: the thumbnails, spread over the workers by LUT.
 */
export async function gradePixels(id, pixels, strength = 1) {
  const pool = workerSlots(fullSizeParallelism());
  if (pool) {
    try {
      return await applyInWorker(pool[hashId(id) % pool.length], id, pixels, strength);
    } catch (error) {
      if (error.code !== "worker_failed") throw error;
    }
  }
  return applyLut(pixels, await inlineLut(id), strength);
}

// Can thumbnails be made side by side (one per worker)?
export function thumbnailConcurrency() {
  return workersBroken || typeof Worker === "undefined" ? 1 : fullSizeParallelism();
}

// A failure that says something about the LUT itself (unreadable, malformed)
// rather than about this attempt.
export function isLutFault(error) {
  return error instanceof LutError && error.code !== "worker_failed" && error.code !== "not_loaded" && error.code !== "failed";
}

// Checks that LUT `id` can be read and parsed; resolves, or rejects with a
// LutError naming why not.
export async function loadLut(id) {
  const pool = workerSlots(1);
  if (!pool) {
    await inlineLut(id);
    return;
  }
  await ensureLoaded(pool[0], id);
}

/**
 * A graded copy of `source` (a canvas or anything drawable with width/height)
 * as a new canvas of the same size. Works band by band — one band of rows per
 * worker, read and written back in place — so a 100 MP photo holds the canvas
 * plus one copy of it, not three.
 */
export async function gradeCanvas(source, id, strength = 1, { parallel = 1 } = {}) {
  const width = source.width;
  const height = source.height;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const pool = workerSlots(parallel);
  if (pool) {
    const per = Math.ceil(height / pool.length);
    try {
      await Promise.all(pool.map(async (slot, i) => {
        const y = i * per;
        const rows = Math.min(per, height - y);
        if (rows <= 0) return;
        const band = ctx.getImageData(0, y, width, rows);
        const graded = await applyInWorker(slot, id, band.data, strength);
        ctx.putImageData(new ImageData(graded, width, rows), 0, y);
      }));
      return canvas;
    } catch (error) {
      if (error.code !== "worker_failed") throw error;
      // Some bands may be graded already: start over from the source.
      ctx.drawImage(source, 0, 0);
    }
  }
  const lut = await inlineLut(id);
  const BAND = 512;
  for (let y = 0; y < height; y += BAND) {
    const rows = Math.min(BAND, height - y);
    const band = ctx.getImageData(0, y, width, rows);
    applyLut(band.data, lut, strength);
    ctx.putImageData(band, 0, y);
  }
  return canvas;
}

// The editor closed: stop the workers and drop every cache (their parsed
// tables are megabytes each). The next use starts them again.
export function releaseLutWorkers() {
  for (const slot of slots || []) {
    for (const waiter of slot.pending.values()) waiter.reject(new LutError("worker_failed"));
    slot.worker.terminate();
  }
  slots = null;
  texts.clear();
  inline.clear();
}

// For the e2e backdoor: whether the work really runs in workers.
export function lutPoolInfo() {
  return { workers: slots?.length || 0, broken: workersBroken };
}

export function fullSizeParallelism() {
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
  return Math.max(1, Math.min(MAX_WORKERS, cores - 1));
}
