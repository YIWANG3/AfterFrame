// Handwriting sticker style presets.
//
// Each preset is a PAIR produced by this app's own pipeline (no third-party
// assets): a bundled reference image (handwriting-presets/<id>.png,
// extraResources) plus a style description distilled from the inspiration
// research. Clicking a preset sends the reference through the image path AND
// fills the prompt box with the description — the "v2" recipe, which beat
// both prompt-only and reference-only generation on fidelity (2026-08).
//
// To replace a preset: overwrite handwriting-presets/<id>.png (reference),
// src/assets/handwriting-styles/<id>.png (thumb), and update `desc` here.

import thumbSigDash from "../../../assets/handwriting-styles/sigDash.png";
import thumbChalkFine from "../../../assets/handwriting-styles/chalkFine.png";
import thumbPenCursive from "../../../assets/handwriting-styles/penCursive.png";
import thumbInkArt from "../../../assets/handwriting-styles/inkArt.png";
import thumbWindFlow from "../../../assets/handwriting-styles/windFlow.png";
import thumbGracefulScript from "../../../assets/handwriting-styles/gracefulScript.png";
import thumbBoldRomantic from "../../../assets/handwriting-styles/boldRomantic.png";
import thumbVintageBrush from "../../../assets/handwriting-styles/vintageBrush.png";
import thumbGuofengTitle from "../../../assets/handwriting-styles/guofengTitle.png";
import thumbHealingCalli from "../../../assets/handwriting-styles/healingCalli.png";
import thumbDryChalk from "../../../assets/handwriting-styles/dryChalk.png";
import thumbSharpPen from "../../../assets/handwriting-styles/sharpPen.png";
import thumbWildInk from "../../../assets/handwriting-styles/wildInk.png";
import thumbJournalSoft from "../../../assets/handwriting-styles/journalSoft.png";
import thumbAiryThin from "../../../assets/handwriting-styles/airyThin.png";
import thumbBrushScript from "../../../assets/handwriting-styles/brushScript.png";
import thumbMonoScript from "../../../assets/handwriting-styles/monoScript.png";

const BAN_ZH =
  "画面中只有这几个字，不要印章、不要落款、不要英文、不要任何装饰元素、不要阴影。";
const BAN_EN =
  " The image contains ONLY these words — no seals, no extra signatures, no decorations, no shadows, no other elements.";

// Layout clause: long punctuated text breaks into two staggered lines, short
// text stays on one line. Deliberately no marker-character instruction — the
// UI converts the user's "/" into a comma before substitution, because models
// tend to DRAW any symbol the prompt talks about.
const LAYOUT_ZH =
  "排版：若文字较长或含有逗号、句号等标点，请在标点处自然断为两行、自由错落排布；短文字则横排单行。";
const LAYOUT_EN =
  " Layout: break longer punctuated text naturally into two staggered lines at the punctuation; keep short text on a single line.";

// The user-facing "/" line-break shorthand becomes an ordinary comma before it
// ever reaches the prompt (comma triggers the auto two-line layout above).
export function normalizeHandwritingText(text) {
  const t = String(text || "").trim();
  if (!t.includes("/")) return t;
  const joiner = isCjkText(t) ? "，" : ", ";
  return t.split("/").map((part) => part.trim()).filter(Boolean).join(joiner);
}

export function isCjkText(text) {
  return /[㐀-鿿぀-ヿ가-힯]/.test(String(text || ""));
}

