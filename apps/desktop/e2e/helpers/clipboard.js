// The system clipboard's files, read back the way Finder / File Explorer would
// paste them, so a spec can check what electron/ipc/clipboard.js wrote:
//   macOS     the general pasteboard's NSURLs (public.file-url), through
//             osascript's JavaScript for Automation.
//   Windows   Get-Clipboard -Format FileDropList (CF_HDROP), in Windows
//             PowerShell. The script goes as -EncodedCommand and the paths
//             come back base64-encoded JSON, so a Chinese path survives the
//             console code page in both directions.
// Elsewhere there is no reader: hasFileClipboard is false and the specs skip.
// These touch the real system clipboard (the one Finder / Explorer read), so
// a spec that writes it ends with clearClipboard().

const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const hasFileClipboard = process.platform === "darwin" || process.platform === "win32";

// A path as the clipboard would report it: symlinks resolved (/tmp is
// /private/tmp), and on Windows the 8.3 short form expanded and the case
// folded — NTFS is case-insensitive, and who wrote the path decides the
// drive letter's case. A spec runs its expectation through this too.
function comparablePath(filePath) {
  try {
    return process.platform === "win32" ? fs.realpathSync.native(filePath).toLowerCase() : fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

const JXA_READ = 'ObjC.import("AppKit"); const pb = $.NSPasteboard.generalPasteboard;'
  + ' const urls = pb.readObjectsForClassesOptions($([$.NSURL.class]), $()); const out = [];'
  + ' for (let i = 0; i < urls.count; i++) out.push(urls.objectAtIndex(i).path.js); JSON.stringify(out)';
const JXA_CLEAR = 'ObjC.import("AppKit"); $.NSPasteboard.generalPasteboard.clearContents; "ok"';

// PowerShell 5.1's Get-Clipboard writes the FileDropList as one List object
// (empty when the clipboard holds no files; measured), not item by item, so
// it is enumerated here: foreach walks a List, an array, or one item alike.
// The items are FileInfo / DirectoryInfo; a plain string is kept as is.
// -InputObject keeps a one-element array an array in the JSON.
const PS_READ = "$list = Get-Clipboard -Format FileDropList\n"
  + "$files = @(); foreach ($f in $list) { if ($f.FullName) { $files += [string]$f.FullName } else { $files += [string]$f } }\n"
  + "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress -InputObject $files)))";
const PS_CLEAR = "Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::Clear(); 'ok'";

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  return result.stdout.trim();
}

const osascript = (script) => run("osascript", ["-l", "JavaScript", "-e", script]);
const powershell = (script) =>
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);

// The files on the clipboard, as comparablePath gives them; null where the
// platform has no reader.
function readClipboardFiles() {
  let paths;
  if (process.platform === "darwin") {
    paths = JSON.parse(osascript(JXA_READ) || "[]");
  } else if (process.platform === "win32") {
    const out = powershell(PS_READ);
    paths = out ? JSON.parse(Buffer.from(out, "base64").toString("utf8")) : [];
  } else {
    return null;
  }
  if (paths == null) return [];
  return (Array.isArray(paths) ? paths : [paths]).map(comparablePath);
}

function clearClipboard() {
  if (process.platform === "darwin") osascript(JXA_CLEAR);
  else if (process.platform === "win32") powershell(PS_CLEAR);
}

module.exports = { hasFileClipboard, comparablePath, readClipboardFiles, clearClipboard };
