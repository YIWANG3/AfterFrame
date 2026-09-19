const test = require("node:test");
const assert = require("node:assert/strict");
const { createTokenStore } = require("./tokens");

// A keychain stand-in: ciphertext is "v10" + the plaintext, like Chromium's
// magic prefix, and decryption can be made to fail to model a denied keychain.
function fakeSafeStorage({ available = true, denied = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`v10${s}`, "latin1"),
    decryptString: (buf) => {
      if (denied) throw new Error("keychain denied");
      const s = buf.toString("latin1");
      if (!s.startsWith("v10")) throw new Error("not ciphertext");
      return s.slice(3);
    },
  };
}

function settingsHarness(initial = {}) {
  let settings = initial;
  return {
    get: () => settings,
    readAppSettings: () => settings,
    updateAppSettings: async (mutate) => { settings = mutate(settings); return settings; },
  };
}

test("set → get round-trips through the keychain and never stores plaintext", async () => {
  const h = settingsHarness();
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), ...h, fetchLegacyToken: async () => null });
  const returned = await store.setStoredProviderConfig("gemini", { token: "sk-live", model: "m" });
  assert.equal(returned.token, "sk-live", "the caller gets the plaintext back");
  assert.notEqual(h.get().aiProviders.gemini.token, "sk-live", "settings.json holds ciphertext");
  assert.deepEqual(store.getStoredProviderConfig("gemini"), { token: "sk-live", model: "m" });
});

test("without a keychain the token is stored and read as plaintext", async () => {
  const h = settingsHarness();
  const store = createTokenStore({ safeStorage: fakeSafeStorage({ available: false }), ...h, fetchLegacyToken: async () => null });
  await store.setStoredProviderConfig("p", { token: "plain" });
  assert.equal(h.get().aiProviders.p.token, "plain");
  assert.equal(store.decryptToken("plain"), "plain");
});

test("a denied keychain reports 'no token' for real ciphertext instead of handing it to the provider", () => {
  const store = createTokenStore({ safeStorage: fakeSafeStorage({ denied: true }), readAppSettings: () => ({}), updateAppSettings: async () => {}, fetchLegacyToken: async () => null });
  const ciphertext = Buffer.from("v10secret", "latin1").toString("base64");
  assert.equal(store.decryptToken(ciphertext), null);
  // Legacy plaintext still passes through even when the keychain is unhappy.
  assert.equal(store.decryptToken("just-a-key"), "just-a-key");
});

test("migration re-encrypts a plaintext token in place", async () => {
  const h = settingsHarness({ aiProviders: { p: { token: "legacy-plain" } } });
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), ...h, fetchLegacyToken: async () => null });
  const cfg = await store.getStoredProviderConfigWithMigration("p");
  assert.equal(cfg.token, "legacy-plain");
  assert.notEqual(h.get().aiProviders.p.token, "legacy-plain", "now ciphertext");
  assert.equal(store.getStoredProviderConfig("p").token, "legacy-plain");
});

test("migration pulls a token the sidecar used to hold, once", async () => {
  const h = settingsHarness();
  let asked = 0;
  const store = createTokenStore({ safeStorage: fakeSafeStorage(), ...h, fetchLegacyToken: async () => { asked += 1; return { token: "from-sidecar" }; } });
  assert.equal((await store.getStoredProviderConfigWithMigration("p")).token, "from-sidecar");
  assert.equal((await store.getStoredProviderConfigWithMigration("p")).token, "from-sidecar");
  assert.equal(asked, 1, "second call is served from settings");
  await store.deleteStoredProviderConfig("p");
  assert.equal(store.getStoredProviderConfig("p"), null);
});
