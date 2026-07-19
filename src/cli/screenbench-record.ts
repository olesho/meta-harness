#!/usr/bin/env node
// meta-harness `screenbench-record` CLI — the generic live PTY corpus recorder.
//
// This is A5 (META-HARNESS-51): the shipped, Node-run, PATH-resolvable recorder
// that `scripts/rebake-corpus.mjs` drives per `(harness × scenario)` to
// regenerate the live-recording corpus. It is the generalization of the
// dev-only, bun-run `test/corpus/tools/record-scenarios.ts` claude-code driver:
// same output triple (bytes.raw + meta.json + expected.txt) and same per-turn
// completion loop, but driven through the production seams so it can also record
// codex — resolveAdapter (completion predicate), readyForInput /
// requiresPromptReadiness (readiness gate), submitKeyForHarness (Enter key), and
// resolveBinary / PtyProcess (PTY plumbing).
//
// Runs under NODE, not bun: `dist/cli/screenbench-record.js` is the shipped bin.
// PtyProcess already spawns a `node ptyHost.mjs` bridge (node-pty's read loop is
// dead under bun; see the project memory), so this uses only Node-compatible
// APIs — do NOT re-hard-code a `bun` invocation.
//
// Scope THIS ticket: claude-code × {multi-turn, tool-call, interrupted-mid-reply}
// and codex × {multi-turn, tool-call}. The interrupt flow has NO generic
// production seam (BusyDetector is not on the base Adapter; codex has no busy(),
// and there is no interrupt-keystroke / confirmation seam for any non-claude
// harness), so `interrupted-mid-reply` is claude-code-only — the recorder ERRORS
// clearly (never silently no-ops) if asked to record it for another harness.
//
// Args (the subset rebake-corpus.mjs passes, plus optional overrides):
//   --harness <name>            claude-code | codex   (required)
//   --out <dir>                 scenario output dir    (required)
//   --scenario <name>           default: basename(--out)
//   --bin <path>                override binary; default: manifest entry.binary
//   --cols <n>  --rows <n>      terminal geometry (default 120 × 40)
//   --binary-version <v>        cross-check only (see below); NOT the recorded value
//   --cwd <dir>                 harness working dir (default: a temp dir)
//   --notes <text>             extra meta.json notes
//
// `--binary-version` is a CROSS-CHECK, not the recorded value: rebake passes the
// desired pin, but meta.json records the NORMALIZED probed version (what actually
// produced the bytes). On mismatch the recorder fails with a corpus-integrity
// error and writes nothing.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveAdapter } from "../chat/index.ts";
import {
  readyForInput,
  requiresPromptReadiness,
  submitKeyForHarness,
} from "../chat/ready.ts";
import { Screen } from "../screen/index.ts";
import { Errored, InputRequested, TurnComplete } from "../turns/index.ts";
import { readFrom } from "../versions/index.ts";
import { PtyProcess, resolveBinary } from "../wrapper/internal/pty.ts";

// Repo root, resolvable both as compiled dist/cli/*.js AND as src/cli/*.ts under
// bun (both are exactly three dirs deep under the root). Used to locate the
// default rebake manifest when META_HARNESS_REBAKE_MANIFEST is unset.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export const ExitOK = 0;
export const ExitError = 1;
export const ExitUsage = 2;

const enc = new TextEncoder();
const ESC = enc.encode("\x1b");

// claude-code-specific warmup/quit anchors (carried forward verbatim from
// record-scenarios.ts, gated on harness === "claude-code").
const claudeTrustAnchors = [
  "Do you trust the files in this folder?",
  "Is this a project you created or one you trust?",
];
const claudeQuit = enc.encode("/quit\x1b[13u");

