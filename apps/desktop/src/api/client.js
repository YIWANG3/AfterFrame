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

export function invoke(method, ...args) {
  const fn = bridge()[method];
  if (typeof fn !== "function") return undefined;
  return fn(...args);
}
