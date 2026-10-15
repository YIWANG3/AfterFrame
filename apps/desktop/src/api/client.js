// Single owner of the preload bridge (window.mediaWorkspace). Components and
// hooks import `api` from src/api — never touch window.mediaWorkspace
// directly.

let bridgeOverride = null;

export function bridge() {
  return bridgeOverride || window.mediaWorkspace || {};
}

// The web build (web.html) installs its browser bridge here at startup;
// components keep calling api.* unchanged.
export function installBridge(impl) {
  bridgeOverride = impl;
}

// A method the bridge lacks answers undefined: on the web that is how the
// desktop-only features degrade (the UI gates them with api.can / api.has).
// A call that was NOT gated looks exactly the same, so in dev each unknown
// name is reported once.
const warned = new Set();
export function invoke(method, ...args) {
  const fn = bridge()[method];
  if (typeof fn !== "function") {
    if (import.meta.env.DEV && !warned.has(method)) {
      warned.add(method);
      console.warn(`[api] ${method} is not implemented by this bridge — the call returned undefined`);
    }
    return undefined;
  }
  return fn(...args);
}