// --- interrupt spec (per-harness; claude-code only this ticket) -------------
//
// The interrupt mechanics have no generic production seam: streaming-phase
// detection, the interrupt keystroke, and the interrupt-landed marker are all
// harness-specific and only defined for claude-code today. A scenario flagged
// `interrupt: true` is recordable for a harness ONLY IF interruptSpecs has an
// entry for it — otherwise the recorder errors (guarding the scope decision so a
// future flat-map edit can't silently produce a broken codex/pi interrupt cell).
interface InterruptSpec {
  /** Streaming-phase anchor: the busy footer shown only while a turn is in flight. */
  busyMarker: string;
  /** A second anchor that must co-occur so the ESC lands mid-reply, not mid-think. */
  streamingMarker: string;
  /** The interrupt keystroke. */
  key: Uint8Array;
  /** The text confirming the interrupt landed. */
  confirmText: string;
}

export const interruptSpecs: Record<string, InterruptSpec> = {
  "claude-code": {
    busyMarker: "esc to interrupt",
    streamingMarker: "⏺",
    key: ESC,
    confirmText: "Interrupted · What should Claude do instead?",
  },
};

// --- scenario catalog (generalizes record-scenarios.ts's `scenarios` map) ----
interface Scenario {
  prompts: string[];
  /** Interrupt the (single) prompt's reply once streaming is visible. */
  interrupt?: boolean;
  notes: string;
  setup?: (cwd: string) => void;
}

export const scenarios: Record<string, Scenario> = {
  "multi-turn": {
    prompts: [
      "what is the capital of France",
      "what is its population",
      "how does that compare to Berlin",
    ],
    notes:
      "three consecutive short prompts; each turn must settle before the next",
  },
  "tool-call": {
    prompts: [
      "Use the Read tool to read notes.txt and tell me exactly what it says",
    ],
    setup: (cwd) => {
      writeFileSync(
        join(cwd, "notes.txt"),
        "The corpus fixture sentinel is: POMELO-CANYON-88\n",
      );
    },
    notes: "single turn that makes a Read tool call before answering",
  },
  "interrupted-mid-reply": {
    prompts: ["Write a detailed 500 word essay about the history of Paris"],
    interrupt: true,
    notes: "long reply interrupted mid-stream; must end errored, not complete",
  },
};

// --- args --------------------------------------------------------------------

export interface ParsedArgs {
  harness: string;
  out: string;
  scenario: string;
  bin: string;
  cwd: string;
  cols: number;
  rows: number;
  binaryVersion: string;
  notes: string;
  help?: boolean;
  error?: string;
}

const USAGE = `usage: meta-harness-screenbench-record --harness <name> --out <dir> \\
    [--scenario <name>] [--bin <path>] [--cwd <dir>] \\
    [--cols <n>] [--rows <n>] [--binary-version <v>] [--notes <text>]`;

export function parseArgs(argv: string[]): ParsedArgs {
  const p: ParsedArgs = {
    harness: "",
    out: "",
    scenario: "",
    bin: "",
    cwd: "",
    cols: 120,
    rows: 40,
    binaryVersion: "",
    notes: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      p.help = true;
      return p;
    }
    const eq = a.indexOf("=");
    const inlineVal = eq >= 0 ? a.slice(eq + 1) : undefined;
    const flag = eq >= 0 ? a.slice(0, eq) : a;
    const next = (): string => {
      if (inlineVal !== undefined) return inlineVal;
      const v = argv[++i];
      if (v === undefined) {
        p.error = `missing value for ${flag}`;
        return "";
      }
      return v;
    };
    switch (flag) {
      case "--harness":
        p.harness = next();
        break;
      case "--out":
        p.out = next();
        break;
      case "--scenario":
        p.scenario = next();
        break;
      case "--bin":
        p.bin = next();
        break;
      case "--cwd":
        p.cwd = next();
        break;
      case "--cols":
        p.cols = Number(next());
        break;
      case "--rows":
        p.rows = Number(next());
        break;
      case "--binary-version":
        p.binaryVersion = next();
        break;
      case "--notes":
        p.notes = next();
        break;
      default:
        p.error = `unknown flag: ${a}`;
        return p;
    }
    if (p.error) return p;
  }
  if (!p.harness) p.error = "--harness <name> is required";
  else if (!p.out) p.error = "--out <dir> is required";
  else {
    // Scenario name defaults to the last path segment of --out, matching how
    // rebake-corpus.mjs encodes it (out = <root>/test/corpus/<name>/<scenario>).
    if (!p.scenario) p.scenario = basename(p.out);
    if (!Number.isFinite(p.cols) || p.cols <= 0)
      p.error = "--cols must be a positive integer";
    else if (!Number.isFinite(p.rows) || p.rows <= 0)
      p.error = "--rows must be a positive integer";
  }
  return p;
}

