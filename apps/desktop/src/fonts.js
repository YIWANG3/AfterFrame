// Bundled editor fonts (text tool / presets) — local @fontsource woff2 so the
// text tool works offline and export never races the CDN. All faces are
// SIL OFL 1.1 (see licenses/fonts-OFL.txt). Latin + Latin-Extended subsets
// only; Chinese (Noto Sans SC) intentionally stays on the Google Fonts CDN —
// bundling its slices would add 10-20MB to the installer (see index.html).
//
// UI chrome font (Outfit) is separate — local @font-face in index.css.

// Plus Jakarta Sans — default text-layer font. Full weight range + italics.
import "@fontsource/plus-jakarta-sans/latin-200.css";
import "@fontsource/plus-jakarta-sans/latin-300.css";
import "@fontsource/plus-jakarta-sans/latin-400.css";
import "@fontsource/plus-jakarta-sans/latin-500.css";
import "@fontsource/plus-jakarta-sans/latin-600.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/plus-jakarta-sans/latin-800.css";
import "@fontsource/plus-jakarta-sans/latin-ext-200.css";
import "@fontsource/plus-jakarta-sans/latin-ext-300.css";
import "@fontsource/plus-jakarta-sans/latin-ext-400.css";
import "@fontsource/plus-jakarta-sans/latin-ext-500.css";
import "@fontsource/plus-jakarta-sans/latin-ext-600.css";
import "@fontsource/plus-jakarta-sans/latin-ext-700.css";
import "@fontsource/plus-jakarta-sans/latin-ext-800.css";
import "@fontsource/plus-jakarta-sans/latin-200-italic.css";
import "@fontsource/plus-jakarta-sans/latin-300-italic.css";
import "@fontsource/plus-jakarta-sans/latin-400-italic.css";
import "@fontsource/plus-jakarta-sans/latin-500-italic.css";
import "@fontsource/plus-jakarta-sans/latin-600-italic.css";
import "@fontsource/plus-jakarta-sans/latin-700-italic.css";
import "@fontsource/plus-jakarta-sans/latin-800-italic.css";

// Inter — was listed in FONT_OPTIONS but never loaded before (silent fallback).
import "@fontsource/inter/latin-100.css";
import "@fontsource/inter/latin-200.css";
import "@fontsource/inter/latin-300.css";
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import "@fontsource/inter/latin-900.css";
import "@fontsource/inter/latin-400-italic.css";
import "@fontsource/inter/latin-700-italic.css";

// Playfair Display — same: in FONT_OPTIONS but never loaded. Needed by the
// Stacked / Gold Foil / Noir presets (700 + 600 italic).
import "@fontsource/playfair-display/latin-400.css";
import "@fontsource/playfair-display/latin-500.css";
import "@fontsource/playfair-display/latin-600.css";
import "@fontsource/playfair-display/latin-700.css";
import "@fontsource/playfair-display/latin-800.css";
import "@fontsource/playfair-display/latin-900.css";
import "@fontsource/playfair-display/latin-400-italic.css";
import "@fontsource/playfair-display/latin-600-italic.css";
import "@fontsource/playfair-display/latin-700-italic.css";

// Space Mono
import "@fontsource/space-mono/latin-400.css";
import "@fontsource/space-mono/latin-700.css";
import "@fontsource/space-mono/latin-400-italic.css";
import "@fontsource/space-mono/latin-700-italic.css";

// Caveat (no italics — the face itself is cursive)
import "@fontsource/caveat/latin-400.css";
import "@fontsource/caveat/latin-500.css";
import "@fontsource/caveat/latin-600.css";
import "@fontsource/caveat/latin-700.css";