export const HANDWRITING_STYLES = [
  {
    id: "sigDash",
    thumb: thumbSigDash,
    lang: "zh",
    desc: "黑色硬笔潇洒手写字体，运笔顿挫分明，笔画粗细对比强烈，笔画长短随机错落，部分笔画大幅拉长延伸长尾拖笔，部分笔画短促紧凑，字形自由不规则、疏密随性，利落随笔签名风，2D 平面线条，高对比度纯黑白，无阴影，无纸张肌理，无边框，文字居中构图。",
  },
  {
    id: "chalkFine",
    thumb: thumbChalkFine,
    lang: "zh",
    desc: "优雅纤细粉笔风手写体，笔触带颗粒感，纤细利落，笔画走线流畅有力，带有手写的洒脱效果，字形轻盈简约，笔画连接自然流畅，具有强烈的艺术性和动感，每个字都显得自由不羁，线条利落，复古质感，书写优雅自然。",
  },
  {
    id: "penCursive",
    thumb: thumbPenCursive,
    lang: "zh",
    desc: "硬笔钢笔行草手写字体，整体向右上方微斜，字形狂放洒脱，连笔衔接自然流畅，充满随性不羁的手写签名感。笔画提按反差强烈，粗细变化分明：顿笔处厚重扎实，行笔处纤细利落，收笔带出尖锐凌厉的笔锋；长笔画舒展外放，笔触带有轻微的钢笔书写枯笔肌理，笔画边缘保留手写原生的细微质感，无平滑圆润处理，兼具力量感与书写韵律，画面干净锐利，还原真实硬笔书法的手写质感。",
  },
  {
    id: "inkArt",
    thumb: thumbInkArt,
    lang: "zh",
    desc: "文艺毛笔手写艺术字体设计，极强的艺术写作风格，视觉震撼，笔画增加水墨笔刷效果，笔画巧妙延长设计变形。",
  },
  {
    id: "windFlow",
    thumb: thumbWindFlow,
    lang: "zh",
    desc: "飘逸灵动的手写体笔触，部分笔画收尾处上扬或者拉长，似被风肆意吹拂，彰显出洒脱与自由。",
  },
  {
    id: "gracefulScript",
    thumb: thumbGracefulScript,
    lang: "zh",
    desc: "黑色软笔秀丽笔手写行书，笔画纤细灵动，提按过渡柔和，收笔带出尖锐飘逸的长笔锋，长拖笔舒展流畅，线条顺滑，有细微毛边、无枯笔飞白；字形潇洒松弛，充满温柔的手写韵律感，整体风格浪漫治愈，平涂单色无渐变，画面干净高清。",
  },
  {
    id: "boldRomantic",
    thumb: thumbBoldRomantic,
    lang: "zh",
    desc: "字体笔触粗犷洒脱，带有飞白与线条延伸设计，营造出自由且略带孤勇的浪漫氛围。",
  },
  {
    id: "vintageBrush",
    thumb: thumbVintageBrush,
    lang: "zh",
    desc: "复古文艺字体设计，纤细毛笔行书，收笔带出尖锐飘逸的长笔锋，长拖笔舒展流畅，墨色浓淡自然，有飞白和枯笔效果。",
  },
  {
    id: "guofengTitle",
    thumb: thumbGuofengTitle,
    lang: "zh",
    desc: "现代设计感毛笔手写艺术字，非传统行书；浓黑墨色，笔触带有自然枯笔飞白肌理，笔画粗细悬殊，首尾笔画做夸张拉长拖笔处理，笔锋锐利舒展；画面聚焦文字本身，高级治愈的国风手写标题质感，高清无杂色。",
  },
  {
    id: "healingCalli",
    thumb: thumbHealingCalli,
    lang: "zh",
    desc: "柔和治愈的手写书法字体，慢生活手写感，笔触自然随性，整体色调干净清新。",
  },
  {
    id: "dryChalk",
    thumb: thumbDryChalk,
    lang: "zh",
    desc: "干粉笔质感手写文字，最后一笔拉伸延长，潇洒随性手写，运笔顿挫分明，笔画粗细对比强烈，笔画长短随机错落，超长飘逸延伸拖笔，长短线条交织，字形自由不规则，干涩磨砂笔触感，带有自然毛边，横向舒展排版，2D 平面线条，高对比度纯黑白，无阴影，无纸张肌理，无边框，文字居中构图。",
  },
  {
    id: "sharpPen",
    thumb: thumbSharpPen,
    lang: "zh",
    desc: "硬笔钢笔行书，整体向右上方自然扬起，字形张扬洒脱，连笔过渡自然。笔画提按顿挫感极强，粗细反差鲜明：起笔顿笔厚重扎实，行笔收细利落，收笔带出尖锐锋利的笔锋；笔触带有轻微的钢笔枯笔肌理，笔画边缘保留手写的细微毛边质感，无圆润钝化，充满手写书法的力量感与张力，随性潇洒的签名式手写风格，画面高清干净。",
  },
  {
    id: "wildInk",
    thumb: thumbWildInk,
    lang: "zh",
    desc: "中国风水墨书法设计，现代创意手写体，狂草风格，笔触生涩有力，带有明显的枯笔和飞白效果。极端的粗细对比，部分笔画厚重如墨块，部分笔画极细且拉长，线条边缘不平整，具有顿挫感，非流畅圆润风格。字号大小错落有致，自由散漫的构图，字间距不规则，视觉冲击力强。浓黑墨迹，高对比度，极简主义平面设计。",
  },
  {
    id: "journalSoft",
    thumb: thumbJournalSoft,
    lang: "zh",
    desc: "粗头软笔手写字体，拙趣治愈系手写风格，笔画圆润钝感，无尖锐锋利笔锋，提按粗细变化柔和自然，线条松弛随性，带着手写的温度与轻微的笨拙感，字形不刻板工整，充满手账式氛围感，末字笔画延伸出修长顺滑的弧形长尾拖笔，整体画面干净柔和，日系松弛感，低对比度温柔质感。",
  },
  {
    id: "airyThin",
    thumb: thumbAiryThin,
    lang: "zh",
    desc: "细头硬笔手写行书，整体向右微微上扬；长笔画极致舒展飘逸，部分竖画纵向拉长，字形松弛灵动，错落有致。笔画纤细均匀，提按过渡柔和，收笔带出锐利细长的笔锋，线条干净利落，无粗重顿笔、无枯笔飞白，笔画边缘清晰平滑，自带轻盈的手写氛围感，极简文艺风格，画面干净高清。",
  },
  {
    id: "brushScript",
    thumb: thumbBrushScript,
    lang: "en",
    desc: "Bold expressive brush script lettering with thick black strokes and dry-brush texture, energetic and free-flowing.",
  },
  {
    id: "monoScript",
    thumb: thumbMonoScript,
    lang: "en",
    desc: "Casual thin monoline script handwriting, loose and friendly, even stroke weight.",
  },
];

