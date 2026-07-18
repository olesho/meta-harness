// screenbench.ts — single-emulator fidelity bench for the MH corpus.
//
// Replays each recorded PTY byte stream through `src/screen`'s `newScreen()`
// and scores the resulting snapshot against the scenario's ground-truth
// `expected.txt`, using the shared metrics module (normalized on BOTH sides so
// exact match is a content property, not a trailing-whitespace accident).
//
// Ported from the Go `internal/screenbench/cmd/screenbench/main.go` fidelity
// bench, but collapsed to the single JS emulator (@xterm/headless, via Screen):
// there is exactly one adapter here, so there is no `--emulator` flag, no
// Registry/Factory, and no stability/throughput/alloc telemetry. The `replay`
// seam is kept thin so a second emulator COULD be swapped in later.
//
// Dev-only tooling: lives under test/corpus/tools/ and runs via bun. It is NOT
// part of the shipped `src/**` surface and has no compiled `bin`.
//
// Usage:
//   bun test/corpus/tools/screenbench.ts --corpus test/corpus/synth
//   bun test/corpus/tools/screenbench.ts --scenario short-reply --format json
//   bun test/corpus/tools/screenbench.ts --corpus test/corpus/synth --threshold 0
//
// Exit code: non-zero if ANY non-skipped scenario has normalizedDistance above
// --threshold; zero otherwise. This is the signal A3's rebake/canary reads.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { newScreen } from "../../../src/screen/index.ts";
import {
  ExactMatch,
  Levenshtein,
  Normalize,
  NormalizedDistance,
} from "./screenbench-metrics.ts";

const HARNESS = "src/screen";

// Default tolerance for the exit-code gate. The synth corpus replays exactly
// through newScreen() (exactMatch: true, normalizedDistance === 0), so the
// baseline is a true zero; this small epsilon only guards against a future
// scenario that drifts by a rounding hair without failing CI. `--threshold 0`
// stays available for strict callers who want no slack at all.
const DEFAULT_THRESHOLD = 0;

// ---- CLI parsing ----

interface Flags {
  corpus: string;
  scenario: string;
  format: "markdown" | "json";
  threshold: number;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    corpus: "test/corpus/synth",
    scenario: "",
    format: "markdown",
    threshold: DEFAULT_THRESHOLD,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--corpus":
        flags.corpus = next();
        break;
      case "--scenario":
        flags.scenario = next();
        break;
      case "--format": {
        const v = next();
        if (v !== "markdown" && v !== "json") {
          throw new Error(`--format must be markdown|json, got ${v}`);
        }
        flags.format = v;
        break;
      }
      case "--threshold": {
        const v = Number(next());
        if (!Number.isFinite(v))
          throw new Error(`--threshold must be a number`);
        flags.threshold = v;
        break;
      }
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return flags;
}

// ---- repo root anchor (mirrors test/turns/corpus.ts:19-27) ----

const thisDir = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = thisDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "test", "corpus"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("could not locate test/corpus from " + thisDir);
}

// ---- scenario discovery ----

interface Meta {
  harness?: string;
  cols?: number;
  rows?: number;
}

interface Scenario {
  path: string;
  name: string;
}

// A directory is a scenario IFF it contains BOTH meta.json AND bytes.raw (the
// required pair documented in test/corpus/README.md, matching Go
// scenario.Discover). expected.txt is optional. Walks the corpus root
// recursively; dirs without the required pair (e.g. tools/, or intermediate
// harness dirs) are traversed but not themselves treated as scenarios.
function discover(corpusRoot: string): Scenario[] {
  const out: Scenario[] = [];
  const walk = (dir: string) => {
    if (
      existsSync(join(dir, "meta.json")) &&
      existsSync(join(dir, "bytes.raw"))
    ) {
      out.push({ path: dir, name: basename(dir) });
      return; // a scenario is a leaf; don't descend into it
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) walk(join(dir, e.name));
    }
  };
  walk(corpusRoot);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---- replay seam ----

