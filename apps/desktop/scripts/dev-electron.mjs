// `npm run dev` starts Vite and Electron under `concurrently -k`, which tears
// everything down as soon as one of them exits. That rules out app.relaunch()
// for "restart the main process": the old Electron exits, Vite is killed, and
// the new window opens onto a dead dev server. So Electron runs under this
// wrapper instead, and asks for a restart by exiting with RESTART_CODE; the
// wrapper starts it again without ever exiting itself. Any other exit code is
// passed through, so quitting the app still ends the dev session.
import { spawn } from "node:child_process";
import electronPath from "electron";

export const RESTART_CODE = 75;

function run() {
  const child = spawn(electronPath, ["."], { stdio: "inherit", env: process.env });
  child.on("exit", (code, signal) => {
    if (code === RESTART_CODE) {
      console.log("[dev] restarting the Electron main process");
      run();
      return;
    }
    process.exit(signal ? 1 : code ?? 0);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => child.kill(sig));
}

run();
