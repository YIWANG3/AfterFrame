// Sidecar transport — resident `serve` process with one-shot spawn fallback,
// secrets-to-env handoff, and detached job launching. Physically extracted
// from main.js (review P3-7); behavior unchanged. Everything binds to the
// catalog through getCatalogPath() at call time.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

function createSidecarTransport({ rootDir, sidecarSrc, isPackaged, resourcesPath, getCatalogPath, spawnProcess = spawn }) {
  const processes = new Set();
  const pausedCatalogs = new Set();
  const catalogGenerations = new Map();
  const generationOf = (catalogPath) => catalogGenerations.get(catalogPath) || 0;

  function trackProcess(child, catalogPath, detached = false) {
    const state = { child, catalogPath, detached };
    state.closed = new Promise((resolve) => child.once("close", () => {
      processes.delete(state);
      resolve();
    }));
    processes.add(state);
    return child;
  }

  // Resetting a catalog is different from switching away: no process may keep
  // writing to this path, and pre-reset requests must not retry into its new DB.
  async function withCatalogPaused(catalogPath, action) {
    if (pausedCatalogs.has(catalogPath)) throw new Error("catalog reset already in progress");
    pausedCatalogs.add(catalogPath);
    catalogGenerations.set(catalogPath, generationOf(catalogPath) + 1);
    try {
      const active = [...processes].filter((state) => state.catalogPath === catalogPath);
      if (residentSidecar?.catalogPath === catalogPath) stopResidentSidecar();
      await Promise.all(active.map(async (state) => {
        const kill = (signal) => {
          try {
            // Detached jobs can own preview helpers; terminate their group too.
            if (state.detached && process.platform !== "win32") process.kill(-state.child.pid, signal);
            else state.child.kill(signal);
          } catch (_) { /* already exited */ }
        };
        kill("SIGTERM");
        const timer = setTimeout(() => kill("SIGKILL"), 2000);
        try { await state.closed; } finally { clearTimeout(timer); }
      }));
      return await action();
    } finally {
      pausedCatalogs.delete(catalogPath);
    }
  }
  // Secrets must never ride on argv — `ps` shows it to every local process and
  // our transport logs would print it. The transport strips `--api-key <value>`
  // here and hands it to the child via env instead; the sidecar falls back to
  // MEDIA_WORKSPACE_API_KEY when the flag is absent. (The resident path carries
  // commands over stdin JSON, which is already invisible to `ps`.)
  function extractSecretEnv(command) {
    const sanitized = [];
    const secretEnv = {};
    for (let i = 0; i < command.length; i += 1) {
      if (command[i] === "--api-key" && i + 1 < command.length) {
        secretEnv.MEDIA_WORKSPACE_API_KEY = String(command[i + 1]);
        i += 1;
        continue;
      }
      sanitized.push(command[i]);
    }
    return { sanitized, secretEnv };
  }

  function redactCommand(command) {
    return command
      .map((arg, i) => (command[i - 1] === "--api-key" ? "***" : String(arg)))
      .join(" ");
  }

  // ---- Resident sidecar ------------------------------------------------------
  // One long-lived `serve` process per catalog answers commands over line-
  // delimited JSON, skipping the ~150ms Python spawn+import cost per call.
  // Job runners still spawn detached (launchSidecarJob); any resident failure
  // falls back to the one-shot path below.
  let residentSidecar = null; // { child, pending: Map<id,{resolve,reject,timer}>, nextId, catalogPath }

  function stopResidentSidecar() {
    if (!residentSidecar) return;
    const state = residentSidecar;
    residentSidecar = null;
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error("resident sidecar stopped"));
    }
    state.pending.clear();
    try { state.child.kill(); } catch (_) { /* already gone */ }
  }

  function ensureResidentSidecar() {
    if (process.env.AFTERFRAME_SIDECAR_RESIDENT === "0") return null;
    if (!getCatalogPath()) return null;
    if (residentSidecar && residentSidecar.catalogPath === getCatalogPath()) return residentSidecar;
    stopResidentSidecar();
    let spawned;
    try {
      const { cmd, args, env } = sidecarCommand(["serve"]);
      spawned = trackProcess(spawnProcess(cmd, args, { cwd: rootDir, env }), getCatalogPath());
    } catch (err) {
      console.warn("[sidecar:resident] failed to start:", err.message);
      return null;
    }
    const state = { child: spawned, pending: new Map(), nextId: 1, catalogPath: getCatalogPath() };
    const rl = readline.createInterface({ input: spawned.stdout });
    rl.on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) {
        console.log("[sidecar:resident] ready for", state.catalogPath);
        return;
      }
      const entry = state.pending.get(msg.id);
      if (!entry) return;
      state.pending.delete(msg.id);
      clearTimeout(entry.timer);
      state.consecutiveTimeouts = 0; // any completed response proves the server is alive
      entry.trace?.(msg.code !== 0 ? "FAILED" : "done");
      if (msg.code !== 0) {
        entry.reject(new Error(msg.error || msg.stdout || "sidecar command failed"));
      } else {
        entry.resolve((msg.stdout || "").trim());
      }
    });
    spawned.stderr.on("data", (d) => console.warn("[sidecar:resident:stderr]", String(d).slice(0, 300)));
    // Async spawn failures (ENOENT etc.) arrive as 'error' events, not throws —
    // without a handler they'd crash the whole main process.
    spawned.on("error", (err) => {
      console.warn("[sidecar:resident] process error:", err.message);
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`resident sidecar error: ${err.message}`));
      }
      state.pending.clear();
      if (residentSidecar === state) residentSidecar = null;
    });
    // Late EPIPE on stdin (child died mid-write) is likewise an async event.
    spawned.stdin.on("error", (err) => {
      console.warn("[sidecar:resident] stdin error:", err.message);
    });
    spawned.on("exit", (code) => {
      console.warn("[sidecar:resident] exited with code", code);
      for (const entry of state.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("resident sidecar exited"));
      }
      state.pending.clear();
      if (residentSidecar === state) residentSidecar = null;
    });
    residentSidecar = state;
    return state;
  }

  function callSidecarResident(command, timeoutMs) {
    const state = ensureResidentSidecar();
    if (!state) return null;
    return new Promise((resolve, reject) => {
      const id = state.nextId++;
      const startedAt = Date.now();
      // Opt-in per-command trace (E2E runs set it): the resident server is
      // strictly serial, so one slow command silently delays every caller.
      const trace = process.env.AFTERFRAME_SIDECAR_TRACE === "1"
        ? (outcome) => console.log(`[sidecar:resident] ${outcome} ${command[0]} in ${Date.now() - startedAt}ms (queued: ${state.pending.size})`)
        : () => {};
      const timer = setTimeout(() => {
        state.pending.delete(id);
        trace("TIMEOUT");
        console.error("[sidecar:resident] timeout after", timeoutMs, "ms");
        // One slow command shouldn't nuke every other in-flight request — only
        // restart the resident process after consecutive timeouts (it's likely
        // wedged at that point, not just busy).
        state.consecutiveTimeouts = (state.consecutiveTimeouts || 0) + 1;
        if (state.consecutiveTimeouts >= 2) {
          console.error("[sidecar:resident] consecutive timeouts — restarting resident server");
          stopResidentSidecar();
        }
        reject(new Error(`sidecar timed out after ${timeoutMs}ms: ${redactCommand(command)}`));
      }, timeoutMs);
      state.pending.set(id, { resolve, reject, timer, trace });
      try {
        state.child.stdin.write(JSON.stringify({ id, argv: command.map(String) }) + "\n");
      } catch (err) {
        clearTimeout(timer);
        state.pending.delete(id);
        stopResidentSidecar();
        reject(err);
      }
    });
  }

  async function callSidecarAsync(command, timeoutMs = 30000) {
    // Bind the call to the catalog it was issued against: a catalog switch
    // mid-flight rejects resident requests, and retrying via one-shot would
    // silently rebuild --catalog against the NEW path — wrong-library writes.
    const issuedCatalogPath = getCatalogPath();
    const issuedGeneration = generationOf(issuedCatalogPath);
    const assertCurrentCatalog = () => {
      if (getCatalogPath() !== issuedCatalogPath || generationOf(issuedCatalogPath) !== issuedGeneration) {
        throw new Error(`catalog switched or reset while command was in flight: ${command[0]}`);
      }
    };
    if (pausedCatalogs.has(issuedCatalogPath)) throw new Error("catalog reset in progress");
    const residentPromise = callSidecarResident(command, timeoutMs);
    if (residentPromise) {
      try {
        const result = await residentPromise;
        assertCurrentCatalog();
        return result;
      } catch (err) {
        // Genuine timeouts propagate (the command itself hung); transport-level
        // failures (process died, stopped) retry once via one-shot spawn.
        if (/timed out after/.test(err.message)) throw err;
        assertCurrentCatalog();
        console.warn("[sidecar:resident] falling back to one-shot:", err.message);
      }
    }
    assertCurrentCatalog();
    const result = await callSidecarOneShot(command, timeoutMs);
    assertCurrentCatalog();
    return result;
  }

  function callSidecarOneShot(command, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const errChunks = [];
      const { sanitized, secretEnv } = extractSecretEnv(command);
      const { cmd, args, env } = sidecarCommand(sanitized);
      console.log("[sidecar:async]", cmd, args.join(" "));
      const t0 = Date.now();
      const child = trackProcess(spawnProcess(cmd, args, { cwd: rootDir, env: { ...env, ...secretEnv } }), getCatalogPath());

      const timer = setTimeout(() => {
        console.error("[sidecar:async] TIMEOUT after", timeoutMs, "ms — killing child");
        child.kill("SIGKILL");
        reject(new Error(`sidecar timed out after ${timeoutMs}ms: ${command.join(" ")}`));
      }, timeoutMs);

      child.stdout.on("data", (data) => chunks.push(data));
      child.stderr.on("data", (data) => errChunks.push(data));
      child.on("close", (code) => {
        clearTimeout(timer);
        console.log("[sidecar:async] done in", Date.now() - t0, "ms, exit:", code);
        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString();
          console.error("[sidecar:async] stderr:", stderr.slice(0, 500));
          reject(new Error(stderr || "sidecar command failed"));
          return;
        }
        resolve(Buffer.concat(chunks).toString().trim());
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        console.error("[sidecar:async] spawn error:", err.message);
        reject(err);
      });
    });
  }

  async function callSidecarJsonAsync(command) {
    const payload = await callSidecarAsync(command);
    return payload ? JSON.parse(payload) : null;
  }

  // Sidecar: packaged = standalone binary, dev = python3 -m media_workspace
  const sidecarBin = isPackaged
    ? path.join(resourcesPath, "sidecar", "media-workspace", "media-workspace")
    : null;

  // Bundled AVFoundation video helper — the sidecar shells out to it for video
  // probe/poster/frames via this env var.
  const videoToolPath = isPackaged
    ? path.join(resourcesPath, "native", "bin", "video-tool")
    : path.join(rootDir, "apps", "desktop", "native", "bin", "video-tool");
  // People indexing is run by the sidecar so it can checkpoint jobs and write
  // catalog rows atomically. Electron resolves the packaged/dev path once and
  // passes it through the same environment boundary as video-tool.
  const peopleWorkerPath = isPackaged
    ? path.join(resourcesPath, "native", "bin", "people-worker")
    : path.join(rootDir, "apps", "desktop", "native", "bin", "people-worker");

  function sidecarCommand(command) {
    if (pausedCatalogs.has(getCatalogPath())) throw new Error("catalog reset in progress");
    if (!getCatalogPath()) {
      console.error("[sidecarCommand] No catalog is open! command:", command);
      throw new Error("No catalog is open");
    }
    if (sidecarBin) {
      console.log("[sidecarCommand] using binary:", sidecarBin, "exists:", fs.existsSync(sidecarBin));
      return {
        cmd: sidecarBin,
        args: ["--catalog", getCatalogPath(), ...command],
        env: { ...process.env, VIDEO_TOOL_PATH: videoToolPath, PEOPLE_WORKER_PATH: peopleWorkerPath },
      };
    }
    return {
      cmd: "python3",
      args: ["-m", "media_workspace", "--catalog", getCatalogPath(), ...command],
      env: { ...process.env, PYTHONPATH: sidecarSrc, VIDEO_TOOL_PATH: videoToolPath, PEOPLE_WORKER_PATH: peopleWorkerPath },
    };
  }

  function spawnDetachedSidecar(command) {
    const { sanitized, secretEnv } = extractSecretEnv(command);
    const { cmd, args, env } = sidecarCommand(sanitized);
    return trackProcess(spawnProcess(cmd, args, { cwd: rootDir, env: { ...env, ...secretEnv }, detached: true, stdio: "ignore" }), getCatalogPath(), true);
  }

  function launchSidecarJob(command) {
    const catalogPath = getCatalogPath();
    const generation = generationOf(catalogPath);
    const child = spawnDetachedSidecar(command);
    // A runner that dies before its first update_job (spawn failure, argparse
    // rejection) would leave the row 'queued' until the heartbeat reaper —
    // and the UI polling it spinning. Mark it failed so the error surfaces
    // immediately. fail-job refuses to touch rows that already finished, so
    // a nonzero exit AFTER completion can't clobber a real outcome.
    const jobIdIdx = command.indexOf("--job-id");
    const jobId = jobIdIdx >= 0 ? command[jobIdIdx + 1] : null;
    const canReportFailure = () => getCatalogPath() === catalogPath
      && generationOf(catalogPath) === generation && !pausedCatalogs.has(catalogPath);
    if (jobId) {
      child.on("exit", (code) => {
        if (code === 0 || code == null || !canReportFailure()) return;
        callSidecarJsonAsync([
          "fail-job", "--job-id", jobId,
          "--error", `sidecar job process exited with code ${code} before reporting status`,
        ]).catch(() => {});
      });
      child.on("error", () => {
        if (!canReportFailure()) return;
        callSidecarJsonAsync([
          "fail-job", "--job-id", jobId,
          "--error", "sidecar job process failed to start",
        ]).catch(() => {});
      });
    }
    child.unref();
  }

  return {
    callAsync: callSidecarAsync,
    callJsonAsync: callSidecarJsonAsync,
    launchJob: launchSidecarJob,
    stopResident: stopResidentSidecar,
    withCatalogPaused,
  };
}

module.exports = { createSidecarTransport };
