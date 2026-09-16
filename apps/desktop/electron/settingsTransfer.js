// Settings export / import (.afsettings) — pure logic, no Electron imports.
// docs/settings-transfer-plan.md is authoritative for format and merge rules.
//
// Stored API keys are safeStorage ciphertext bound to this Mac's keychain, so
// export decrypts them here and re-encrypts with a user passphrase
// (PBKDF2-SHA256 + AES-256-GCM — both available in WebCrypto, so the web shell
// can read the same file later). Everything else is plain, inspectable JSON.

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const pbkdf2 = promisify(crypto.pbkdf2);

const FORMAT = "afterframe-settings";
const VERSION = 1;
const SECTIONS = ["general", "repaint", "annotation"];
const PBKDF2_ITERATIONS = 600_000;
const MIN_PASSPHRASE_LENGTH = 8;
const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

class TransferError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function providerList(value) {
  return Array.isArray(value) ? value.filter((p) => isObject(p) && typeof p.id === "string" && p.id) : [];
}

function styleList(value) {
  return Array.isArray(value) ? value.filter((s) => isObject(s) && typeof s.id === "string" && s.id) : null;
}

// Token namespaces a bundle's sections reference. Keys of deleted providers
// that linger in aiProviders are deliberately not carried to the new device.
function referencedTokenNamespaces(sections) {
  const namespaces = [];
  for (const p of providerList(sections?.repaint?.providers)) namespaces.push(p.id);
  for (const p of providerList(sections?.annotation?.providers)) namespaces.push(`annotation:${p.id}`);
  return namespaces;
}

/**
 * Build the plain sections plus the decrypted tokens to seal.
 * @param {object} opts
 * @param {object} opts.settings  app settings.json contents
 * @param {Array|null} opts.styles  ai-styles.json contents
 * @param {string} [opts.theme]  renderer-owned theme preference
 * @param {string[]} opts.sections  subset of SECTIONS
 * @param {boolean} opts.includeSecrets
 * @param {(stored: string) => string|null} opts.decryptToken
 */
function collectExport({ settings = {}, styles = null, theme, sections, includeSecrets, decryptToken }) {
  const wanted = new Set((sections || []).filter((s) => SECTIONS.includes(s)));
  const out = {};

  if (wanted.has("general")) {
    const general = {};
    if (typeof settings.locale === "string") general.locale = settings.locale;
    if (typeof theme === "string" && theme) general.theme = theme;
    if (isObject(settings.previews)) general.previews = clone(settings.previews);
    out.general = general;
  }

  if (wanted.has("repaint")) {
    const prefs = isObject(settings.aiPreferences) ? settings.aiPreferences : {};
    const repaint = { providers: clone(providerList(prefs.providers)) };
    if (typeof prefs.activeProvider === "string") repaint.activeProvider = prefs.activeProvider;
    if (isObject(prefs.selectedModels)) repaint.selectedModels = clone(prefs.selectedModels);
    // modelsCache is dropped: large and refetchable. ai-styles.json wins over
    // the legacy settings.aiStyles copy.
    const styleSource = styleList(styles) ?? styleList(settings.aiStyles);
    if (styleSource) repaint.styles = clone(styleSource);
    out.repaint = repaint;
  }

  if (wanted.has("annotation")) {
    const annotation = clone(isObject(settings.aiAnnotation) ? settings.aiAnnotation : {});
    annotation.providers = providerList(annotation.providers);
    out.annotation = annotation;
  }

  const tokens = {};
  const unreadable = [];
  if (includeSecrets) {
    for (const ns of referencedTokenNamespaces(out)) {
      const stored = settings.aiProviders?.[ns]?.token;
      if (!stored) continue;
      const token = decryptToken(stored);
      if (token) tokens[ns] = token;
      else unreadable.push(ns);
    }
  }
  return { sections: out, tokens, unreadable };
}

function secretsAad({ format, version, exportedAt }) {
  return Buffer.from(`${format}|${version}|${exportedAt}`, "utf-8");
}

async function deriveKey(passphrase, salt, iterations) {
  return pbkdf2(Buffer.from(String(passphrase), "utf-8"), salt, iterations, 32, "sha256");
}

