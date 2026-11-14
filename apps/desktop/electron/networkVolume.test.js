const test = require("node:test");
const assert = require("node:assert/strict");
const { networkVolumeOf, parseDarwinMounts, parseLinuxMounts, parseNetUse } = require("./networkVolume");

const DARWIN_MOUNT = [
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)",
  "//me@NAS._smb._tcp.local/personal folder on /Volumes/personal folder (smbfs, nodev, nosuid, mounted by me)",
  "/dev/disk5s1 on /Volumes/T7 (apfs, local, nodev, nosuid, journaled, noowners)",
].join("\n");

test("parseDarwinMounts reads the mount point and type, spaces and all", () => {
  const mounts = parseDarwinMounts(DARWIN_MOUNT);
  assert.deepEqual(mounts[2], { mountPoint: "/Volumes/personal folder", fsType: "smbfs" });
  assert.equal(mounts.length, 4);
});

test("parseLinuxMounts unescapes \\040", () => {
  assert.deepEqual(parseLinuxMounts("//nas/share /mnt/my\\040nas cifs rw 0 0\n")[0], { mountPoint: "/mnt/my nas", fsType: "cifs" });
});

test("parseNetUse finds mapped drive letters", () => {
  const text = "Status       Local     Remote                    Network\n-----\nOK           Z:        \\\\nas\\photos               Microsoft Windows Network\n";
  assert.deepEqual([...parseNetUse(text)], ["Z"]);
});

const darwin = (existing) => ({
  platform: "darwin",
  readMounts: async () => parseDarwinMounts(DARWIN_MOUNT),
  exists: (p) => existing.some((dir) => p === dir),
  realpath: (p) => p,
});

test("networkVolumeOf: the deepest mount wins; a folder not made yet counts by its nearest parent", async () => {
  const nas = await networkVolumeOf("/Volumes/personal folder/RAW/2026/new.afcatalog", darwin(["/Volumes/personal folder/RAW"]));
  assert.equal(nas.fsType, "smbfs");
  assert.equal(await networkVolumeOf("/Volumes/T7/lib.afcatalog", darwin(["/Volumes/T7"])), null);
  assert.equal(await networkVolumeOf("/Users/me/Pictures/lib.afcatalog", darwin(["/Users/me/Pictures"])), null);
  // A sibling whose name only starts like the mount point is not on it.
  assert.equal(await networkVolumeOf("/Volumes/personal folder2/x", darwin(["/Volumes"])), null);
});

test("networkVolumeOf on Windows: UNC paths and mapped drives", async () => {
  const win = { platform: "win32", readNetUse: async () => "OK           Z:        \\\\nas\\photos   Microsoft Windows Network\n" };
  assert.ok(await networkVolumeOf("\\\\nas\\photos\\lib.afcatalog", win));
  assert.ok(await networkVolumeOf("Z:\\lib.afcatalog", win));
  assert.equal(await networkVolumeOf("C:\\Users\\me\\lib.afcatalog", win), null);
});
