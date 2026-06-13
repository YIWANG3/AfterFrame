// Minimal main-process translator for the app menu and native dialogs. The
// renderer uses react-i18next; the main process can't, so this loads the same
// kind of JSON dictionaries (shipped under electron/i18n/locales, packaged via
// the electron/**/* build glob) and does a dotted-key lookup with English
// fallback. Keys are namespaced by file: "menu.file", "dialog.relinkTitle".

const path = require("node:path");
const fs = require("node:fs");

const NAMESPACES = ["menu", "dialog"];
const FALLBACK = "en";
const cache = {};

function load(locale) {
  const dir = path.join(__dirname, "locales", locale);
  const out = {};
  for (const ns of NAMESPACES) {
    try {
      out[ns] = JSON.parse(fs.readFileSync(path.join(dir, `${ns}.json`), "utf-8"));
    } catch {
      out[ns] = null;
    }
  }
  return out;
}

function dict(locale) {
  if (!cache[locale]) cache[locale] = load(locale);
  return cache[locale];
}

// Returns a t(key) bound to `locale`, falling back to English per-key so a
// missing translation never blanks a label.
function makeT(locale) {
  const primary = dict(locale);
  const fallback = locale === FALLBACK ? primary : dict(FALLBACK);
  return (key) => {
    const dot = key.indexOf(".");
    const ns = dot === -1 ? key : key.slice(0, dot);
    const rest = dot === -1 ? "" : key.slice(dot + 1);
    const lookup = (d) => (d && d[ns] ? d[ns][rest] : undefined);
    return lookup(primary) ?? lookup(fallback) ?? key;
  };
}

module.exports = { makeT };
