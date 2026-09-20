// Copy edits from the photo in the editor, paste them onto many photos in the
// gallery (the iPhone Photos model). Only the transforms that mean the same
// thing on another photo travel: quarter turns, flips, the crop and the
// straighten angle. Layers, canvas padding and frames are placed by eye on one
// photo and stay behind. Everything here feeds api.processAndSave (sharp, full
// resolution), so a paste never goes through the 2200 px editor canvas.

// Two photos count as "the same shape" within this tolerance — sensor sizes of
// one camera differ by a pixel or two between bodies and crops of crops.
const SAME_ASPECT_TOLERANCE = 0.01;

export const PASTE_KINDS = ["rotate", "flip", "crop", "angle"];

const normTurns = (turns) => (((Number(turns) || 0) % 4) + 4) % 4;

// What the editor has to offer right now. `normalizedCrop` is
// getNormalizedCrop()'s rect (fractions of the transformed photo) and
// `transformedSize` that photo's size — both already known to the editor.
export function describeEdits(state, normalizedCrop, transformedSize) {
  const quarterTurns = normTurns(state?.quarterTurns);
  const freeAngle = Number(state?.freeAngle) || 0;
  const isFullFrame = !normalizedCrop
    || (normalizedCrop.x <= 0.0005 && normalizedCrop.y <= 0.0005
      && normalizedCrop.width >= 0.999 && normalizedCrop.height >= 0.999);
  const sourceAspect = transformedSize?.width > 0 && transformedSize?.height > 0
    ? transformedSize.width / transformedSize.height
    : null;
  return {
    rotate: quarterTurns !== 0 ? { quarterTurns } : null,
    flip: state?.flipX || state?.flipY ? { flipX: !!state.flipX, flipY: !!state.flipY } : null,
    crop: !isFullFrame && sourceAspect
      ? { rect: { ...normalizedCrop }, sourceAspect, aspect: (normalizedCrop.width / normalizedCrop.height) * sourceAspect }
      : null,
    angle: freeAngle !== 0 ? { freeAngle } : null,
  };
}

export function availableKinds(edits) {
  return PASTE_KINDS.filter((kind) => edits?.[kind]);
}

// The clipboard is the described edits narrowed to what the user ticked.
export function buildClipboard(edits, picked) {
  const clipboard = {};
  for (const kind of PASTE_KINDS) {
    if (picked?.[kind] && edits?.[kind]) clipboard[kind] = edits[kind];
  }
  return Object.keys(clipboard).length ? clipboard : null;
}

// Largest centred box of `aspect` that stays inside a W×H photo turned by
// `degrees` under it. A w×h box fits when its rotated bounding box does:
// w|cos|+h|sin| ≤ W and w|sin|+h|cos| ≤ H.
function inscribedCentredCrop(photoWidth, photoHeight, aspect, degrees) {
  const rad = (Math.abs(degrees) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const height = Math.min(photoWidth / (aspect * cos + sin), photoHeight / (aspect * sin + cos));
  const width = height * aspect;
  return {
    x: (1 - width / photoWidth) / 2,
    y: (1 - height / photoHeight) / 2,
    width: width / photoWidth,
    height: height / photoHeight,
  };
}

// The processAndSave geometry for one target. `target` is the photo's
// DISPLAYED size (EXIF orientation applied). The target's own previous edits
// do not exist — every paste starts from the original file.
export function planForTarget(clipboard, target) {
  const quarterTurns = clipboard?.rotate?.quarterTurns ?? 0;
  const freeAngle = clipboard?.angle?.freeAngle ?? 0;
  const plan = {
    quarterTurns,
    freeAngle,
    flipX: !!clipboard?.flip?.flipX,
    flipY: !!clipboard?.flip?.flipY,
    crop: null,
  };
  let width = Number(target?.width) || 0;
  let height = Number(target?.height) || 0;
  if (!(width > 0 && height > 0)) return clipboard?.crop || freeAngle ? null : plan;
  if (quarterTurns % 2 === 1) [width, height] = [height, width];
  const targetAspect = width / height;

  const copied = clipboard?.crop;
  if (copied) {
    const sameShape = Math.abs(targetAspect / copied.sourceAspect - 1) <= SAME_ASPECT_TOLERANCE;
    // Same shape: the identical box, position included (a series from one
    // camera gets one consistent reframing). Different shape: the box cannot
    // mean the same thing, so keep its proportions and centre it.
    plan.crop = sameShape ? { ...copied.rect } : inscribedCentredCrop(width, height, copied.aspect, freeAngle);
  } else if (freeAngle !== 0) {
    // A pasted angle with no crop would leave empty corners.
    plan.crop = inscribedCentredCrop(width, height, targetAspect, freeAngle);
  }
  return plan;
}

const RASTER_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "tif", "tiff"]);

// sharp reads these; RAW and HEIC it cannot, and video is not an image.
export function canPasteOnto(asset) {
  if (!asset || asset.asset_type === "video") return false;
  const ext = String(asset.image_path || "").split(".").pop().toLowerCase();
  return RASTER_EXTENSIONS.has(ext);
}
