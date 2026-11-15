// The lightbox's bars, unpinned (its default), stay out of sight until the
// pointer comes near them, and while hidden they take no clicks. Playwright's
// click checks what is under the point before it moves the mouse, so a click
// on a hidden control would wait on the photo forever. Move the pointer onto
// the control first, as a user's hand does, and the bars come out.

const { expect } = require("@playwright/test");

const lightbox = (window) => window.locator("[data-layer='lightbox']");

async function revealLightboxControl(window, control) {
  const box = await control.boundingBox();
  if (!box) throw new Error("the lightbox control has no box");
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(lightbox(window)).not.toHaveAttribute("data-lightbox-controls-hidden");
}

async function clickLightboxControl(window, control) {
  await revealLightboxControl(window, control);
  await control.click();
}

// Pins the bars, so a spec about something else sees the lightbox as it was
// before the pin: bars always out, the stage between them.
async function pinLightboxControls(window) {
  const pin = window.getByRole("button", { name: "Pin preview controls" });
  if ((await pin.getAttribute("aria-pressed")) === "true") return;
  await clickLightboxControl(window, pin);
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(lightbox(window)).not.toHaveAttribute("data-lightbox-floating");
}

module.exports = { lightbox, revealLightboxControl, clickLightboxControl, pinLightboxControls };
