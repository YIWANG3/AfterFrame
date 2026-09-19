// Provider tokens at rest: keychain-encrypted through Electron's safeStorage,
// with transparent migration of two older shapes (plaintext in settings.json,
// and tokens the sidecar used to keep). Extracted from main.js (review
// 2026-09-16 §2). Injected rather than imported so the branches — no keychain,
// keychain denied, legacy plaintext — can be driven from a test:
//   safeStorage           { isEncryptionAvailable, encryptString, decryptString }
//   readAppSettings / updateAppSettings   settings.json (aiProviders.<id>)
//   fetchLegacyToken      async (provider) => { token, ... } | null — the
//                         sidecar's old store, consulted once per provider

function createTokenStore({ safeStorage, readAppSettings, updateAppSettings, fetchLegacyToken }) {
  function encryptToken(plaintext) {
    if (!safeStorage.isEncryptionAvailable()) return plaintext;
    return safeStorage.encryptString(plaintext).toString("base64");
  }

  function decryptToken(stored) {
    if (!stored) return null;
    // If it doesn't look like base64-encoded encrypted data, treat as legacy plaintext
    if (!safeStorage.isEncryptionAvailable()) return stored;
    try {
      return safeStorage.decryptString(Buffer.from(stored, "base64"));
    } catch {
      // Chromium ciphertext carries a v10/v11 magic prefix. If this IS
      // ciphertext and decryption failed (keychain access denied — e.g. the
      // re-authorization prompt after an Electron upgrade was dismissed),
      // returning it would send raw ciphertext to the provider as a "token"
      // and surface as a baffling 401. Report "no key" instead — actionable.
      const head = Buffer.from(stored, "base64").subarray(0, 3).toString("latin1");
      if (head === "v10" || head === "v11") {
        console.warn("[tokens] stored token is encrypted but keychain decryption failed; treating as unconfigured");
        return null;
      }
      // Legacy plaintext token — return as-is
      return stored;
    }
  }

  function getStoredProviderConfig(provider) {
    const settings = readAppSettings();
    const entry = settings?.aiProviders?.[provider];
    if (!entry) return null;
    return { ...entry, token: decryptToken(entry.token) };
  }

  async function setStoredProviderConfig(provider, config) {
    const encrypted = {
      ...config,
      token: config.token ? encryptToken(config.token) : null,
    };
    await updateAppSettings((settings) => ({
      ...settings,
      aiProviders: {
        ...(settings.aiProviders || {}),
        [provider]: encrypted,
      },
    }));
    return { ...encrypted, token: config.token };
  }

  async function deleteStoredProviderConfig(provider) {
    await updateAppSettings((settings) => {
      const nextProviders = { ...(settings.aiProviders || {}) };
      delete nextProviders[provider];
      return { ...settings, aiProviders: nextProviders };
    });
  }

  async function getStoredProviderConfigWithMigration(provider) {
    const existing = getStoredProviderConfig(provider);
    if (existing?.token) {
      // Re-encrypt legacy plaintext tokens transparently
      const settings = readAppSettings();
      const raw = settings?.aiProviders?.[provider]?.token;
      if (raw && safeStorage.isEncryptionAvailable()) {
        try {
          Buffer.from(raw, "base64");
          safeStorage.decryptString(Buffer.from(raw, "base64"));
        } catch {
          // Was plaintext — re-save encrypted
          await setStoredProviderConfig(provider, { token: existing.token });
        }
      }
      return existing;
    }
    try {
      const payload = await fetchLegacyToken(provider);
      if (payload?.token) {
        const migrated = await setStoredProviderConfig(provider, payload);
        return migrated;
      }
    } catch (error) {
      console.warn("[ai-provider-token] migration lookup failed:", error);
    }
    return existing || null;
  }

  return {
    encryptToken,
    decryptToken,
    getStoredProviderConfig,
    setStoredProviderConfig,
    deleteStoredProviderConfig,
    getStoredProviderConfigWithMigration,
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  };
}

module.exports = { createTokenStore };
