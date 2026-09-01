// Corpus rebake — regenerate the live-recording corpus from an ALTERNATE
// versions.json manifest by driving the screenbench recorder.
//
// ============================================================================
// A5 (META-HARNESS-51) is DELIVERED by META-HARNESS-82. The recorder
// `meta-harness-screenbench-record` now exists in this tree (src/cli/
// screenbench-record.ts → dist/cli/screenbench-record.js, registered as a `bin`).
// This script drives it per `(harness × scenario)`. The exit-3 signal is retained
// only as a defensive "recorder unexpectedly absent" guard — it should never fire
// in a correctly-built tree; a normal run exits 0.
// ============================================================================
//
// Why an ALTERNATE versions.json: rebake pins recordings to a distinct corpus
// manifest, NOT the embedded catalog. That is why it reads via `readFrom(path)`
// (src/versions/versions.ts) instead of `all()` — the embedded pins drive the
// drift sentry/canary, while the rebake manifest drives which upstream versions
// get freshly recorded. The recorder RE-READS the same manifest independently
// (via META_HARNESS_REBAKE_MANIFEST, inherited across spawnSync) to resolve each
// harness's binary — so both sides agree on which binary produced the bytes.
//
// Scenario coverage is PER-HARNESS (see SCENARIOS): the on-disk corpus and the
// scripted-driver coverage differ per harness, so a single flat array cannot
// describe the matrix. The live matrix:
//   claude-code: multi-turn, tool-call, interrupted-mid-reply, trust-dialog (4)
//   codex:       multi-turn, tool-call                          (2)
//   pi:          (deferred — pinned so rebake iterates it, but no scripted
//                 scenario corpus and no interrupt-confirmation anchor)  (0)
// = 6 live cells. Harnesses absent from the map rebake nothing (logged, not
// silently skipped). Enabling pi / extra codex scenarios is a map + catalog edit.
//
// WHAT IS DELIBERATELY NOT HERE: the recorder's catalog can also drive nine
// claude-code DIALOG cells (question-{single,multi,review} and
// permission-mode-*), and this map lists none of them. That gap is the point,
// not an oversight. Those nine dirs on disk are HAND-CAPTURES whose meta.json
// carries prose evidence a re-record destroys — measured Shift+Tab ring
// lengths, both probed keystroke encodings, an explicit not_measured list — and
// that evidence cost a paid live session. So a dialog cell is added here PER
// SCENARIO, only after it has been driven end-to-end against the real binary
// and its output shown to replay identically to the fixture it replaces. Adding
// one also means passing --allow-overwrite for it (the recorder refuses to
// overwrite a hand-captured dir without it) and --cwd/--no-warmup for a
// pre-trusted directory. test/corpus/README.md carries the per-cell status and
// the live findings that currently block all nine; test/cli/screenbench-record.
// dialog.test.ts pins this map against the catalog so the two cannot drift.
//
// trust-dialog is the one cell with an UNTRUSTED-WORKDIR precondition: claude
// persists folder trust per absolute path, so the recorder mints a fresh temp
// directory per run and skips its trust-accepting warmup pass. Nothing is passed
// here to arrange that — it follows from the scenario's `freshWorkdir` flag.
//
//   Manifest path:  env META_HARNESS_REBAKE_MANIFEST, else ./versions.rebake.json
//   Recorder:       env META_HARNESS_SCREENBENCH_RECORD, else `meta-harness-screenbench-record` on PATH
//
//   npm run rebake-corpus            # with the manifest present
//
// EXIT CODES:
//   0 — all recordings regenerated
//   1 — error (missing/invalid manifest, recorder failure)
//   3 — recorder unexpectedly absent (defensive; should not fire in a built tree)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, basename, join } from "node:path";
import { execPath } from "node:process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ExitOK = 0;
const ExitError = 1;
const ExitRecorderAbsent = 3;

// Per-harness scenario coverage — the catalog keys the recorder can DRIVE for
// each harness (not "exists on disk": rebake creates/overwrites the output dir,
// so on-disk presence is an output, not a precondition). Harnesses absent from
// this map (pi, any unpinned/unsupported harness) rebake nothing.
const SCENARIOS = {
  "claude-code": [
    "multi-turn",
    "tool-call",
    "interrupted-mid-reply",
    "trust-dialog",
  ],
  codex: ["multi-turn", "tool-call"], // interrupt excluded: no BusyDetector/interrupt seam
  // "pi": deferred — pi is pinned so rebake iterates it, but it has no scripted
  //   scenario corpus and no interrupt-confirmation anchor. Omitted here so the
  //   `?? []` skips it BY DESIGN; enabling pi is a one-line addition once its
  //   multi-turn/tool-call recordings are validated against the real binary.
};

// Locate the recorder. Explicit override wins; otherwise probe PATH.
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
      "rebake-corpus: the screenbench recorder " +
        "`meta-harness-screenbench-record` was not found on PATH.\n" +
        "  It is delivered by META-HARNESS-82 (src/cli/screenbench-record.ts →\n" +
        "  dist/cli/screenbench-record.js). Build the tree (`npm run build`) so the\n" +
        "  bin is materialized, set META_HARNESS_SCREENBENCH_RECORD to its path, or\n" +
        "  install it on PATH.\n",
    );
    return ExitRecorderAbsent;
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

  // Ensure the recorder re-reads THIS manifest (it resolves each harness's binary
  // from it). spawnSync inherits the parent env, so propagate the resolved path.
  const childEnv = {
    ...process.env,
    META_HARNESS_REBAKE_MANIFEST: manifestPath,
  };

  // A PATH-installed bin is executable and runs directly; a `.js` override (e.g.
  // META_HARNESS_SCREENBENCH_RECORD pointing at dist/cli/screenbench-record.js,
  // which may lack the executable bit) must run under `node`.
  const recorderIsJs = /\.[mc]?js$/.test(recorder);
  const cmd = recorderIsJs ? execPath : recorder;
  const baseArgs = recorderIsJs ? [recorder] : [];

  let failed = 0;
  let recorded = 0;
  for (const [name, entry] of harnesses) {
    const wanted = SCENARIOS[name] ?? [];
    if (wanted.length === 0) {
      // Pinned but out-of-scope (e.g. pi, deferred) — skip by design, logged.
      process.stderr.write(
        `rebake-corpus: ${name} has no in-scope scenarios (deferred) — skipping\n`,
      );
      continue;
    }
    for (const scenario of wanted) {
      const out = join(root, "test", "corpus", name, scenario);
      // Drive the recorder. It derives the binary from --harness by re-reading
      // the manifest, derives the scenario name from basename(--out), probes the
      // real binary version, and cross-checks it against --binary-version.
      const args = [
        "--harness",
        name,
        "--out",
        out,
        "--scenario",
        basename(out),
        "--cols",
        "120",
        "--rows",
        "40",
        "--binary-version",
        entry.pinned,
      ];
      const res = spawnSync(cmd, [...baseArgs, ...args], {
        cwd: root,
        stdio: "inherit",
        env: childEnv,
      });
      if (res.status !== 0) {
        failed++;
        process.stderr.write(
          `rebake-corpus: recording failed: ${name}/${scenario} (exit ${res.status})\n`,
        );
      } else {
        recorded++;
      }
    }
  }

  if (failed > 0) {
    process.stderr.write(`rebake-corpus: ${failed} recording(s) failed\n`);
    return ExitError;
  }
  process.stdout.write(`rebake-corpus: regenerated ${recorded} recording(s)\n`);
  return ExitOK;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write("rebake-corpus: fatal: " + String(err) + "\n");
    process.exit(ExitError);
  },
);
