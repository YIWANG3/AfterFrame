// The text panel's pure logic: the layer's flat paint fields ↔ the paint
// object the colour picker edits, merging a handwriting fill patch, and
// putting a tool's reordered layers back into the whole stack.

import { isFrameLayer } from "../layerStack";

// Map flat layer fields ↔ unified "paint" object the picker expects.
export function paintFromFields(layer, kind) {
  if (kind === "fill") {
    return {
      mode: layer.fillMode === "gradient" ? "gradient" : "solid",
      color: layer.fillColor,
      opacity: (layer.fillOpacity ?? 100) / 100,
      gradient: {
        from: layer.gradientFrom ?? "#ffffff",
        fromOpacity: (layer.gradientFromOpacity ?? 100) / 100,
        to: layer.gradientTo ?? "#d2a05a",
        toOpacity: (layer.gradientToOpacity ?? 100) / 100,
        angle: layer.gradientAngle ?? 90,
      },
    };
  }
  if (kind === "stroke") {
    return {
      mode: layer.strokeMode === "gradient" ? "gradient" : "solid",
      color: layer.strokeColor,
      opacity: 1,
      gradient: {
        from: layer.strokeGradFrom ?? layer.strokeColor ?? "#000000",
        fromOpacity: (layer.strokeGradFromOpacity ?? 100) / 100,
        to: layer.strokeGradTo ?? "#ffffff",
        toOpacity: (layer.strokeGradToOpacity ?? 100) / 100,
        angle: layer.strokeGradAngle ?? 90,
      },
    };
  }
  if (kind === "bg") {
    return {
      mode: layer.bgMode === "gradient" ? "gradient" : "solid",
      color: layer.bgColor,
      opacity: (layer.bgOpacity ?? 100) / 100,
      gradient: {
        from: layer.bgGradFrom ?? layer.bgColor ?? "#000000",
        fromOpacity: (layer.bgGradFromOpacity ?? 100) / 100,
        to: layer.bgGradTo ?? "#ffffff",
        toOpacity: (layer.bgGradToOpacity ?? 100) / 100,
        angle: layer.bgGradAngle ?? 90,
      },
    };
  }
  return null;
}

export function paintToFields(patch, kind) {
  const out = {};
  const g = patch.gradient || {};
  const set = (k, v) => { if (v !== undefined) out[k] = v; };
  if (kind === "fill") {
    set("fillMode", patch.mode);
    set("fillColor", patch.color);
    if (patch.opacity !== undefined) out.fillOpacity = Math.round(patch.opacity * 100);
    set("gradientFrom", g.from);
    if (g.fromOpacity !== undefined) out.gradientFromOpacity = Math.round(g.fromOpacity * 100);
    set("gradientTo", g.to);
    if (g.toOpacity !== undefined) out.gradientToOpacity = Math.round(g.toOpacity * 100);
    set("gradientAngle", g.angle);
  } else if (kind === "stroke") {
    set("strokeMode", patch.mode);
    set("strokeColor", patch.color);
    set("strokeGradFrom", g.from);
    if (g.fromOpacity !== undefined) out.strokeGradFromOpacity = Math.round(g.fromOpacity * 100);
    set("strokeGradTo", g.to);
    if (g.toOpacity !== undefined) out.strokeGradToOpacity = Math.round(g.toOpacity * 100);
    set("strokeGradAngle", g.angle);
  } else if (kind === "bg") {
    set("bgMode", patch.mode);
    set("bgColor", patch.color);
    if (patch.opacity !== undefined) out.bgOpacity = Math.round(patch.opacity * 100);
    set("bgGradFrom", g.from);
    if (g.fromOpacity !== undefined) out.bgGradFromOpacity = Math.round(g.fromOpacity * 100);
    set("bgGradTo", g.to);
    if (g.toOpacity !== undefined) out.bgGradToOpacity = Math.round(g.toOpacity * 100);
    set("bgGradAngle", g.angle);
  }
  return out;
}

export function mergeHandwritingPatch(base, patch) {
  const a = base || {};
  const merged = { ...a, ...patch };
  if (a.gradient || patch.gradient) merged.gradient = { ...a.gradient, ...patch.gradient };
  return merged;
}

// A tool's layer list reorders only its own layers: put them back into the
// whole stack in the slots they held, the other tool's layers untouched.
export function mergeOwnLayers(all, reorderedOwn, frameMode) {
  const queue = [...reorderedOwn];
  const kept = new Set(reorderedOwn.map((l) => l.id));
  return all
    .filter((l) => isFrameLayer(l) !== frameMode || kept.has(l.id))
    .map((l) => (isFrameLayer(l) === frameMode ? queue.shift() : l));
}
