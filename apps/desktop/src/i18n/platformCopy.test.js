import { describe, expect, it } from "vitest";
import { windowsCopy, withPlatformCopy } from "./platformCopy";

describe("platform copy", () => {
  it("rewrites macOS names into their Windows equivalents", () => {
    expect(windowsCopy("Reveal in Finder", "en")).toBe("Show in File Explorer");
    expect(windowsCopy("Open in Finder", "en")).toBe("Open in File Explorer");
    expect(windowsCopy("Settings (⌘,)", "en")).toBe("Settings (Ctrl+,)");
    expect(windowsCopy("It only accepts connections from this Mac.", "en")).toBe("It only accepts connections from this computer.");
    expect(windowsCopy("在访达中显示", "zh-CN")).toBe("在文件资源管理器中显示");
    expect(windowsCopy("在 Finder 中显示", "zh-CN")).toBe("在文件资源管理器中显示");
    expect(windowsCopy("仅在这台 Mac 本地运行。", "zh-CN")).toBe("仅在这台电脑本地运行。");
    expect(windowsCopy("设置 (⌘,)", "zh-CN")).toBe("设置 (Ctrl+,)");
  });

  it("leaves other text alone, including the word Mac on its own", () => {
    expect(windowsCopy("Download for Mac and Windows", "en")).toBe("Download for Mac and Windows");
    expect(windowsCopy("Import a custom Core ML model", "en")).toBe("Import a custom Core ML model");
  });

  it("rewrites every namespace on Windows and nothing on macOS", () => {
    const resources = {
      en: { inspector: { reveal: "Reveal in Finder" }, nav: { sidebar: { settingsTip: "Settings (⌘,)" } } },
      "zh-CN": { inspector: { reveal: "在访达中显示" } },
    };
    expect(withPlatformCopy(resources, "darwin")).toBe(resources);
    const win = withPlatformCopy(resources, "win32");
    expect(win.en.inspector.reveal).toBe("Show in File Explorer");
    expect(win.en.nav.sidebar.settingsTip).toBe("Settings (Ctrl+,)");
    expect(win["zh-CN"].inspector.reveal).toBe("在文件资源管理器中显示");
    expect(resources.en.inspector.reveal).toBe("Reveal in Finder");
  });
});
