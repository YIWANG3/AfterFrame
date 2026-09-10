import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";
import "./fonts";

// Tahoe 皮肤:桌面版去掉了系统标题栏(hiddenInset),侧栏让位与拖拽区只在 Electron 里生效
if (/Electron/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("electron");
  // Fullscreen: the window fills the screen, so the self-drawn 26px corner and
  // the traffic-light gutters go away (html.fs).
  window.mediaWorkspace?.onFullscreen?.((flag) => document.documentElement.classList.toggle("fs", flag));
}
import "./ui/scrollFlag";

// vibepin annotation overlay (dev only) — Alt+A to mark up the live UI, the
// daemon on :7331 collects feedback and Claude Code picks it up. Stripped in
// production builds (import.meta.env.DEV is false there).
// NB: don't id this "__vibepin" — a named element id becomes window.__vibepin
// (named-access), which collides with the global the overlay script uses.
if (import.meta.env.DEV && !document.getElementById("__vibepin_loader")) {
  const s = document.createElement("script");
  s.id = "__vibepin_loader";
  s.src = "http://127.0.0.1:7331/annotate.js";
  document.head.appendChild(s);
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
