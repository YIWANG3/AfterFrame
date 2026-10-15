import React from "react";
import ReactDOM from "react-dom/client";
import { installBridge } from "./api/client";
import { browserBridge } from "./api/browser/bridge";

// Install the browser bridge BEFORE app modules load: i18n reads the locale
// at import time. Every component reaches it through api.* (ESLint forbids
// window.mediaWorkspace outside src/api); it goes on window.mediaWorkspace
// too for the e2e-web specs, which drive the bridge directly.
installBridge(browserBridge);
window.mediaWorkspace = browserBridge;

const { default: App } = await import("./App");
const { default: i18n } = await import("./i18n");
await import("./index.css");
await import("./ui/scrollFlag");
await import("./fonts");

// Keep <html lang> in sync with the active locale (a11y / font selection).
document.documentElement.lang = i18n.language;
i18n.on("languageChanged", (lng) => { document.documentElement.lang = lng; });

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