async function sealSecrets(tokens, passphrase, header) {
  if (String(passphrase || "").length < MIN_PASSPHRASE_LENGTH) throw new TransferError("weak_passphrase");
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(secretsAad(header));
  const data = Buffer.concat([cipher.update(JSON.stringify({ tokens }), "utf-8"), cipher.final()]);
  return {
    kdf: { name: "PBKDF2-SHA256", iterations: PBKDF2_ITERATIONS, salt: salt.toString("base64") },
    cipher: { name: "AES-256-GCM", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") },
    count: Object.keys(tokens).length,
    data: data.toString("base64"),
  };
}

async function openSecrets(bundle, passphrase) {
  const { secrets } = bundle;
  if (!secrets) return {};
  if (!passphrase) throw new TransferError("bad_passphrase");
  try {
    const salt = Buffer.from(secrets.kdf.salt, "base64");
    const key = await deriveKey(passphrase, salt, secrets.kdf.iterations);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(secrets.cipher.iv, "base64"));
    decipher.setAAD(secretsAad(bundle));
    decipher.setAuthTag(Buffer.from(secrets.cipher.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(secrets.data, "base64")), decipher.final()]);
    const parsed = JSON.parse(plain.toString("utf-8"));
    if (!isObject(parsed?.tokens)) throw new Error("malformed secrets");
    return Object.fromEntries(Object.entries(parsed.tokens).filter(([, v]) => typeof v === "string" && v));
  } catch {
    // A wrong passphrase and a tampered file are indistinguishable under GCM.
    throw new TransferError("bad_passphrase");
  }
}

async function buildBundle({ settings, styles, theme, sections, includeSecrets, passphrase, decryptToken, appVersion, now = new Date() }) {
  const collected = collectExport({ settings, styles, theme, sections, includeSecrets, decryptToken });
  const header = { format: FORMAT, version: VERSION, exportedAt: now.toISOString() };
  const bundle = { ...header, appVersion: appVersion || null, sections: collected.sections, secrets: null };
  if (includeSecrets) bundle.secrets = await sealSecrets(collected.tokens, passphrase, header);
  return { bundle, secretCount: Object.keys(collected.tokens).length, unreadable: collected.unreadable };
}

function isValidSecrets(secrets) {
  return isObject(secrets)
    && isObject(secrets.kdf) && secrets.kdf.name === "PBKDF2-SHA256"
    && Number.isInteger(secrets.kdf.iterations) && secrets.kdf.iterations > 0 && secrets.kdf.iterations <= 10_000_000
    && typeof secrets.kdf.salt === "string"
    && isObject(secrets.cipher) && secrets.cipher.name === "AES-256-GCM"
    && typeof secrets.cipher.iv === "string" && typeof secrets.cipher.tag === "string"
    && typeof secrets.data === "string";
}

function parseBundle(text) {
  if (Buffer.byteLength(String(text), "utf-8") > MAX_BUNDLE_BYTES) throw new TransferError("invalid_file");
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    throw new TransferError("invalid_file");
  }
  if (!isObject(bundle) || bundle.format !== FORMAT || !Number.isInteger(bundle.version)) {
    throw new TransferError("invalid_file");
  }
  if (bundle.version > VERSION) throw new TransferError("newer_version");
  if (!isObject(bundle.sections) || typeof bundle.exportedAt !== "string") throw new TransferError("invalid_file");
  if (bundle.secrets != null && !isValidSecrets(bundle.secrets)) throw new TransferError("invalid_file");
  for (const key of Object.keys(bundle.sections)) {
    if (!SECTIONS.includes(key) || !isObject(bundle.sections[key])) delete bundle.sections[key];
  }
  return bundle;
}

