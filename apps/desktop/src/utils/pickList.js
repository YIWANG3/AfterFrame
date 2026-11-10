// A client's list of picks, as it arrives in a chat: numbers or file names
// with whatever sits between them.
//
//   1723 1746 1754
//   1723，1746、1754
//   1723 | 1746 | 1754
//   这几张：B0001723.3FR 1746 还有1754 谢谢~
//
// There is no telling which separator a client will use, so none is looked
// for. What can be part of a camera's file name (ASCII letters, digits, the
// underscore) is kept, everything else separates, and of the pieces only
// those holding a digit are keywords: "这几张", "谢谢" and "IMG" alone name no
// photo. Each keyword is then looked up as part of a file name (the sidecar's
// find-by-keywords).

// A keyword shorter than this names nothing: "12" out of "共 12 张", the
// "14" and "32" of a pasted timestamp.
export const MIN_KEYWORD_LENGTH = 3;
// More than a client picks; a paste of something else stops here.
export const MAX_KEYWORDS = 500;

// ".3FR", ".jpeg", ".CR3" after a name: 2 to 5 letters and digits with a
// letter among them. "1723.1746" keeps both numbers: that dot separates.
const EXTENSION = /(?<=[A-Za-z0-9_])\.(?=[A-Za-z0-9]{0,4}[A-Za-z])[A-Za-z0-9]{2,5}(?![A-Za-z0-9_])/g;
const NAME_PIECES = /[A-Za-z0-9_]+/g;

export function parsePickList(text) {
  // NFKC: full-width digits and letters (１７２３, typed with a Chinese IME).
  const plain = String(text || "").normalize("NFKC").replace(EXTENSION, " ");
  const keywords = [];
  const seen = new Set();
  for (const piece of plain.match(NAME_PIECES) || []) {
    const keyword = piece.replace(/^_+|_+$/g, "");
    if (keyword.length < MIN_KEYWORD_LENGTH || !/\d/.test(keyword)) continue;
    const folded = keyword.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    keywords.push(keyword);
    if (keywords.length >= MAX_KEYWORDS) break;
  }
  return keywords;
}

// What the lookup says about one keyword:
//   "none"   no photo holds it (a typo, most often)
//   "broad"  more photos than a pick names; the keyword is left out
//   "many"   several photos: all of them go in, and the count says so
//   "one"    the photo
export function pickStatus(entry, limit) {
  const count = entry?.count || 0;
  if (!count) return "none";
  if (count > limit) return "broad";
  return count > 1 ? "many" : "one";
}

// The photos a lookup found, each once, in the list's order: the keywords the
// user left ticked, minus those that found nothing or too much.
export function pickedAssetIds(entries, limit, excluded = new Set()) {
  const ids = [];
  const seen = new Set();
  for (const entry of entries || []) {
    if (excluded.has(entry.keyword.toLowerCase())) continue;
    const status = pickStatus(entry, limit);
    if (status === "none" || status === "broad") continue;
    for (const match of entry.matches || []) {
      if (seen.has(match.asset_id)) continue;
      seen.add(match.asset_id);
      ids.push(match.asset_id);
    }
  }
  return ids;
}
