// Copy that names macOS things (Finder, "this Mac", ⌘) gets its Windows
// wording on Windows. Rather than a second string per key, every string is
// rewritten once at startup by the rules below, so call sites don't change,
// strings added later are covered, and macOS keeps its copy untouched.

const RULES = {
  en: [
    [/Reveal in Finder|Show in Finder/g, "Show in File Explorer"],
    [/Open in Finder/g, "Open in File Explorer"],
    [/\bFinder\b/g, "File Explorer"],
    [/\bthis Mac\b/g, "this computer"],
    [/⌘/g, "Ctrl+"],
  ],
  "zh-CN": [
    [/在\s*(?:访达|Finder)\s*中/g, "在文件资源管理器中"],
    [/访达|Finder/g, "文件资源管理器"],
    [/这台\s*Mac\s*/g, "这台电脑"], // "这台 Mac 本地" → "这台电脑本地": no Latin-word spacing left behind
    [/⌘/g, "Ctrl+"],
  ],
};

export function windowsCopy(text, locale) {
  const rules = RULES[locale] || RULES.en;
  return rules.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

function rewrite(node, locale) {
  if (typeof node === "string") return windowsCopy(node, locale);
  if (node && typeof node === "object") {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, rewrite(value, locale)]));
  }
  return node;
}

// resources: { [locale]: { [namespace]: {...} } }, as passed to i18next.
export function withPlatformCopy(resources, platform) {
  if (platform !== "win32") return resources;
  return Object.fromEntries(Object.entries(resources).map(([locale, namespaces]) => [locale, rewrite(namespaces, locale)]));
}