// Renderer-safe description of a parsed bundle (never includes secrets).
function summarizeBundle(bundle, local = {}) {
  const localRepaintIds = new Set(providerList(local.aiPreferences?.providers).map((p) => p.id));
  const localAnnotationIds = new Set(providerList(local.aiAnnotation?.providers).map((p) => p.id));
  const describe = (providers, localIds) => providerList(providers).map((p) => ({
    id: p.id,
    name: typeof p.name === "string" && p.name ? p.name : p.id,
    type: typeof p.type === "string" ? p.type : null,
    conflict: localIds.has(p.id),
  }));
  const { general, repaint, annotation } = bundle.sections;
  return {
    exportedAt: bundle.exportedAt,
    appVersion: bundle.appVersion || null,
    sections: {
      general: general ? { locale: general.locale ?? null, theme: general.theme ?? null } : null,
      repaint: repaint
        ? { providers: describe(repaint.providers, localRepaintIds), styleCount: styleList(repaint.styles)?.length ?? 0 }
        : null,
      annotation: annotation ? { providers: describe(annotation.providers, localAnnotationIds) } : null,
    },
    secretCount: bundle.secrets ? Number(bundle.secrets.count) || 0 : 0,
  };
}

// Merge by id: imported entries replace same-id local ones in place, new ids
// append. Local-only entries are never removed.
function mergeById(localList, importedList) {
  const imported = providerList(importedList);
  const byId = new Map(imported.map((item) => [item.id, item]));
  const merged = providerList(localList).map((item) => (byId.has(item.id) ? byId.get(item.id) : item));
  const localIds = new Set(merged.map((item) => item.id));
  for (const item of imported) if (!localIds.has(item.id)) merged.push(item);
  return clone(merged);
}

function pickActive(localActive, importedActive, providers) {
  const ids = new Set(providers.map((p) => p.id));
  if (localActive && ids.has(localActive)) return localActive;
  if (importedActive && ids.has(importedActive)) return importedActive;
  return providers[0]?.id;
}

/**
 * Apply the chosen sections of a bundle onto local state.
 * @returns {{ settings: object, styles: Array|null, theme: string|null, locale: string|null, tokenNamespaces: string[] }}
 *   styles is null when ai-styles.json should be left untouched.
 */
function mergeBundle({ settings: localSettings = {}, styles: localStyles = null, bundle, sections }) {
  const wanted = new Set((sections || []).filter((s) => SECTIONS.includes(s) && bundle.sections[s]));
  const settings = clone(localSettings) || {};
  let styles = null;
  let theme = null;
  let locale = null;

  if (wanted.has("general")) {
    const general = bundle.sections.general;
    if (typeof general.locale === "string") locale = general.locale;
    if (typeof general.theme === "string") theme = general.theme;
    if (isObject(general.previews)) settings.previews = { ...(settings.previews || {}), ...clone(general.previews) };
  }

  if (wanted.has("repaint")) {
    const imported = bundle.sections.repaint;
    const prefs = isObject(settings.aiPreferences) ? settings.aiPreferences : {};
    const providers = mergeById(prefs.providers, imported.providers);
    const next = { ...prefs, providers };
    const active = pickActive(prefs.activeProvider, imported.activeProvider, providers);
    if (active) next.activeProvider = active;
    if (isObject(imported.selectedModels)) {
      next.selectedModels = { ...(prefs.selectedModels || {}), ...clone(imported.selectedModels) };
    }
    settings.aiPreferences = next;
    const importedStyles = styleList(imported.styles);
    if (importedStyles) {
      const base = styleList(localStyles) ?? styleList(localSettings.aiStyles) ?? [];
      styles = mergeById(base, importedStyles);
    }
  }

  if (wanted.has("annotation")) {
    const { providers: importedProviders, activeProviderId, ...scalars } = bundle.sections.annotation;
    const current = isObject(settings.aiAnnotation) ? settings.aiAnnotation : {};
    const providers = mergeById(current.providers, importedProviders);
    const next = { ...current, ...clone(scalars), providers };
    const active = pickActive(current.activeProviderId, activeProviderId, providers);
    if (active) next.activeProviderId = active;
    else delete next.activeProviderId;
    settings.aiAnnotation = next;
  }

  const importedSections = Object.fromEntries([...wanted].map((s) => [s, bundle.sections[s]]));
  return { settings, styles, theme, locale, tokenNamespaces: referencedTokenNamespaces(importedSections) };
}

module.exports = {
  FORMAT,
  VERSION,
  SECTIONS,
  MIN_PASSPHRASE_LENGTH,
  TransferError,
  collectExport,
  buildBundle,
  parseBundle,
  summarizeBundle,
  openSecrets,
  mergeBundle,
};
