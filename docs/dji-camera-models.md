# DJI camera model codes (EXIF)

What DJI drones and handhelds write in EXIF `Make` / `Model`, per camera. Researched 2026-09-30 from Wikimedia Commons file metadata (and its table [DJI camera model names](https://commons.wikimedia.org/wiki/DJI_camera_model_names)), lensfun, Flickr EXIF pages and DJI SDK sources; each code was confirmed by at least one independent source unless marked. The app names them from `apps/desktop/camera-names/manual.json` ("DJI Air 3S"; see [camera-name-rules.md](camera-name-rules.md)): a drone's cameras named the same are one camera, sharing a model logo.

`Make` is `DJI` unless noted. The Hasselblad-branded main cameras write `Make: Hasselblad`, so they count as the Hasselblad brand (decided 2026-09-30).

| Device | Camera | EXIF Model |
|---|---|---|
| Air 3S | 24mm wide (1-inch) | FC9113 |
| Air 3S | 70mm medium tele | FC9184 |
| Air 3 | 24mm wide | FC8282 |
| Air 3 | 70mm medium tele | FC8284 |
| Air 2S | 22mm (1-inch) | FC3411 |
| Mavic Air 2 | 24mm | FC3170 |
| Mavic Air | 24mm | FC2103 |
| Mavic 4 Pro | 28mm main | L3D-100c (Make Hasselblad) |
| Mavic 4 Pro | 70mm | FC9284 |
| Mavic 4 Pro | 168mm | FC9287 |
| Mavic 3 Pro / Pro Cine | 24mm main | L2D-20c (Make Hasselblad) |
| Mavic 3 Pro / Pro Cine | 70mm | FC4382 |
| Mavic 3 Pro / Pro Cine | 166mm | FC4370 |
| Mavic 3 / 3 Cine | 24mm main | L2D-20c (Make Hasselblad) |
| Mavic 3 / 3 Cine | 162mm tele | FC4170 |
| Mavic 3 Classic | 24mm main | L2D-20c (Make Hasselblad) |
| Mavic 2 Pro | 28mm (1-inch) | L1D-20c (Make Hasselblad) |
| Mavic 2 Zoom | 24–48mm | FC2204 |
| Mavic Pro / Platinum | 26mm | FC220 |
| Mini 5 Pro | 24mm (1-inch) | FC9313 |
| Mini 4 Pro | 24mm | FC8482 |
| Mini 3 Pro | 24mm | FC3582 |
| Mini 3 | 24mm | FC3682 |
| Mini 4K | 24mm | FC7703 |
| Mini 2 | 24mm | FC7303 |
| Mini 2 SE | 24mm | FC7503 |
| Mavic Mini / Mini SE | 24mm | FC7203 |
| Flip | 24mm | FC8582 |
| Neo | 14mm | FC8671 |
| Neo 2 | 16mm | FC9470 |
| Spark | 25mm | FC1102 |
| Avata 2 | 12mm | FC8485 |
| Avata | 12mm | FC8183 (likely) |
| Avata 360 | 360 dual lens | FCA188 |
| FPV | 14mm | FC3305 |
| Osmo Pocket 4P | 20mm and 60mm | PP-041 (both) |
| Osmo Pocket 4 | 20mm | OP-041 |
| Osmo Pocket 3 | 20mm (1-inch) | PP-101 |
| Pocket 2 | 20mm | DJI Pocket |
| Osmo Pocket | 26mm | Osmo Pocket, or OT110 |
| Osmo Action 6 | main | AC006 |
| Osmo Action 5 Pro | 12mm | AC004 |
| Osmo Action 4 | 12mm | AC003 |
| Osmo Action 3 | 12mm | AC002 |
| Action 2 | 12mm | MC211 |
| Osmo Action | 15mm | DJI Osmo Action |
| Osmo 360 | 360 dual lens | OQ001 (Make `Osmo`, not DJI) |
| Osmo Nano | main | OW001 |

Notes

- A multi-camera drone writes a different code per lens (Air 3S: FC9113 + FC9184). Focal length alone cannot tell drones apart: the 70mm module (19.35mm) is shared by FC8284, FC4382, FC9184 and FC9284.
- The Osmo Pocket 4P writes the same code for both lenses.
- Osmo 360 writes `Make: Osmo`: `frame-logos/logos.json` matches `osmo` to DJI.
- Test samples with these EXIFs are in `~/Desktop/Export/dpreview/` (DPReview originals: Mavic 3 Pro ×4, Air 3 ×2, Air 2S ×1); DPReview has no gallery for the Air 3S, Mavic 4 Pro, Mini 4 Pro, Mini 5 Pro, Pocket 3 or Osmo Action.