// --- version normalization ---------------------------------------------------

/**
 * normalizeVersion extracts the bare version token from a raw `--version` line.
 * A real harness prints more than the semver (e.g. "2.1.201 (Claude Code)")
 * while the manifest pin is the bare "2.1.201", so meta.json records — and the
 * --binary-version cross-check compares against — the FIRST whitespace token.
 */
export function normalizeVersion(raw: string): string {
  const t = raw.trim();
  return t.split(/\s+/)[0] ?? t;
}

// --- manifest resolution across the process boundary -------------------------
//
// The recorder is a separate child spawned by rebake-corpus.mjs, which passes
// only --harness/--out/--cols/--rows/--binary-version (no manifest path, no
// --bin, no shared memory). It must RE-RESOLVE the rebake manifest itself,
// mirroring rebake-corpus.mjs, and read entry.binary via readFrom(path). This is
// required, not a shortcut: the embedded catalog would resolve the real binary,
// defeating the hermetic test whose fake binary name lives only in the fixture
// manifest.
function manifestBinary(harness: string): string {
  const manifestPath =
    process.env.META_HARNESS_REBAKE_MANIFEST ??
    join(root, "versions.rebake.json");
  let manifest: Map<string, { binary: string }>;
  try {
    manifest = readFrom(manifestPath);
  } catch (err) {
    throw new Error(
      `cannot read rebake manifest ${manifestPath}: ` +
        (err instanceof Error ? err.message : String(err)) +
        "\n  (pass --bin to bypass the manifest, or set META_HARNESS_REBAKE_MANIFEST)",
    );
  }
  const entry = manifest.get(harness);
  if (!entry) {
    throw new Error(
      `harness "${harness}" not found in rebake manifest ${manifestPath}`,
    );
  }
  if (!entry.binary) {
    throw new Error(
      `harness "${harness}" has no binary in rebake manifest ${manifestPath}`,
    );
  }
  return entry.binary;
}

// --- live PTY plumbing (ported from record-scenarios.ts) ---------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** process.env minus the outer Claude Code session markers (mirrors cleanHarnessEnv). */
function cleanedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

interface Live {
  pty: PtyProcess;
  screen: Screen;
  exited: () => boolean;
}

async function spawnLive(
  bin: string,
  cwd: string,
  cols: number,
  rows: number,
  onData?: (d: Uint8Array) => void,
): Promise<Live> {
  const screen = new Screen(cols, rows);
  const pty = await PtyProcess.spawn({
    binaryPath: bin,
    args: [],
    cwd,
    env: cleanedEnv(),
    cols,
    rows,
  });
  let exited = false;
  pty.onExit(() => {
    exited = true;
  });
  pty.onData((d) => {
    onData?.(d);
    void screen.write(d);
  });
  return { pty, screen, exited: () => exited };
}

/** Polls `cond` against the rendered screen until true, or throws at `timeoutMs`. */
async function waitFor(
  live: Live,
  what: string,
  cond: (text: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond(live.screen.snapshot().text)) return;
    if (live.exited())
      throw new Error(`harness exited while waiting for ${what}`);
    await sleep(150);
  }
  throw new Error(
    `timeout waiting for ${what}; screen tail:\n` +
      live.screen.snapshot().text.trimEnd().split("\n").slice(-12).join("\n"),
  );
}

/**
 * Waits for readiness. For claude-code it also accepts the folder-trust dialog
 * (option 1) so warmup and the recording pass start from a clean composer.
 */
async function waitReady(
  live: Live,
  harness: string,
  timeoutMs: number,
): Promise<void> {
  let trustAnswered = false;
  await waitFor(
    live,
    "ready composer",
    (text) => {
      if (
        harness === "claude-code" &&
        !trustAnswered &&
        claudeTrustAnchors.some((a) => text.includes(a))
      ) {
        live.pty.write(enc.encode("1"));
        trustAnswered = true;
        return false;
      }
      return readyForInput(harness, text);
    },
    timeoutMs,
  );
}