// replay feeds raw bytes through a freshly-constructed Screen and returns the
// final snapshot text. Kept as a standalone async function so a second emulator
// could be dropped in behind the same signature — but there is exactly one JS
// emulator, so no registry/factory indirection.
async function replay(
  bytes: Uint8Array,
  cols: number,
  rows: number,
): Promise<string> {
  const screen = newScreen(cols, rows);
  await screen.write(bytes);
  return screen.snapshot().text;
}

// ---- per-scenario record (pinned output contract) ----

interface Record {
  harness: string;
  scenario: string;
  cols: number;
  rows: number;
  exactMatch?: boolean;
  distance?: number;
  normalizedDistance?: number;
  skipped?: true;
  skipReason?: string;
}

async function scoreOne(sc: Scenario): Promise<Record> {
  const meta = JSON.parse(
    readFileSync(join(sc.path, "meta.json"), "utf8"),
  ) as Meta;
  // harness / cols / rows come FROM meta.json, so a promoted live recording
  // labels as its real harness rather than the dir path.
  const harness = meta.harness ?? HARNESS;
  const cols = meta.cols ?? 0;
  const rows = meta.rows ?? 0;

  const expectedPath = join(sc.path, "expected.txt");
  if (!existsSync(expectedPath)) {
    // No oracle → skip (not a failure). record-pty.ts writes screen-*.txt not
    // expected.txt, so live probe recordings are skipped until promoted.
    return {
      harness,
      scenario: sc.name,
      cols,
      rows,
      skipped: true,
      skipReason: "no expected.txt",
    };
  }

  const bytes = new Uint8Array(readFileSync(join(sc.path, "bytes.raw")));
  const snapshot = await replay(bytes, cols, rows);
  const expected = readFileSync(expectedPath, "utf8");

  const ns = Normalize(snapshot);
  const ne = Normalize(expected);
  return {
    harness,
    scenario: sc.name,
    cols,
    rows,
    exactMatch: ExactMatch(ns, ne),
    distance: Levenshtein(ns, ne),
    normalizedDistance: NormalizedDistance(ns, ne),
  };
}

// ---- output formatters ----

function emitJSON(records: Record[]): void {
  process.stdout.write(JSON.stringify(records, null, 2) + "\n");
}

function emitMarkdown(records: Record[], threshold: number): void {
  const lines: string[] = [];
  lines.push("# screenbench fidelity results");
  lines.push("");
  lines.push(
    `Corpus harness adapter: \`${HARNESS}\` | threshold: ${threshold}`,
  );
  lines.push("");
  lines.push(
    "| Scenario | Harness | Cols | Rows | Exact | Distance | NormDist |",
  );
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of records) {
    if (r.skipped) {
      lines.push(
        `| ${r.scenario} | ${r.harness} | ${r.cols} | ${r.rows} | skip (${r.skipReason}) | - | - |`,
      );
      continue;
    }
    lines.push(
      `| ${r.scenario} | ${r.harness} | ${r.cols} | ${r.rows} | ${r.exactMatch} | ${r.distance} | ${r.normalizedDistance!.toFixed(4)} |`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// ---- main ----

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const root = repoRoot();
  const corpusRoot = join(root, flags.corpus);

  if (!existsSync(corpusRoot)) {
    process.stderr.write(`screenbench: corpus not found: ${flags.corpus}\n`);
    return 1;
  }

  let scenarios = discover(corpusRoot);
  if (flags.scenario) {
    scenarios = scenarios.filter((s) => s.name === flags.scenario);
  }
  if (scenarios.length === 0) {
    process.stderr.write(
      `screenbench: no scenarios found under ${flags.corpus}\n`,
    );
    return 0;
  }

  const records: Record[] = [];
  for (const sc of scenarios) {
    records.push(await scoreOne(sc));
  }

  if (flags.format === "json") {
    emitJSON(records);
  } else {
    emitMarkdown(records, flags.threshold);
  }

  // Non-zero exit if ANY non-skipped scenario exceeds the threshold.
  const failed = records.some(
    (r) => !r.skipped && r.normalizedDistance! > flags.threshold,
  );
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`screenbench: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
