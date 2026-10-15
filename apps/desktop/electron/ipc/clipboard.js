// The system clipboard: text (paths, names, a text field's selection) and,
// like Finder, files. Done in the main process so it works whatever the
// renderer's focus or gesture state.
//
// Copying photos as files means what Finder's ⌘C means: Finder's ⌘V makes
// copies, WeChat / Notes / anything that takes a file drop gets the file.
// Electron's clipboard module has no file writer, so each platform's own:
//   macOS     NSPasteboard.writeObjects with one NSURL per file — Finder's
//             public.file-url, one pasteboard item each — through osascript's
//             JavaScript for Automation. The paths go as argv, never into the
//             script text. (NSArray.arrayWithArray bridges a JS array's
//             elements as NSDictionary; only addObject keeps them NSURLs.)
//   Windows   Windows PowerShell's Set-Clipboard -LiteralPath (CF_HDROP:
//             Explorer's Ctrl+V makes copies). The script is -EncodedCommand
//             (UTF-16, so a Chinese path survives and nothing is shell-
//             quoted); the paths are single-quoted PowerShell literals.
//   Linux     text/uri-list, best effort.
// Every path must be a file the media allowlist knows (the catalog, its
// roots): a compromised renderer must not be able to hand the user someone
// else's file to paste. Missing files are skipped and reported.

const fs = require("node:fs");
const { spawnSafely } = require("../spawnSafely");

const CHILD_TIMEOUT_MS = 15_000;

// The items are read back before the script ends: an NSURL's pasteboard data
// is promised, and a process that exits right after writeObjects leaves every
// item but the first unfulfilled (measured: 2 in, 1 on the pasteboard).
// Reading them fulfils the promises, and checks the count as well.
const JXA_COPY_FILES = `ObjC.import("AppKit");
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const urls = $.NSMutableArray.alloc.init;
  for (let i = 0; i < argv.length; i++) urls.addObject($.NSURL.fileURLWithPath($(argv[i])));
  if (!pb.writeObjects(urls)) return "fail";
  const items = pb.pasteboardItems;
  let urlsOnBoard = 0;
  for (let i = 0; i < items.count; i++) if (items.objectAtIndex(i).types.containsObject("public.file-url")) urlsOnBoard++;
  return urlsOnBoard === argv.length ? "ok" : "fail";
}`;

function macCommand(paths) {
  return ["osascript", ["-l", "JavaScript", "-e", JXA_COPY_FILES, ...paths]];
}

// A PowerShell single-quoted literal has one escape: '' for '.
function powershellLiteral(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function windowsCommand(paths) {
  const script = `Set-Clipboard -LiteralPath @(${paths.map(powershellLiteral).join(",")})`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // powershell.exe (5.1): its Set-Clipboard takes -LiteralPath, pwsh's does not.
  return ["powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded]];
}

function fileExistsOnDisk(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function runChild(spawn, [command, args]) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      // windowsHide: without it a console window flashes up while PowerShell runs.
      child = spawnSafely(spawn, command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      reject(new Error(`${command} timed out`));
    }, CHILD_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

function register({
  ipcMain, clipboard, allowlist,
  platform = process.platform,
  spawn = require("node:child_process").spawn,
  fileExists = fileExistsOnDisk,
}) {
  ipcMain.handle("app:copy-text", (_event, text) => {
    clipboard.writeText(String(text ?? ""));
    return true;
  });

  // → { copied: [path], missing: [path] }. A path the allowlist refuses is in
  // neither (the renderer never names one in normal use). Throws when the
  // platform's writer fails, so the renderer can say so.
  ipcMain.handle("app:copy-files", async (_event, paths) => {
    const wanted = [...new Set((Array.isArray(paths) ? paths : []).filter((p) => typeof p === "string" && p))];
    const copied = [];
    const missing = [];
    for (const filePath of wanted) {
      if (!(await allowlist.isAllowedMediaPathLoaded(filePath))) continue;
      if (fileExists(filePath)) copied.push(filePath);
      else missing.push(filePath);
    }
    if (!copied.length) return { copied, missing };

    if (platform === "darwin") {
      const out = await runChild(spawn, macCommand(copied));
      if (out.trim() !== "ok") throw new Error("NSPasteboard refused the files");
    } else if (platform === "win32") {
      await runChild(spawn, windowsCommand(copied));
    } else {
      const uris = copied.map((p) => `file://${encodeURI(p)}`);
      clipboard.writeBuffer("text/uri-list", Buffer.from(`${uris.join("\r\n")}\r\n`, "utf8"));
    }
    return { copied, missing };
  });
}

module.exports = { register, macCommand, windowsCommand, JXA_COPY_FILES };
