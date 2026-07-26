// DOM factory + updater for photo cluster markers. MapLibre owns the outer
// element's transform (never touch it, never animate it — that's what caused
// marker drift in earlier prototypes); every visual state, hover effect and
// scale change lives on the inner __visual element.
import { localFileUrl } from "../../utils/format";

export function createMarkerElement({ onClick }) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "photo-map-marker";
  element.innerHTML = `
    <span class="photo-map-marker__visual">
      <span class="photo-map-marker__stack">
        <img class="photo-map-marker__photo photo-map-marker__photo--back" alt="" loading="lazy" decoding="async" />
        <img class="photo-map-marker__photo photo-map-marker__photo--middle" alt="" loading="lazy" decoding="async" />
        <img class="photo-map-marker__photo photo-map-marker__photo--front" alt="" loading="lazy" decoding="async" />
        <span class="photo-map-marker__count"></span>
      </span>
    </span>
  `;
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick?.(element.__markerData);
  });
  return element;
}

function setPhoto(img, previewPath) {
  const src = previewPath ? localFileUrl(previewPath) : "";
  if (img.dataset.src === src) return;
  img.dataset.src = src;
  if (src) {
    img.src = src;
    img.style.visibility = "";
  } else {
    img.removeAttribute("src");
    img.style.visibility = "hidden";
  }
}

export function updateMarkerElement(element, { count, previews, label }) {
  element.__markerData = element.__markerData || {};
  const photos = element.querySelectorAll(".photo-map-marker__photo");
  setPhoto(photos[2], previews[0]);
  setPhoto(photos[1], previews[1]);
  setPhoto(photos[0], previews[2]);
  const countEl = element.querySelector(".photo-map-marker__count");
  const compact = count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
  if (countEl.textContent !== compact) countEl.textContent = compact;
  countEl.style.display = count > 1 ? "" : "none";
  element.setAttribute("aria-label", label);
}

// Stable representative order: rating first, newest capture next, asset_id as
// the final tiebreak — so cluster covers never shuffle while zooming.
export function sortPointsForCover(points) {
  return [...points].sort((a, b) => {
    const ratingDelta = (b.app_rating || 0) - (a.app_rating || 0);
    if (ratingDelta) return ratingDelta;
    const timeA = a.capture_time || "";
    const timeB = b.capture_time || "";
    if (timeA !== timeB) return timeA < timeB ? 1 : -1;
    return a.asset_id < b.asset_id ? -1 : 1;
  });
}
