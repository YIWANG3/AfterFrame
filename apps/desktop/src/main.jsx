import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";
import "./index.css";
import "./fonts";

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
