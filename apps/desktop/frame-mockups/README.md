# frame-mockups

Camera pictures for the frame tool's camera-mockup template: the photo is
played back on a camera's display, the camera's back seen straight on. See
`TRADEMARKS.md` for the notice (product photos and trademarks of their owners;
deletable any time).

## Layout

```
frame-mockups/
  mockups.json      every camera: its picture, where the display is, which
                    EXIF models it stands for, where the picture came from
  images/<id>.webp  the camera, background removed, display cut out
  TRADEMARKS.md     notice and sources
```

A `mockups.json` entry:

```json
{
  "id": "canon-eos-r5",
  "brand": "canon",
  "name": "Canon EOS R5",
  "match": ["EOS R5"],
  "file": "images/canon-eos-r5.webp",
  "size": [1500, 1093],
  "screen": { "x": 0.13133, "y": 0.44831, "w": 0.48733, "h": 0.44465, "radius": 0 },
  "source": "https://…"
}
```

- `screen` is the display as fractions of the picture; `radius` is its corner
  radius as a fraction of the display's short side.
- `match` lists EXIF Model strings. They are compared without case, spaces or
  punctuation and with the maker's name dropped, so `NIKON Z 6_2`, `Z 6_2` and
  `z62` are one model. The entry's `name` matches too.
- `brandDefault` marks the camera a photo gets when its own model has no
  picture but its maker has. `generic` names the cameras for an unknown
  camera: one for landscape photos, one held upright for portrait ones.

The app reads the folder in `src/components/editor/mockups.js`. The pictures
load as data URLs, one chunk each, the first time a camera is used.

## Adding or redoing cameras

1. Mark the display on each product shot with the screen annotation page (a
   local HTML page: frame the display, set its corners, straighten the picture
   if it is turned). It saves `screens.json`.
2. Add the camera to `CAMERAS` in `scripts/build-frame-mockups.mjs`: a stable
   id, the maker, the display name and the EXIF models it stands for.
3. Build it:

   ```bash
   node scripts/build-frame-mockups.mjs path/to/screens.json --only canon-eos-r5
   ```

   Without `--only` every camera in `screens.json` is built. The script needs
   the source pictures `screens.json` points at; they are not in the
   repository. A body so light it touches the studio white (Sigma BF's
   aluminium) gets `whiteMin` in its `CAMERAS` entry, so only true white counts
   as background.
4. Look at the result on a dark backdrop: no light fringe, no holes in a light
   body, the display cut exactly.
