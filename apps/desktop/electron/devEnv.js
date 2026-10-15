// Dev convenience: keychain-encrypted provider tokens saved by the PACKAGED
// app are unreadable from the dev binary (different Safe Storage keychain
// item), so in dev the API keys also come from the repo-root .env — the
// sidecar providers already fall back to these env vars when no --api-key is
// passed. Never runs in the packaged app, and never overrides existing env.

const fs = require("node:fs");

// Some providers read their key under another name than the .env uses.
const ALIASES = [
  // Sidecar's Jimeng fallback reads the Volcengine names.
  ["VOLC_ACCESSKEY", "JIMENG_API_KEY"],
  ["VOLC_SECRETKEY", "JIMENG_API_SECRET"],
  // Ark (Seedream) — accept either name for the same key.
  ["ARK_API_KEY", "SEEDREAM_API_KEY"],
];

function loadDevEnv(envFile, env = process.env) {
  try {
    for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match && !env[match[1]]) env[match[1]] = match[2].trim();
    }
  } catch { /* no .env — fine */ }
  for (const [wanted, alias] of ALIASES) {
    if (!env[wanted] && env[alias]) env[wanted] = env[alias];
  }
  return env;
}

module.exports = { loadDevEnv };
