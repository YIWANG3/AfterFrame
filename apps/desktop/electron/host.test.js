const test = require("node:test");
const assert = require("node:assert/strict");

const { HOST_KEYS, SERVICE_NAMES, createHost, createServices } = require("./host");

function parts(overrides = {}) {
  const all = Object.fromEntries(HOST_KEYS.map((key) => [key, { stub: key }]));
  all.services = createServices();
  return { ...all, ...overrides };
}

test("a host carries exactly the listed keys, and is frozen", () => {
  const host = createHost(parts());
  assert.deepEqual(Object.keys(host).sort(), [...HOST_KEYS].sort());
  assert.ok(Object.isFrozen(host));
  assert.throws(() => { "use strict"; host.extra = 1; }, TypeError);
  assert.throws(() => { "use strict"; host.app = null; }, TypeError);
});

test("a missing part is named, so a module never destructures undefined", () => {
  const incomplete = parts();
  delete incomplete.tasks;
  delete incomplete.media;
  assert.throws(() => createHost(incomplete), /missing tasks, media/);
});

test("an unlisted part is refused: the surface grows in host.js, not at a call site", () => {
  assert.throws(() => createHost(parts({ peopleApi: {} })), /unknown peopleApi/);
});

test("services start null, take each api once, and refuse unknown names", () => {
  const services = createServices();
  assert.deepEqual(SERVICE_NAMES.map((name) => services[name]), SERVICE_NAMES.map(() => null));
  const watcher = { start() {} };
  assert.equal(services.set("watcher", watcher), watcher);
  assert.equal(services.watcher, watcher);
  assert.throws(() => services.set("watcher", {}), /already set/);
  assert.throws(() => services.set("sidecar", {}), /unknown service "sidecar"/);
  assert.throws(() => { "use strict"; services.sidecar = {}; }, TypeError);
  // The host stays frozen while its services fill in.
  const host = createHost(parts({ services }));
  host.services.set("people", { startPeopleIndex() {} });
  assert.ok(host.services.people);
});
