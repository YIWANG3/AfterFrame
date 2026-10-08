// .cube 3D LUT reader (docs/lut-plan.md §2). Shared by the main process
// (validating a LUT on import, reading the header for the library list) and
// the renderer's LUT worker (the table it applies).
//
// The rules come from what real files do (a census of 2576 .cube files) and
// from what other readers got wrong: a BOM, CR/CRLF line ends, tabs, comments
// anywhere, TITLE with or without quotes, unknown keywords (ignored),
// DOMAIN_MIN/MAX and LUT_3D_INPUT_RANGE (applied, not skipped), values
// outside 0..1 (kept: clamping nodes moves log-conversion LUTs by up to 17
// levels), and a row count that must be exactly N³. Rows are red-fastest.
// 1D LUTs and 1D+3D shaper files are refused for now.

export const LUT_MIN_SIZE = 2;
export const LUT_MAX_SIZE = 65;

// `code` is what callers branch on and the UI translates; `detail` carries
// the numbers for the message.
export class CubeError extends Error {
  constructor(code, detail = {}) {
    super(`${code}${detail.line ? ` (line ${detail.line})` : ""}`);
    this.code = code;
    this.detail = detail;
  }
}

const LINE_BREAK = /\r\n|\r|\n/;
const WHITESPACE = /\s+/;

function stripComment(line) {
  const hash = line.indexOf("#");
  return hash < 0 ? line : line.slice(0, hash);
}

function isKeywordLine(s) {
  const c = s.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
}

function finiteNumbers(tokens, count, line) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = Number(tokens[i]);
    if (tokens[i] === undefined || tokens[i] === "" || !Number.isFinite(v)) throw new CubeError("bad_number", { line });
    out.push(v);
  }
  return out;
}

// One header line into `header`. Returns false for a line that is not a
// keyword (the first data row).
function readKeyword(raw, header, lineNo) {
  const trimmed = raw.trim();
  // TITLE keeps everything after the keyword, '#' included ("Look #2").
  if (/^TITLE\b/i.test(trimmed)) {
    const rest = trimmed.slice(5).trim();
    const quoted = /^"([^"]*)"/.exec(rest);
    header.title = (quoted ? quoted[1] : stripComment(rest)).trim();
    return true;
  }
  const s = stripComment(raw).trim();
  if (!s) return true;
  if (!isKeywordLine(s)) return false;
  const tokens = s.split(WHITESPACE);
  const key = tokens[0].toUpperCase();
  switch (key) {
    case "LUT_3D_SIZE": {
      const n = Number(tokens[1]);
      if (header.size) throw new CubeError("duplicate_size", { line: lineNo });
      if (!Number.isInteger(n)) throw new CubeError("bad_size", { line: lineNo });
      if (n < LUT_MIN_SIZE || n > LUT_MAX_SIZE) throw new CubeError("size_out_of_range", { line: lineNo, size: n, max: LUT_MAX_SIZE });
      header.size = n;
      break;
    }
    case "LUT_1D_SIZE":
      header.has1d = true;
      break;
    case "LUT_2D_SIZE":
      throw new CubeError("lut_2d_unsupported", { line: lineNo });
    case "DOMAIN_MIN":
      header.domainMin = finiteNumbers(tokens.slice(1), 3, lineNo);
      break;
    case "DOMAIN_MAX":
      header.domainMax = finiteNumbers(tokens.slice(1), 3, lineNo);
      break;
    case "LUT_3D_INPUT_RANGE": {
      const [lo, hi] = finiteNumbers(tokens.slice(1), 2, lineNo);
      header.domainMin = [lo, lo, lo];
      header.domainMax = [hi, hi, hi];
      break;
    }
    default:
      // LUT_1D_INPUT_RANGE, vendor keys (BMD_TITLE, LUT_IN_VIDEO_RANGE…):
      // nothing a 3D lookup needs. NAN/INF rows land here too and are caught
      // by the row count.
      break;
  }
  return true;
}

function emptyHeader() {
  return { title: "", size: 0, has1d: false, domainMin: [0, 0, 0], domainMax: [1, 1, 1], comments: [] };
}

function checkHeader(header) {
  if (header.has1d) throw new CubeError("lut_1d_unsupported");
  if (!header.size) throw new CubeError("missing_size");
  for (let c = 0; c < 3; c++) {
    if (!(header.domainMin[c] < header.domainMax[c])) throw new CubeError("bad_domain");
  }
}

function lines(text) {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(LINE_BREAK);
}

// The header only, up to the first data row: what the library list needs
// (size, title, comments for the Log guess) without reading the table.
// `text` may be just the start of the file. Never throws: a header that
// can't be used comes back with `error`.
export function readCubeHeader(text) {
  const header = emptyHeader();
  const all = lines(text);
  try {
    for (let i = 0; i < all.length; i++) {
      const raw = all[i];
      const trimmed = raw.trim();
      if (trimmed.startsWith("#")) {
        const comment = trimmed.replace(/^#+/, "").trim();
        if (comment && header.comments.length < 20) header.comments.push(comment);
        continue;
      }
      if (!readKeyword(raw, header, i + 1)) break;
    }
    checkHeader(header);
  } catch (error) {
    return { ...header, error: error instanceof CubeError ? error.code : "unreadable" };
  }
  return header;
}

// The whole LUT. Throws CubeError. `table` holds size³ RGB triples as floats,
// red-fastest (index r + g·N + b·N²), exactly as the file lists them.
export function parseCube(text) {
  const header = emptyHeader();
  const all = lines(text);
  let table = null;
  let rows = 0;
  let expected = 0;
  for (let i = 0; i < all.length; i++) {
    const raw = all[i];
    if (table === null) {
      if (readKeyword(raw, header, i + 1)) continue;
      checkHeader(header);
      expected = header.size ** 3;
      table = new Float32Array(expected * 3);
    }
    const s = stripComment(raw).trim();
    if (!s) continue;
    // A keyword after the data started (DOMAIN_* placed late, a vendor key).
    if (isKeywordLine(s)) {
      readKeyword(raw, header, i + 1);
      continue;
    }
    const tokens = s.split(WHITESPACE);
    if (tokens.length < 3) throw new CubeError("bad_row", { line: i + 1 });
    if (rows >= expected) {
      rows += 1; // keep counting for the message
      continue;
    }
    const o = rows * 3;
    for (let c = 0; c < 3; c++) {
      const v = Number(tokens[c]);
      if (!Number.isFinite(v)) throw new CubeError("bad_number", { line: i + 1 });
      table[o + c] = v;
    }
    rows += 1;
  }
  if (table === null) {
    checkHeader(header);
    throw new CubeError("row_count", { found: 0, expected: header.size ** 3 });
  }
  checkHeader(header); // a late DOMAIN_* must still be sane
  if (rows !== expected) throw new CubeError("row_count", { found: rows, expected });
  return {
    title: header.title,
    size: header.size,
    domainMin: header.domainMin,
    domainMax: header.domainMax,
    table,
  };
}
