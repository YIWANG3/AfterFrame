# People / Face Auto-Grouping — Research & Plan

Goal: portrait auto-categorization — detect faces, group them into "people"
(like Apple Photos' People album), browse/filter by person. A core feature for
portrait photographers.

Status: **research / feasibility done**. Not started. A large feature, slotted
**after** the editing-software integration work (see [integration-plan.md](integration-plan.md)).

## Verdict: highly feasible

The app already has nearly all the infrastructure. The only parts needing
validation are the **face-embedding source** and the **clustering** step.

## What's already in place (reuse)

| Need | Existing pattern to reuse |
|---|---|
| Native ML calls | `apps/desktop/native/extract-sticker.swift` (Vision `VNGenerateForegroundInstanceMaskRequest`) and `compute-depth.swift` (CoreML, Depth Anything V2). A new `detect-faces.swift` copies this: Swift helper → spawn → JSON manifest → cache. See `electron/ipc/depth.js` / `stickers.js` for the invoke pattern; `scripts/build-native.sh` to build. |
| Background jobs | The annotation job is the template: batched asset processing, progress callback, cooperative cancel. `services/sidecar/src/media_workspace/job_runner.py` (`run_annotation_job`). Face detection job mirrors it; created via `create-job` + `run-<type>-job`, polled by Electron. |
| DB extension | Add two tables: `asset_faces` (face_id, asset_id, bbox_json, embedding_json, confidence, person_group_id) and `person_groups` (group_id, name, exemplar_face_id, cluster_size). Migrations pattern in `db/`. |
| People view | Clone the StickerView pattern. Extend `viewMode` from `"assets" \| "stickers"` to add `"people"` (App.jsx). Three-part hook + toolbar/gallery/inspector (`src/components/StickerView.jsx` as template). |
| Filter by person | Add a `person` facet to FilterBar — identical to camera/lens/tag `ListPopover`, via existing `searchFacet` + `browseImages(filters)`. Backend adds `facetValues.people`. |
| Face thumbnails | Backend pre-crops bbox → small PNG in a cache dir; frontend shows via `localFileUrl()` + `media://` (zero protocol change). Simplest option. |
| Inspector "who's in this photo" | Reuse `ThumbnailStrip` + `Section` + the tag click-to-filter pattern (Inspector.jsx / AnnotationsSection.jsx). |

## Three things to validate / decide

1. **Face embedding source — KEY, spike first.**
   - `VNDetectFaceRectanglesRequest` (detection boxes) is public & reliable — fine.
   - But the face **embedding** (`VNGenerateFaceprintRequest` / faceprint) is
     historically an *opaque* object; not guaranteed to export as a usable float
     vector for clustering (don't trust "128 floats" claims unverified).
   - Two paths:
     - (a) If Vision faceprint exposes a usable vector / distance → use it.
     - (b) If not → ship/BYO a CoreML face-recognition model (ArcFace/FaceNet),
       same pattern as the depth model. More controllable, version-stable.
   - **Action: ~half-day spike** — a `detect-faces.swift` that proves whether a
     clusterable embedding can be obtained from Vision. This decides (a) vs (b).

2. **Clustering — not a blocker.** faiss is overkill for a single-user desktop
   catalog (typically a few thousand faces). `scikit-learn` DBSCAN / agglomerative
   on cosine distance runs in seconds at that scale; add numpy/sklearn dep. Expose
   a similarity threshold (UI slider, re-cluster on change). faiss only if libraries
   grow to tens of thousands of faces.

3. **Naming / confirmation UX (product decision).** Auto-clustered people start
   unnamed → user names them. How to present "unidentified" faces. Whether
   dragging a photo onto a person just adds membership or also labels that face
   (correction feedback loop).

## Shape of the feature

- **A person = a smart collection** (`kind: "person"`), reusing collection
  membership — but NOT shown in the sidebar Folders list; only in the People view.
- Flow: import / manual trigger → **detection job** (writes `asset_faces`) →
  **clustering job** (creates `person_groups`) → People view: browse, name,
  filter-by-person.

## Effort & positioning

~**5–8 weeks**: detection helper ~1w, clustering + job ~2w, DB + migrations ~0.5w,
People view + filter + inspector ~2–3w, threshold tuning ~1w. A large feature —
do it after the integration milestones.

## Next action when picked up

Start with the **half-day embedding spike** (`detect-faces.swift`) — it's the
fork in the road between using Vision's faceprint vs. a bundled CoreML model.