// The "v2" recipe: reference image + the preset's distilled style description.
export function promptForPreset(style, textPlaceholder = "{text}") {
  if (style.lang === "en") {
    return (
      `This is a handwriting style reference image. Carefully imitate every characteristic of the reference handwriting and write the words "${textPlaceholder}" in exactly that style. ` +
      `Style details (matching the reference): ${style.desc} ` +
      `Pure white background, pure black lettering.${LAYOUT_EN} Do not keep any of the reference image's original words; ignore any seals or signatures in the reference.${BAN_EN}`
    );
  }
  return (
    `这是一张手写字体风格参考图。请仔细模仿参考图中笔迹的全部风格特征，用与参考完全一致的风格书写文字：「${textPlaceholder}」。` +
    `风格细节（与参考图一致）：${style.desc}` +
    `纯白背景，纯黑色字。${LAYOUT_ZH}不要保留参考图原有的文字，忽略参考图中的印章、署名、引号等非文字元素。${BAN_ZH}`
  );
}

// Generic reference prompt — used for user-uploaded reference images. `lang`
// may be passed explicitly when `text` is a template placeholder.
export function promptForReference(text, lang) {
  const t = String(text || "").trim();
  const zh = lang ? lang === "zh" : isCjkText(t);
  if (zh) {
    return (
      `这是一张手写字体风格参考图。请仔细模仿参考图中笔迹的全部风格特征：笔画的粗细与提按变化、笔触质感、` +
      `字形结构与大小错落、整体倾斜姿态和字距节奏，用与参考完全一致的风格书写文字：「${t}」。` +
      `不要写成标准书法或印刷字体，保持参考图原有的随性程度。纯白背景，纯黑色字。${LAYOUT_ZH}` +
      `不要保留参考图原有的文字，忽略参考图中的印章、署名等非文字元素。${BAN_ZH}`
    );
  }
  return (
    `This is a handwriting style reference image. Carefully imitate EVERY characteristic of the reference handwriting: ` +
    `stroke weight and pressure variation, brush/pen texture, letterform structure and size irregularity, overall slant and spacing rhythm. ` +
    `Write the words "${t}" in exactly that style — do NOT normalize it into standard calligraphy or a printed font; keep the reference's looseness. ` +
    `Pure white background, pure black lettering.${LAYOUT_EN} Do not keep any of the reference image's original words; ignore any seals or signatures in the reference.${BAN_EN}`
  );
}

// Wider bands render strokes at higher effective resolution and cost fewer
// tokens; short single-line text fits 3:1, longer lines drop back to 16:9.
export function aspectForText(text) {
  const raw = String(text || "").replace(/\s/g, "");
  // Manual "/" line break → multi-line output → wide band doesn't fit.
  if (raw.includes("/")) return "16:9";
  const units = isCjkText(raw) ? raw.length : Math.ceil(raw.length / 3);
  return units <= 6 ? "3:1" : "16:9";
}

// Recommended per-provider defaults for handwriting. gpt-image-2 tracks
// reference images most faithfully; Gemini flash is fastest for quick drafts.
export const TEXT_IMAGE_DEFAULT_MODELS = {
  nanobanana: "gemini-3.1-flash-image",
  openai: "gpt-image-2",
  openai_compatible: "gpt-image-2",
  jimeng: "jimeng_seedream46_cvtob",
  ark: "doubao-seedream-5-0-pro-260628",
};

// "mock" renders locally in the sidecar (no API key). It can't be created from
// the provider UI — e2e specs inject it via the settings file.
export const TEXT_IMAGE_CAPABLE_TYPES = new Set([
  "nanobanana",
  "openai",
  "openai_compatible",
  "jimeng",
  "ark",
  "mock",
]);
