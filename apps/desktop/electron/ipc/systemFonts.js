// The font families installed on this machine, for the editor's text tool.
// Asked of the OS: AppKit through osascript (JXA) on macOS — more reliable
// than a swift CLI — and System.Drawing through PowerShell on Windows.
// Anything else, and any failure, is an empty list.

const MAC_SCRIPT = 'ObjC.import("AppKit"); const mgr = $.NSFontManager.sharedFontManager; const arr = mgr.availableFontFamilies; '
  + 'const r = []; for (let i = 0; i < arr.count; i++) r.push(arr.objectAtIndex(i).js); r.sort().join("\\n")';
const WINDOWS_SCRIPT = "[System.Reflection.Assembly]::LoadWithPartialName('System.Drawing') | Out-Null; "
  + "(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";

const COMMANDS = {
  darwin: {
    command: `osascript -l JavaScript -e '${MAC_SCRIPT}'`,
    options: { maxBuffer: 10 * 1024 * 1024, timeout: 10000 },
    separator: "\n",
  },
  win32: {
    command: `powershell -Command "${WINDOWS_SCRIPT}"`,
    // Without it a terminal window flashes up while PowerShell runs.
    options: { maxBuffer: 10 * 1024 * 1024, windowsHide: true },
    separator: "\r\n",
  },
};

function defaultRun() {
  const { exec } = require("node:child_process");
  const { promisify } = require("node:util");
  return promisify(exec);
}

// run(command, options) → { stdout }; injected by the unit test.
async function listSystemFonts({ platform = process.platform, run = defaultRun() } = {}) {
  const spec = COMMANDS[platform];
  if (!spec) return [];
  try {
    const { stdout } = await run(spec.command, spec.options);
    return stdout.trim().split(spec.separator).filter(Boolean);
  } catch {
    return [];
  }
}

function register({ ipcMain, platform, run }) {
  ipcMain.handle("workspace:list-system-fonts", () => listSystemFonts({ platform, run }));
}

module.exports = { register, listSystemFonts };
