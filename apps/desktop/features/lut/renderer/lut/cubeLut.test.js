import { describe, expect, it } from "vitest";
import { CubeError, parseCube, readCubeHeader } from "../../../../shared/cubeLut.mjs";

// An N³ cube from f(r, g, b) → [r', g', b'], red fastest, as .cube text.
export function cubeText(n, f = (r, g, b) => [r, g, b], { header = "", eol = "\n", sep = " " } = {}) {
  const rows = [];
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(sep));
      }
    }
  }
  return `${header}LUT_3D_SIZE ${n}${eol}${rows.join(eol)}${eol}`;
}

const codeOf = (fn) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CubeError);
    return error.code;
  }
  throw new Error("expected a CubeError");
};

describe("parseCube", () => {
  it("reads a cube red-fastest, as floats", () => {
    const lut = parseCube(cubeText(2, (r, g, b) => [r, g * 0.5, b * 0.25]));
    expect(lut.size).toBe(2);
    expect(lut.table).toBeInstanceOf(Float32Array);
    expect(lut.table.length).toBe(2 ** 3 * 3);
    // index r + g·N + b·N²: (1,0,0) is the second row, (0,1,0) the third.
    expect([...lut.table.slice(3, 6)]).toEqual([1, 0, 0]);
    expect([...lut.table.slice(6, 9)]).toEqual([0, 0.5, 0]);
    expect([...lut.table.slice(12, 15)]).toEqual([0, 0, 0.25]);
  });

  it("takes what real files do: BOM, CRLF and CR, tabs, comments anywhere, quoted and bare TITLE, unknown keys", () => {
    const body = cubeText(2, undefined, { eol: "\r\n", sep: "\t" }).replace("LUT_3D_SIZE 2\r\n", "");
    const text = `${"﻿"}# made by hand\r\nTITLE "Look #2"\r\nBMD_TITLE whatever\r\nlut_3d_size 2 # lower case\r\n${body}# trailing comment\r\n`;
    const lut = parseCube(text);
    expect(lut.title).toBe("Look #2");
    expect(lut.size).toBe(2);
    expect(parseCube(cubeText(2, undefined, { eol: "\r", header: "TITLE bare name\r" })).title).toBe("bare name");
  });

  it("keeps values outside 0..1: clamping nodes changes log-conversion LUTs", () => {
    const lut = parseCube(cubeText(2, (r, g, b) => [r * 1.2 - 0.1, g, b]));
    expect(Math.min(...lut.table)).toBeCloseTo(-0.1, 5);
    expect(Math.max(...lut.table)).toBeCloseTo(1.1, 5);
  });

  it("applies DOMAIN_MIN/MAX and LUT_3D_INPUT_RANGE, including after the data", () => {
    const a = parseCube(cubeText(2, undefined, { header: "DOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 2 4\n" }));
    expect(a.domainMax).toEqual([1, 2, 4]);
    const b = parseCube(cubeText(2, undefined, { header: "LUT_3D_INPUT_RANGE 0.1 0.9\n" }));
    expect(b.domainMin).toEqual([0.1, 0.1, 0.1]);
    expect(b.domainMax).toEqual([0.9, 0.9, 0.9]);
    const late = parseCube(`${cubeText(2)}DOMAIN_MAX 2 2 2\n`);
    expect(late.domainMax).toEqual([2, 2, 2]);
  });

  it("accepts numbers written like -1, .5 and 1e-3", () => {
    const text = cubeText(2).replace("0.000000 0.000000 0.000000", "-0 .5 1e-3");
    expect([...parseCube(text).table.slice(0, 3)].map((v) => +v.toFixed(4))).toEqual([0, 0.5, 0.001]);
  });

  it("refuses what it can't apply, with a code the UI can name", () => {
    expect(codeOf(() => parseCube("TITLE x\n0 0 0\n"))).toBe("missing_size");
    expect(codeOf(() => parseCube("LUT_1D_SIZE 4\n0 0 0\n0.3 0.3 0.3\n0.6 0.6 0.6\n1 1 1\n"))).toBe("lut_1d_unsupported");
    expect(codeOf(() => parseCube(`LUT_1D_SIZE 2\n${cubeText(2)}`))).toBe("lut_1d_unsupported");
    expect(codeOf(() => parseCube("LUT_3D_SIZE 129\n"))).toBe("size_out_of_range");
    expect(codeOf(() => parseCube("LUT_3D_SIZE 1\n"))).toBe("size_out_of_range");
    expect(codeOf(() => parseCube("LUT_3D_SIZE 2.5\n"))).toBe("bad_size");
    expect(codeOf(() => parseCube(cubeText(2).replace(/\n[^\n]*\n$/, "\n")))).toBe("row_count");
    expect(codeOf(() => parseCube(`${cubeText(2)}0 0 0\n`))).toBe("row_count");
    expect(codeOf(() => parseCube(cubeText(2).replace("1.000000 1.000000 1.000000", "1 1 nan")))).toBe("bad_number");
    expect(codeOf(() => parseCube(cubeText(2).replace("1.000000 1.000000 1.000000", "1 1")))).toBe("bad_row");
    expect(codeOf(() => parseCube(cubeText(2, undefined, { header: "DOMAIN_MIN 1 0 0\nDOMAIN_MAX 1 1 1\n" })))).toBe("bad_domain");
  });

  it("reports the rows found and expected", () => {
    try {
      parseCube(cubeText(2).replace(/\n[^\n]*\n$/, "\n"));
    } catch (error) {
      expect(error.detail).toEqual({ found: 7, expected: 8 });
    }
  });
});

describe("readCubeHeader", () => {
  it("reads the header from the start of a file, comments included, without the table", () => {
    const head = "# Input: Panasonic V-Log\n# Output: Rec709\nTITLE \"Kodak\"\nLUT_3D_SIZE 33\n0 0 0\n";
    const header = readCubeHeader(head);
    expect(header.size).toBe(33);
    expect(header.title).toBe("Kodak");
    expect(header.comments).toEqual(["Input: Panasonic V-Log", "Output: Rec709"]);
    expect(header.error).toBeUndefined();
  });

  it("never throws: an unusable header comes back with its reason", () => {
    expect(readCubeHeader("LUT_1D_SIZE 4096\n0 0 0\n").error).toBe("lut_1d_unsupported");
    expect(readCubeHeader("hello\n").error).toBe("missing_size");
    expect(readCubeHeader("LUT_3D_SIZE 99\n").error).toBe("size_out_of_range");
  });
});
