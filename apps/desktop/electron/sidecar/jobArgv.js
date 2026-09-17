// The single place that knows how to build argv for the detached `run-*-job`
// sidecar runners. commands.js owns the request/response verbs (one-shot or
// resident `serve` calls); this file owns the six job launchers, which are
// spawned detached via transport.launchJob and report back through the jobs
// table instead of stdout.
//
// Until review 2026-09-16 §1 each launch site (tasks.js, ipc/annotation.js,
// ipc/people.js) hand-built its own argv — the same drift that commands.js
// was created to stop for the verbs. Every flag emitted here is pinned to the
// argparse definition in services/sidecar/src/media_workspace/cli.py by
// jobArgv.test.js, so a renamed or removed flag fails the unit run instead of
// surfacing as an argparse rejection in a detached process.
//
// Rules: pure functions, no I/O, no validation of business state (callers
// decide whether a job may start; this only knows how to spell it). Values
// are stringified here so callers can pass numbers/booleans as they are.
// `--api-key` stays in argv on purpose: transport.extractSecretEnv moves it
// into MEDIA_WORKSPACE_API_KEY before spawning so it never reaches `ps`.

function pushIf(argv, flag, value) {
  if (value === null || value === undefined || value === "") return;
  argv.push(flag, String(value));
}

function pushEach(argv, flag, values) {
  for (const value of values || []) {
    if (value === null || value === undefined || value === "") continue;
    argv.push(flag, String(value));
  }
}

function enrichmentJob({ jobId }) {
  return ["run-enrichment-job", "--job-id", String(jobId)];
}

function importJob({ jobId, mode, rawDirs, imageDirs, generateHd, respectTombstones }) {
  const argv = ["run-import-job", "--job-id", String(jobId), "--mode", String(mode)];
  // HD (2000px) previews are opt-in — Settings ▸ Library. Off by default.
  if (generateHd === true) argv.push("--generate-hd");
  // Auto imports (watched dirs live + catch-up) must not resurrect files the
  // user removed from the catalog but left on disk. Manual imports omit this
  // so an explicit re-import clears the tombstone.
  if (respectTombstones === true) argv.push("--respect-tombstones");
  pushEach(argv, "--raw-dir", rawDirs);
  pushEach(argv, "--image-dir", imageDirs);
  return argv;
}

function previewJob({ jobId, kind = "preview", assetType = "image" }) {
  return ["run-preview-job", "--job-id", String(jobId), "--kind", String(kind), "--asset-type", String(assetType)];
}

function aiRepaintJob({
  jobId, provider, inputPath, outputPath, originPath, prompt,
  aspectRatio, imageSize, temperature, model, baseUrl, apiKey,
}) {
  const argv = [
    "run-ai-repaint-job",
    "--job-id", String(jobId),
    "--provider", String(provider),
    "--input", String(inputPath),
    "--output", String(outputPath),
    "--origin-path", String(originPath ?? inputPath),
    "--prompt", String(prompt),
  ];
  pushIf(argv, "--aspect-ratio", aspectRatio);
  pushIf(argv, "--image-size", imageSize);
  if (typeof temperature === "number" && Number.isFinite(temperature)) argv.push("--temperature", String(temperature));
  pushIf(argv, "--model", model);
  pushIf(argv, "--base-url", baseUrl);
  pushIf(argv, "--api-key", apiKey);
  return argv;
}

function textImageJob({
  jobId, provider, outputPath, prompt,
  aspectRatio, imageSize, quality, model, baseUrl, refImagePath, apiKey,
}) {
  const argv = [
    "run-text-image-job",
    "--job-id", String(jobId),
    "--provider", String(provider),
    "--output", String(outputPath),
    "--prompt", String(prompt),
  ];
  pushIf(argv, "--aspect-ratio", aspectRatio);
  pushIf(argv, "--image-size", imageSize);
  pushIf(argv, "--quality", quality);
  pushIf(argv, "--model", model);
  pushIf(argv, "--base-url", baseUrl);
  pushIf(argv, "--ref-image", refImagePath);
  pushIf(argv, "--api-key", apiKey);
  return argv;
}

// `settings` is the aiAnnotation subtree of app settings (languages, maxTags,
// maxCaptionChars, customInstructions, videoFrameInterval, maxWorkers); unset
// or out-of-range fields fall through to the sidecar's argparse defaults.
function annotationJob({
  jobId, provider, model, apiKey, baseUrl, reannotate, assetIds, collectionId, settings,
}) {
  const argv = [
    "run-annotation-job",
    "--job-id", String(jobId),
    "--provider", String(provider),
    "--model", String(model ?? ""),
  ];
  pushIf(argv, "--api-key", apiKey);
  pushIf(argv, "--base-url", baseUrl);
  if (reannotate === true) argv.push("--reannotate");
  if (Array.isArray(assetIds) && assetIds.length) argv.push("--asset-ids", assetIds.map(String).join(","));
  pushIf(argv, "--collection-id", collectionId);
  const s = settings || {};
  if (Array.isArray(s.languages) && s.languages.length) argv.push("--languages", s.languages.join(","));
  if (Number.isFinite(s.maxTags)) argv.push("--max-tags", String(s.maxTags));
  if (Number.isFinite(s.maxCaptionChars)) argv.push("--max-caption-chars", String(s.maxCaptionChars));
  pushIf(argv, "--custom-instructions", s.customInstructions);
  // Video frame sampling interval (seconds). 0 / unset → default 3 frames.
  if (Number.isFinite(s.videoFrameInterval) && s.videoFrameInterval > 0) {
    argv.push("--video-frame-interval", String(s.videoFrameInterval));
  }
  if (Number.isFinite(s.maxWorkers) && s.maxWorkers > 0) argv.push("--max-workers", String(s.maxWorkers));
  return argv;
}

function peopleIndexJob({ jobId, modelId, modelVersion, modelPath, manifestHash, assetIds }) {
  const argv = [
    "run-people-index-job",
    "--job-id", String(jobId),
    "--model-id", String(modelId),
    "--model-version", String(modelVersion),
    "--model-path", String(modelPath),
    "--manifest-hash", String(manifestHash),
  ];
  pushEach(argv, "--asset-id", assetIds);
  return argv;
}

module.exports = {
  enrichmentJob,
  importJob,
  previewJob,
  aiRepaintJob,
  textImageJob,
  annotationJob,
  peopleIndexJob,
};
