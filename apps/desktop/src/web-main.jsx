import React from "react";
import ReactDOM from "react-dom/client";
import { installBridge } from "./api/client";
import { browserBridge } from "./api/browser/bridge";

// Install the browser bridge BEFORE app modules load: i18n reads the locale
// at import time, and several components still call window.mediaWorkspace
// directly (facade migration is incremental), so mount it there too.
installBridge(browserBridge);
window.mediaWorkspace = browserBridge;

const { default: App } = await import("./App");
await import("./i18n");
await import("./index.css");
await import("./fonts");

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
