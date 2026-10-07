const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLutLibrary, lutId } = require("./lutLibrary");

function cube(n, f = (r, g, b) => [r, g, b], header = "") {
  const rows = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
    rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(5)).join(" "));
  }
  return `${header}LUT_3D_SIZE ${n}\n${rows.join("\n")}\n`;
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lut-library-"));
  let folders = [];
  const library = createLutLibrary({
    libraryDir: path.join(dir, "userData", "luts"),
    indexPath: path.join(dir, "userData", "luts-index.json"),
    readFolders: () => folders,
    writeFolders: async (next) => { folders = next; },
    logger: { warn() {} },
  });
  const write = (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { dir, library, write, folders: () => folders, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("an empty library lists nothing and reports where it lives", async () => {
  const { library, cleanup } = setup();
  try {
    const res = await library.list();
    assert.equal(res.luts.length, 0);
    assert.equal(res.library.count, 0);
    assert.match(res.library.dir, /luts$/);
  } finally {
    cleanup();
  }
});

test("importing a folder keeps the pack's name and the folder each file sat in; duplicates are skipped", async () => {
  const { dir, library, write, cleanup } = setup();
  try {
    write("LUTIFY/3D LUTs (CUBE)/STANDARD/Revenant - Rec709.cube", cube(3, (r, g, b) => [r * 0.9, g, b]));
    write("LUTIFY/3D LUTs (CUBE)/LOG/Revenant - LOG.cube", cube(3, (r, g, b) => [r, g * 0.9, b]));
    write("LUTIFY copy/LOG/Revenant - LOG.cube", cube(3, (r, g, b) => [r, g * 0.9, b])); // same bytes
    write("LUTIFY/readme.txt", "not a LUT");
    const first = await library.importPaths([path.join(dir, "LUTIFY")]);
    assert.equal(first.imported.length, 2);
    assert.equal(first.duplicates.length, 0);
    const second = await library.importPaths([path.join(dir, "LUTIFY copy")]);
    assert.equal(second.imported.length, 0);
    assert.equal(second.duplicates.length, 1);

    const listed = await library.list();
    assert.deepEqual(listed.luts.map((l) => `${l.group} | ${l.name}`).sort(), [
      "LUTIFY / LOG | Revenant - LOG",
      "LUTIFY / STANDARD | Revenant - Rec709",
    ]);
    // The duplicate points at the copy already in the library.
    assert.equal(second.duplicates[0], listed.luts.find((l) => l.name === "Revenant - LOG").id);
    assert.equal(listed.library.count, 2);
    assert.ok(listed.library.bytes > 0);
    // The Log guess reads the folder too.
    assert.equal(listed.luts.find((l) => l.name === "Revenant - LOG").log, true);
    assert.equal(listed.luts.find((l) => l.name === "Revenant - Rec709").log, false);
  } finally {
    cleanup();
  }
});

test("a file with the same name but other content is kept beside, renamed", async () => {
  const { library, write, cleanup } = setup();
  try {
    const a = write("a/Packs/Warm.cube", cube(2, (r, g, b) => [r, g, b * 0.8]));
    const b = write("b/Packs/Warm.cube", cube(2, (r, g, b) => [r, g, b * 0.7]));
    await library.importPaths([a]);
    await library.importPaths([b]);
    const names = (await library.list()).luts.map((l) => l.name).sort();
    assert.deepEqual(names, ["Warm", "Warm (1)"]);
  } finally {
    cleanup();
  }
});

test("unusable files are refused on import with a reason, and nothing is copied for them", async () => {
  const { dir, library, write, cleanup } = setup();
  try {
    const oneD = write("in/one-d.cube", "LUT_1D_SIZE 2\n0 0 0\n1 1 1\n");
    const short = write("in/short.cube", cube(3).split("\n").slice(0, -3).join("\n"));
    const res = await library.importPaths([oneD, short, path.join(dir, "in/missing.cube")]);
    assert.deepEqual(res.failed.map((f) => [f.name, f.error]).sort(), [["one-d.cube", "lut_1d_unsupported"], ["short.cube", "row_count"]]);
    assert.equal((await library.list()).luts.length, 0);
  } finally {
    cleanup();
  }
});

test("an added folder is read in place, never copied; it reports unavailable once it's gone", async () => {
  const { dir, library, write, folders, cleanup } = setup();
  try {
    write("Drive/Sony/Phntm_Neutral_Slog3.cube", cube(2));
    const added = await library.addFolder(path.join(dir, "Drive"));
    assert.equal(added.ok, true);
    assert.deepEqual(folders(), [path.join(dir, "Drive")]);
    let listed = await library.list();
    assert.equal(listed.library.count, 0);
    assert.equal(listed.luts.length, 1);
    assert.equal(listed.luts[0].source, "folder");
    assert.equal(listed.luts[0].group, "Sony");
    assert.equal(listed.luts[0].log, true);
    assert.equal(await library.libraryPath(listed.luts[0].id), null, "not ours to delete");
    const text = await library.read(listed.luts[0].id);
    assert.match(text.text, /^LUT_3D_SIZE 2/);

    fs.rmSync(path.join(dir, "Drive"), { recursive: true });
    listed = await library.list();
    assert.equal(listed.folders[0].available, false);
    assert.equal(listed.luts.length, 0);
    assert.deepEqual(await library.read(lutId(path.join(dir, "Drive/Sony/Phntm_Neutral_Slog3.cube"))), { error: "missing" });

    await library.removeFolder(path.join(dir, "Drive"));
    assert.deepEqual(folders(), []);
    assert.equal((await library.addFolder(path.join(dir, "nope"))).error, "not_a_folder");
  } finally {
    cleanup();
  }
});

test("in an added folder, a LUT is headed by its pack and the folder it sits in, so copies of a pack stay apart", async () => {
  const { dir, library, write, cleanup } = setup();
  try {
    write("Resource/LUTIFY/Triune/3D LUTs (CUBE)/ALEXA/Gravity - Alexa.cube", cube(2));
    write("Resource/LUTIFY 2/Triune/3D LUTs (CUBE)/ALEXA/Gravity - Alexa.cube", cube(2));
    write("Resource/Kodak Gold.cube", cube(2));
    await library.addFolder(path.join(dir, "Resource"));
    const groups = (await library.list()).luts.map((l) => `${l.group} | ${l.name}`).sort();
    assert.deepEqual(groups, [
      "LUTIFY / ALEXA | Gravity - Alexa",
      "LUTIFY 2 / ALEXA | Gravity - Alexa",
      "Resource | Kodak Gold",
    ]);
  } finally {
    cleanup();
  }
});

test("the library folder can't be added to itself", async () => {
  const { library, cleanup } = setup();
  try {
    fs.mkdirSync(library.libraryDir, { recursive: true });
    assert.equal((await library.addFolder(library.libraryDir)).error, "inside_library");
  } finally {
    cleanup();
  }
});

test("a Log mark overrides the guess, survives a rescan, and clears back to the guess", async () => {
  const { dir, library, write, cleanup } = setup();
  try {
    write("in/Kodak 2383.cube", cube(2));
    await library.importPaths([path.join(dir, "in")]);
    let [entry] = (await library.list()).luts;
    assert.equal(entry.log, false);
    await library.setLogMark(entry.id, "log");
    [entry] = (await library.list()).luts;
    assert.equal(entry.log, true);
    assert.equal(entry.logMarked, true);
    await library.setLogMark(entry.id, null);
    [entry] = (await library.list()).luts;
    assert.equal(entry.log, false);
    assert.equal(entry.logMarked, false);
  } finally {
    cleanup();
  }
});

test("a Log mark follows the file when it's moved to another folder", async () => {
  const { dir, library, write, cleanup } = setup();
  try {
    const file = write("Drive/Warm/Kodak 2383.cube", cube(2));
    await library.addFolder(path.join(dir, "Drive"));
    let [entry] = (await library.list()).luts;
    await library.setLogMark(entry.id, "log");
    fs.mkdirSync(path.join(dir, "Drive/Moved"));
    fs.renameSync(file, path.join(dir, "Drive/Moved/Kodak 2383.cube"));
    [entry] = (await library.list()).luts;
    assert.equal(entry.group, "Moved");
    assert.equal(entry.log, true);
    assert.equal(entry.logMarked, true);
  } finally {
    cleanup();
  }
});

test("files dropped into the library folder in Finder are listed on the next scan; removed ones go", async () => {
  const { library, cleanup } = setup();
  try {
    assert.equal((await library.list()).luts.length, 0);
    fs.mkdirSync(path.join(library.libraryDir, "By hand"), { recursive: true });
    fs.writeFileSync(path.join(library.libraryDir, "By hand", "Teal.cube"), cube(2));
    fs.writeFileSync(path.join(library.libraryDir, "notes.txt"), "not a LUT");
    let listed = await library.list();
    assert.deepEqual(listed.luts.map((l) => `${l.group} | ${l.name}`), ["By hand | Teal"]);
    assert.equal(listed.library.count, 1);
    fs.rmSync(path.join(library.libraryDir, "By hand", "Teal.cube"));
    listed = await library.list();
    assert.equal(listed.luts.length, 0);
  } finally {
    cleanup();
  }
});

test("headers are cached by size and mtime: a rescan reads only what changed", async () => {
  const { dir, library, write, cleanup } = setup();
  try {
    const file = write("Drive/a.cube", cube(2, undefined, "TITLE \"first\"\n"));
    await library.addFolder(path.join(dir, "Drive"));
    assert.equal((await library.list()).luts[0].title, "first");
    fs.writeFileSync(file, cube(2, undefined, "TITLE \"second, and longer\"\n"));
    assert.equal((await library.list()).luts[0].title, "second, and longer");
  } finally {
    cleanup();
  }
});
