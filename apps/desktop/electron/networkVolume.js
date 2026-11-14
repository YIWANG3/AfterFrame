// Whether a path is on a network volume (SMB, AFP, NFS, WebDAV …). A catalog
// there is slow and fragile: SQLite can't use WAL on a network file system, so
// every commit is several synchronous round trips to the server, and its file
// locks are only as good as the server's. The catalog dialogs warn about it.
//
//   networkVolumeOf(target) → { fsType, mountPoint } | null
//
// macOS reads `mount`, Linux /proc/mounts, Windows takes a UNC path or a
// drive letter `net use` lists as mapped. Anything that can't be read counts
// as local: this only decides whether to warn.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const NETWORK_FS = new Set([
  "smbfs", "afpfs", "nfs", "nfs4", "webdav", "cifs", "smb3", "ftp", "fuse.sshfs", "9p",
]);

// `mount` on macOS: "//user@host/share on /Volumes/share (smbfs, nodev, …)".
function parseDarwinMounts(text) {
  const mounts = [];
  for (const line of String(text).split("\n")) {
    const match = /^.+? on (.+) \(([^,)]+)/.exec(line);
    if (match) mounts.push({ mountPoint: match[1], fsType: match[2].trim() });
  }
  return mounts;
}

// /proc/mounts: "source mountpoint type options 0 0", spaces escaped as \040.
function parseLinuxMounts(text) {
  const unescape = (value) => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
  const mounts = [];
  for (const line of String(text).split("\n")) {
    const fields = line.split(" ");
    if (fields.length >= 3) mounts.push({ mountPoint: unescape(fields[1]), fsType: fields[2] });
  }
  return mounts;
}

// `net use`: "OK           Z:        \\server\share   Microsoft Windows Network".
function parseNetUse(text) {
  const drives = new Set();
  for (const line of String(text).split("\n")) {
    const match = /\b([A-Za-z]):\s+\\\\/.exec(line);
    if (match) drives.add(match[1].toUpperCase());
  }
  return drives;
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => resolve(error ? "" : stdout));
  });
}

async function defaultReadMounts(platform) {
  if (platform === "darwin") return parseDarwinMounts(await run("/sbin/mount", []));
  if (platform === "linux") {
    try {
      return parseLinuxMounts(fs.readFileSync("/proc/mounts", "utf-8"));
    } catch {
      return [];
    }
  }
  return [];
}

// The nearest folder of `target` that exists, with symlinks resolved: a new
// catalog's folder doesn't exist yet when the dialog returns. POSIX paths
// (macOS / Linux) whatever the host, so the tests read the same on Windows.
function existingRealDir(target, { exists, realpath }) {
  let current = path.posix.resolve(target);
  while (!exists(current)) {
    const parent = path.posix.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  try {
    return realpath(current);
  } catch {
    return current;
  }
}

function within(dir, mountPoint) {
  if (mountPoint === "/") return true;
  return dir === mountPoint || dir.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
}

async function networkVolumeOf(target, {
  platform = process.platform,
  readMounts = defaultReadMounts,
  readNetUse = () => run("net", ["use"]),
  exists = fs.existsSync,
  realpath = fs.realpathSync.native,
} = {}) {
  if (!target) return null;
  if (platform === "win32") {
    const resolved = path.win32.resolve(target);
    if (resolved.startsWith("\\\\")) return { fsType: "smb", mountPoint: resolved.split("\\").slice(0, 4).join("\\") };
    const drive = /^([A-Za-z]):/.exec(resolved)?.[1]?.toUpperCase();
    if (drive && parseNetUse(await readNetUse()).has(drive)) return { fsType: "smb", mountPoint: `${drive}:\\` };
    return null;
  }
  const dir = existingRealDir(target, { exists, realpath });
  let best = null;
  for (const mount of await readMounts(platform)) {
    if (within(dir, mount.mountPoint) && (!best || mount.mountPoint.length > best.mountPoint.length)) best = mount;
  }
  return best && NETWORK_FS.has(best.fsType.toLowerCase()) ? best : null;
}

module.exports = { networkVolumeOf, parseDarwinMounts, parseLinuxMounts, parseNetUse };
