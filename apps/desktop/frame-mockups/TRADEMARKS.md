# Notice — camera pictures in this directory

The camera pictures in `images/` are product photographs of cameras. The
photographs belong to the camera makers and the retailers that published them,
and the camera names, designs and marks shown on them are their owners'
trademarks. **None of it is owned by AfterFrame.**

- AfterFrame is a **free, open-source, personal** project.
- The pictures are included only so a photographer can show their own photo
  played back on a camera's display (a "camera mockup" frame). Their presence
  does **not** imply any affiliation with, sponsorship by, or endorsement from
  the camera makers or the retailers.
- AfterFrame claims **no rights** over the photographs or the marks.
- **Removal on request:** if you hold the rights to a picture (or act for
  someone who does) and want it removed, open an issue or contact the
  maintainer and it will be taken down promptly.

This whole directory is **self-contained and disposable**: deleting
`apps/desktop/frame-mockups/` removes every camera picture at once. The frame
tool then has no camera-mockup template; nothing else depends on these files.

> Reassess before any commercial release: at that point, switch to "no bundled
> product photos + the user's own camera pictures" or obtain licensing.

## Where the pictures come from

Each camera's entry in `mockups.json` has the page its picture was taken from
(`source`). By site, in November 2026:

| Site | Cameras |
|---|---|
| B&H Photo (bhphotovideo.com) | 53 |
| Adorama (adorama.com) | 17 |
| Hasselblad store (store-na.hasselblad.com) | 1 |
| Canon USA (usa.canon.com) | 1 |
| Bedford's (bedfords.com) | 1 |
| not recorded (`canon-powershot-v1`, `sony-a1-ii`) | 2 |

Edits, all made by `scripts/build-frame-mockups.mjs`: the white studio
background removed, the display cut out, the picture straightened where it was
slightly turned (`canon-eos-r6-iii`, `ricoh-gr-iv`, under half a degree),
trimmed to the camera and saved as WebP. Nothing is drawn in.
