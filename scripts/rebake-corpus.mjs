// Corpus rebake — regenerate the live-recording corpus from an ALTERNATE
// versions.json manifest by driving the A5 screenbench recorder.
//
// ============================================================================
// BLOCKED ON A5 (META-HARNESS-51 / the screenbench-recorder ticket).
// ============================================================================
// Rebake drives a TypeScript screenbench recorder — `meta-harness-screenbench-record`
// — that does NOT exist in this tree yet; it is delivered by the A5 ticket. Until
// A5 lands, this script CANNOT record anything: it detects the missing recorder
// and exits with a clear, actionable "blocked on A5" message rather than a
// fabricated recorder call. The wiring around the recorder (manifest read,
// per-(harness × scenario) fan-out, exit contract) is implemented so that
// enabling A5 is a one-line change at the marked TODO.
//
// Why an ALTERNATE versions.json: rebake pins recordings to a distinct corpus
// manifest, NOT the embedded catalog. That is why it reads via `readFrom(path)`
// (src/versions/versions.ts:131) instead of `all()` — the embedded pins drive
// the drift sentry/canary, while the rebake manifest drives which upstream
// versions get freshly recorded.
//
// Go analogue: Makefile `rebake-corpus` / `rebake-corpus-all` = 18 live
// recordings (6 scenarios × 3 harnesses). This repo has no Makefile/CI
// substrate, so rebake is expressed as a standalone script in the existing
// script family (build.mjs, verify-exports.mjs).
//
//   Manifest path:  env META_HARNESS_REBAKE_MANIFEST, else ./versions.rebake.json
//   Recorder:       env META_HARNESS_SCREENBENCH_RECORD, else `meta-harness-screenbench-record` on PATH
//
//   npm run rebake-corpus            # once A5 exists and the manifest is present
//
// EXIT CODES:
//   0 — all recordings regenerated (only reachable once A5 exists)
//   1 — error (missing/invalid manifest, recorder failure)
//   3 — BLOCKED: A5 screenbench recorder not found (distinct from a real error)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ExitOK = 0;
const ExitError = 1;
const ExitBlockedOnA5 = 3;

// The 6 canonical corpus scenarios (Go analogue). Combined with the manifest's
// pinned harnesses this is the 6 × 3 = 18 live-recording matrix.
const SCENARIOS = [
  "short-reply",
  "multi-turn",
  "tool-call",
  "long-output",
  "interrupt",
  "error-recovery",
];

// Locate the A5 recorder. Explicit override wins; otherwise probe PATH.
function locateRecorder() {
  const override = process.env.META_HARNESS_SCREENBENCH_RECORD;
  if (override && override !== "") {
    return existsSync(override) ? override : null;
  }
  const bin = "meta-harness-screenbench-record";
  const probe = spawnSync(
    process.platform === "win32" ? "where" : "which",
    [bin],
    {
      encoding: "utf8",
    },
  );
  if (probe.status === 0 && probe.stdout.trim() !== "") {
    return probe.stdout.trim().split(/\r?\n/)[0];
  }
  return null;
}

async function main() {
  // Read the ALTERNATE corpus manifest via readFrom(path) — NOT the embedded all().
  const manifestPath =
    process.env.META_HARNESS_REBAKE_MANIFEST ??
    join(root, "versions.rebake.json");

  const recorder = locateRecorder();
  if (recorder === null) {
    process.stderr.write(
      "rebake-corpus: BLOCKED ON A5 — the screenbench recorder " +
        "`meta-harness-screenbench-record` was not found.\n" +
        "  This tool depends on the A5 (META-HARNESS-51) TypeScript screenbench\n" +
        "  recorder, which is not yet in the tree. Corpus rebake cannot run until\n" +
        "  A5 lands. Set META_HARNESS_SCREENBENCH_RECORD to the recorder path once\n" +
        "  it exists, or install it on PATH.\n",
    );
    return ExitBlockedOnA5;
  }

  if (!existsSync(manifestPath)) {
    process.stderr.write(
      `rebake-corpus: manifest not found: ${manifestPath}\n` +
        "  Provide the alternate corpus versions.json (env META_HARNESS_REBAKE_MANIFEST\n" +
        "  or ./versions.rebake.json).\n",
    );
    return ExitError;
  }

  // readFrom(path) — the tooling entry point for an alternate versions.json
  // (src/versions/versions.ts). Imported from built dist, like the other scripts.
  const { readFrom } = await import(
    pathToFileURL(join(root, "dist", "versions", "index.js")).href
  );

  let manifest;
  try {
    manifest = readFrom(manifestPath);
  } catch (err) {
    process.stderr.write(
      "rebake-corpus: failed to read manifest: " +
        (err instanceof Error ? err.message : String(err)) +
        "\n",
    );
    return ExitError;
  }

  // Only pinned harnesses are rebaked — an unpinned entry has no upstream version
  // to record against.
  const harnesses = [...manifest.entries()].filter(([, e]) => e.pinned !== "");
  if (harnesses.length === 0) {
    process.stderr.write(
      "rebake-corpus: manifest has no pinned harnesses to rebake\n",
    );
    return ExitError;
  }

  let failed = 0;
  for (const [name, entry] of harnesses) {
    for (const scenario of SCENARIOS) {
      const out = join(root, "test", "corpus", name, scenario);
      // TODO(A5): once `meta-harness-screenbench-record` exists, invoke it here.
      // The Go analogue's argument shape (test/corpus/README.md) is:
      //   record --harness <name> --bin "$(which <binary>)" --out <out>
      //          --cols 120 --rows 40 --binary-version <entry.pinned>
      // Wiring is ready; this is the single line that A5 unblocks:
      const args = [
        "--harness",
        name,
        "--out",
        out,
        "--cols",
        "120",
        "--rows",
        "40",
        "--binary-version",
        entry.pinned,
      ];
      const res = spawnSync(recorder, args, { cwd: root, stdio: "inherit" });
      if (res.status !== 0) {
        failed++;
        process.stderr.write(
          `rebake-corpus: recording failed: ${name}/${scenario} (exit ${res.status})\n`,
        );
      }
    }
  }

  if (failed > 0) {
    process.stderr.write(`rebake-corpus: ${failed} recording(s) failed\n`);
    return ExitError;
  }
  process.stdout.write(
    `rebake-corpus: regenerated ${harnesses.length * SCENARIOS.length} recordings\n`,
  );
  return ExitOK;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write("rebake-corpus: fatal: " + String(err) + "\n");
    process.exit(ExitError);
  },
);
