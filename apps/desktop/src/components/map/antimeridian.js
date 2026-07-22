// Antimeridian preprocessing for the offline map. MapLibre fills polygons that
// cross ±180° across the whole world unless each polygon is clipped to one
// longitude window first (validated in research/geo-overview-lab).

export function splitLandAtAntimeridian(collection) {
  const outputPolygons = [];

  for (const landFeature of collection.features) {
    const polygons = landFeature.geometry.type === "Polygon"
      ? [landFeature.geometry.coordinates]
      : landFeature.geometry.coordinates;

    for (const polygon of polygons) {
      const rings = polygon.map(unwrapLongitudeRing);
      const outerLongitudes = rings[0].map(([longitude]) => longitude);
      const minimumLongitude = Math.min(...outerLongitudes);
      const maximumLongitude = Math.max(...outerLongitudes);
      const firstWindow = Math.floor((minimumLongitude + 180) / 360);
      const lastWindow = Math.floor((maximumLongitude + 179.999999) / 360);

      for (let windowIndex = firstWindow; windowIndex <= lastWindow; windowIndex += 1) {
        const minimum = -180 + windowIndex * 360;
        const maximum = 180 + windowIndex * 360;
        const clippedOuter = clipRingToLongitudeWindow(rings[0], minimum, maximum);

        if (clippedOuter.length < 4) continue;

        const outputRings = [rewindRing(
          clippedOuter.map(([longitude, latitude]) => [longitude - windowIndex * 360, latitude]),
          true,
        )];

        for (const hole of rings.slice(1)) {
          const clippedHole = clipRingToLongitudeWindow(hole, minimum, maximum);
          if (clippedHole.length < 4) continue;
          outputRings.push(rewindRing(
            clippedHole.map(([longitude, latitude]) => [longitude - windowIndex * 360, latitude]),
            false,
          ));
        }

        outputPolygons.push(outputRings);
      }
    }
  }

  return {
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      properties: {},
      geometry: { type: "MultiPolygon", coordinates: outputPolygons },
    }],
  };
}

export function splitLinesAtAntimeridian(lineGeometry) {
  const inputLines = lineGeometry.type === "MultiLineString"
    ? lineGeometry.coordinates
    : [lineGeometry.coordinates];
  const outputLines = [];

  for (const line of inputLines) {
    let segment = [];

    for (const coordinate of line) {
      const previous = segment.at(-1);
      if (previous && Math.abs(coordinate[0] - previous[0]) > 180) {
        if (segment.length > 1) outputLines.push(segment);
        segment = [];
      }
      segment.push(coordinate);
    }

    if (segment.length > 1) outputLines.push(segment);
  }

  return { type: "MultiLineString", coordinates: outputLines };
}

function unwrapLongitudeRing(ring) {
  let offset = 0;
  let previousLongitude = ring[0][0];

  return ring.map(([longitude, latitude], index) => {
    if (index === 0) return [longitude, latitude];

    let unwrappedLongitude = longitude + offset;
    while (unwrappedLongitude - previousLongitude > 180) {
      offset -= 360;
      unwrappedLongitude -= 360;
    }
    while (unwrappedLongitude - previousLongitude < -180) {
      offset += 360;
      unwrappedLongitude += 360;
    }

    previousLongitude = unwrappedLongitude;
    return [unwrappedLongitude, latitude];
  });
}

function clipRingToLongitudeWindow(ring, minimum, maximum) {
  let clipped = clipRingAtLongitude(ring, minimum, true);
  if (clipped.length) clipped = clipRingAtLongitude(clipped, maximum, false);

  if (
    clipped.length
    && (clipped[0][0] !== clipped.at(-1)[0] || clipped[0][1] !== clipped.at(-1)[1])
  ) {
    clipped.push([...clipped[0]]);
  }

  return clipped;
}

function clipRingAtLongitude(ring, boundary, keepGreater) {
  const output = [];

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const currentInside = keepGreater ? current[0] >= boundary : current[0] <= boundary;
    const nextInside = keepGreater ? next[0] >= boundary : next[0] <= boundary;

    if (currentInside) output.push(current);
    if (currentInside === nextInside) continue;

    const progress = (boundary - current[0]) / (next[0] - current[0]);
    output.push([
      boundary,
      current[1] + (next[1] - current[1]) * progress,
    ]);
  }

  return output;
}

function rewindRing(ring, counterclockwise) {
  const isCounterclockwise = signedRingArea(ring) > 0;
  return isCounterclockwise === counterclockwise ? ring : [...ring].reverse();
}

function signedRingArea(ring) {
  let area = 0;

  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }

  return area / 2;
}
