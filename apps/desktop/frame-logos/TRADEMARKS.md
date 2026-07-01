# Trademark notice — brand logos in this directory

All brand names, logos, and marks in this directory are the property of their
respective trademark holders. They are **not** owned by AfterFrame.

- AfterFrame is a **free, open-source, personal** project.
- These logos are included only so a photographer can stamp the camera that took
  a photo onto their own image (a camera-info watermark). Their presence does
  **not** imply any affiliation with, sponsorship by, or endorsement from the
  trademark holders.
- AfterFrame claims **no rights** over these marks.
- **Removal on request:** if you are a rights holder (or authorized agent) and
  want a logo removed, open an issue or contact the maintainer and it will be
  taken down promptly.

This whole directory is **self-contained and disposable** — deleting
`apps/desktop/frame-logos/` removes every bundled brand logo at once.
The frame/watermark feature then falls back to plain EXIF text (e.g. the camera
model string) plus AfterFrame's own original marks. No other code depends on the
files here beyond `logos.json`.

> Reassess before any commercial release: at that point, switch to "no bundled
> trademarks + user-import only" or obtain licensing. See
> `docs/frame-watermark-plan.md` → "⚠️ 授权".
