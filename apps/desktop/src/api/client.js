// Single owner of the preload bridge (window.mediaWorkspace). Components and
// hooks import `api` from src/api — never touch window.mediaWorkspace
// directly. Tests can swap the bridge with `__setBridgeForTests`.

let bridgeOverride = null;

export function bridge() {
  return bridgeOverride || window.mediaWorkspace || {};
}

export function __setBridgeForTests(mock) {
  bridgeOverride = mock;
}

export function invoke(method, ...args) {
  const fn = bridge()[method];
  if (typeof fn !== "function") return undefined;
  return fn(...args);
}