/** Warmup pass (claude-code only): persist folder trust so recording starts clean. */
async function warmup(
  bin: string,
  cwd: string,
  cols: number,
  rows: number,
): Promise<void> {
  const live = await spawnLive(bin, cwd, cols, rows);
  try {
    await waitReady(live, "claude-code", 60_000);
  } finally {
    live.pty.kill("SIGTERM");
    await sleep(400);
    live.pty.kill("SIGKILL");
  }
}

async function quitAndWaitExit(live: Live): Promise<void> {
  live.pty.write(claudeQuit);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !live.exited()) await sleep(150);
  if (!live.exited()) {
    live.pty.kill("SIGTERM");
    await sleep(500);
    live.pty.kill("SIGKILL");
  }
  await sleep(300); // let the final output flush through the bridge
}

// --- main --------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  const p = parseArgs(argv);
  if (p.help) {
    process.stdout.write(USAGE + "\n");
    return ExitOK;
  }
  if (p.error) {
    process.stderr.write(`screenbench-record: ${p.error}\n${USAGE}\n`);
    return ExitUsage;
  }

  const scenario = scenarios[p.scenario];
  if (!scenario) {
    process.stderr.write(
      `screenbench-record: unknown scenario "${p.scenario}" ` +
        `(known: ${Object.keys(scenarios).join(", ")})\n`,
    );
    return ExitUsage;
  }

  // Interrupt-spec gate — BEFORE any file write, so an unsupported request
  // leaves no partial scenario. interrupt is claude-code-only this ticket.
  if (scenario.interrupt && !interruptSpecs[p.harness]) {
    process.stderr.write(
      `screenbench-record: no interrupt spec for harness "${p.harness}" — ` +
        `scenario "${p.scenario}" cannot be recorded (interrupt is claude-code-only ` +
        `until a per-harness interrupt seam lands)\n`,
    );
    return ExitError;
  }

  // Resolve the binary: --bin override wins; otherwise the manifest's
  // entry.binary for this harness, resolved on PATH.
  let binName: string;
  try {
    binName = p.bin || manifestBinary(p.harness);
  } catch (err) {
    process.stderr.write(
      `screenbench-record: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return ExitError;
  }
  const resolved = resolveBinary(binName);
  if (!resolved) {
    process.stderr.write(`screenbench-record: binary not found: ${binName}\n`);
    return ExitError;
  }

  // Probe the REAL version and normalize it; this — not --binary-version — is
  // what meta.json records (it must reflect what produced the bytes).
  let binaryVersion: string;
  try {
    const raw = execFileSync(resolved, ["--version"], {
      encoding: "utf8",
    });
    binaryVersion = normalizeVersion(raw);
  } catch (err) {
    process.stderr.write(
      `screenbench-record: failed to probe ${resolved} --version: ` +
        (err instanceof Error ? err.message : String(err)) +
        "\n",
    );
    return ExitError;
  }

  // Cross-check --binary-version against the NORMALIZED token (never the raw
  // line). A mismatch is a corpus-integrity bug — fail, write nothing.
  if (p.binaryVersion && p.binaryVersion !== binaryVersion) {
    process.stderr.write(
      `screenbench-record: corpus-integrity error: --binary-version ` +
        `"${p.binaryVersion}" != probed "${binaryVersion}" for ${resolved} ` +
        `(recording against the wrong binary)\n`,
    );
    return ExitError;
  }

  // From here on we write files.
  const cwd =
    p.cwd || join(tmpdir(), "meta-harness-corpus-rec", p.harness, p.scenario);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(p.out, { recursive: true });
  scenario.setup?.(cwd);

  if (p.harness === "claude-code") {
    process.stderr.write(`[screenbench-record] warmup in ${cwd}\n`);
    await warmup(resolved, cwd, p.cols, p.rows);
  }

  const bytesPath = join(p.out, "bytes.raw");
  writeFileSync(bytesPath, new Uint8Array(0));
  const startedAt = new Date();
  let recording = true;
  const live = await spawnLive(resolved, cwd, p.cols, p.rows, (d) => {
    if (recording) appendFileSync(bytesPath, d);
  });
  const adapter = resolveAdapter(p.harness);
  const submit = submitKeyForHarness(p.harness, "");
  const waitsForReady = requiresPromptReadiness(p.harness);
  const ispec = scenario.interrupt ? interruptSpecs[p.harness] : undefined;

  try {
    for (const [i, prompt] of scenario.prompts.entries()) {
      if (waitsForReady) await waitReady(live, p.harness, 90_000);
      process.stderr.write(`[screenbench-record] turn ${i + 1}: ${prompt}\n`);
      live.pty.write(enc.encode(prompt));
      await sleep(750);
      // claude-code echoes the prompt into the composer before submit; assert it
      // to catch a swallowed keystroke. Other harnesses (codex) consume the
      // text as a paste and do not echo pre-submit — skip the assertion there.
      if (
        p.harness === "claude-code" &&
        !live.screen.snapshot().text.includes(prompt)
      ) {
        throw new Error(`prompt was not echoed into the composer: ${prompt}`);
      }
      live.pty.write(submit);

      if (ispec && i === scenario.prompts.length - 1) {
        // Wait until the reply is visibly streaming (busy marker AND reply
        // glyph) before interrupting — an ESC during the think phase merely
        // restores the prompt. Then confirm the interrupt landed.
        await waitFor(
          live,
          "streaming reply",
          (t) =>
            t.includes(ispec.busyMarker) && t.includes(ispec.streamingMarker),
          120_000,
        );
        await sleep(1_500);
        process.stderr.write("[screenbench-record] sending interrupt\n");
        live.pty.write(ispec.key);
        await waitFor(
          live,
          "interrupt marker",
          (t) => t.includes(ispec.confirmText),
          30_000,
        );
      } else {
        // The production adapter is the completion predicate: poll until it
        // fires TurnComplete for this turn. A dialog or interrupt here means the
        // scenario went sideways — fail loudly rather than record garbage.
        await waitFor(
          live,
          `turn ${i + 1} completion`,
          () => {
            const evs = adapter.onScreen(live.screen.snapshot());
            for (const ev of evs) {
              if (ev.kind === InputRequested || ev.kind === Errored) {
                throw new Error(`unexpected ${ev.kind} during turn ${i + 1}`);
              }
            }
            return evs.some((ev) => ev.kind === TurnComplete);
          },
          180_000,
        );
      }
    }
    await sleep(1_500); // settle so the final turn fully renders
  } catch (err) {
    live.pty.kill("SIGKILL");
    process.stderr.write(
      `screenbench-record: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return ExitError;
  }

  // Freeze the recording at the settled frame, THEN quit (claude-code only): the
  // goodbye/resume screen /quit paints must not leak into bytes.raw. Non-claude
  // harnesses have no generic graceful-quit seam, so just stop and kill.
  const finalText = live.screen.snapshot().text;
  recording = false;
  if (p.harness === "claude-code") {
    await quitAndWaitExit(live);
  } else {
    live.pty.kill("SIGTERM");
    await sleep(400);
    live.pty.kill("SIGKILL");
  }

  writeFileSync(
    join(p.out, "expected.txt"),
    finalText.replace(/\s+$/u, "") + "\n",
  );
  const meta = {
    harness: p.harness,
    binary_version: binaryVersion,
    recorded_at: startedAt.toISOString(),
    cols: p.cols,
    rows: p.rows,
    notes:
      `screenbench-record ${p.scenario}: ${scenario.notes}` +
      (p.notes ? ` — ${p.notes}` : ""),
  };
  writeFileSync(join(p.out, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  process.stdout.write(
    `recorded ${p.out} (${p.scenario}, ${p.harness}, binary ${binaryVersion})\n`,
  );
  return ExitOK;
}

// Node-safe main guard (mirrors src/cli/run.ts): only run when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write("screenbench-record: fatal: " + String(err) + "\n");
      process.exit(ExitError);
    },
  );
}
