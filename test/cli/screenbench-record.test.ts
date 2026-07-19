// Tests for the generic screenbench recorder (src/cli/screenbench-record.ts).
//
// The recorder drives a REAL PTY, so the recording tests spawn the hermetic fake
// harness (test/cli/testdata/fake-record-harness.mjs) built with the shared
// codex frame vocabulary (test/chat/fakeharness.ts Builder). The rebake smoke
// test execs the real script against a fixture manifest + fake-on-PATH, then
// restores the (overwritten) corpus dirs from git.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  normalizeVersion,
  main,
  scenarios,
  interruptSpecs,
  ExitOK,
  ExitError,
  ExitUsage,
} from "../../src/cli/screenbench-record.ts";
import { New } from "../chat/fakeharness.ts";
import { newScreen } from "../../src/screen/index.ts";
import { NormalizedDistance } from "../corpus/tools/screenbench-metrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fakeHarness = join(here, "testdata", "fake-record-harness.mjs");
const recorderDist = join(root, "dist", "cli", "screenbench-record.js");

// Belt-and-suspenders: keep the fake executable across a fresh checkout.
try {
  chmodSync(fakeHarness, 0o755);
} catch {
  /* best effort */
}

const FAKE_VERSION = "7.7.7";

/**
 * codexScript builds a codex fake-harness script with `turns` prompt→reply
 * cycles: each reply paints a fresh Token-usage footer, which the production
 * codex adapter fingerprints into a TurnComplete the recorder polls for.
 */
function codexScript(turns: number): string {
  const b = New("codex").Idle();
  for (let i = 0; i < turns; i++) {
    b.AwaitSubmit().CodexReply(40, `reply ${i + 1}: the answer is ${i + 1}`);
  }
  b.StayAliveUntilStopped();
  const dir = mkdtempSync(join(tmpdir(), "sbrec-script-"));
  const p = join(dir, "script.json");
  writeFileSync(p, JSON.stringify(b.Build()), { mode: 0o600 });
  return p;
}

/** Runs main() with FAKEHARNESS_SCRIPT/FAKE_HARNESS_VERSION set for the child PTY. */
async function runRecorder(
  argv: string[],
  scriptPath: string,
  version = FAKE_VERSION,
): Promise<number> {
  const prevScript = process.env.FAKEHARNESS_SCRIPT;
  const prevVersion = process.env.FAKE_HARNESS_VERSION;
  process.env.FAKEHARNESS_SCRIPT = scriptPath;
  process.env.FAKE_HARNESS_VERSION = version;
  try {
    return await main(argv);
  } finally {
    if (prevScript === undefined) delete process.env.FAKEHARNESS_SCRIPT;
    else process.env.FAKEHARNESS_SCRIPT = prevScript;
    if (prevVersion === undefined) delete process.env.FAKE_HARNESS_VERSION;
    else process.env.FAKE_HARNESS_VERSION = prevVersion;
  }
}

function outDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "sbrec-out-")), name);
}

// ---- pure-unit tests --------------------------------------------------------

describe("parseArgs", () => {
  test("required flags + scenario defaults to basename(--out)", () => {
    const p = parseArgs([
      "--harness",
      "codex",
      "--out",
      "/x/corpus/multi-turn",
    ]);
    expect(p.error).toBeUndefined();
    expect(p.harness).toBe("codex");
    expect(p.scenario).toBe("multi-turn");
    expect(p.cols).toBe(120);
    expect(p.rows).toBe(40);
  });

  test("explicit --scenario overrides basename", () => {
    const p = parseArgs([
      "--harness",
      "codex",
      "--out",
      "/x/y",
      "--scenario",
      "tool-call",
    ]);
    expect(p.scenario).toBe("tool-call");
  });

  test("--flag=value form", () => {
    const p = parseArgs(["--harness=codex", "--out=/x/y", "--cols=80"]);
    expect(p.harness).toBe("codex");
    expect(p.cols).toBe(80);
  });

  test("missing --harness / --out errors", () => {
    expect(parseArgs([]).error).toBeDefined();
    expect(parseArgs(["--harness", "codex"]).error).toBeDefined();
  });

  test("unknown flag errors", () => {
    expect(parseArgs(["--nope"]).error).toBeDefined();
  });

  test("--help short-circuits", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});

describe("normalizeVersion", () => {
  test("bare token passes through", () => {
    expect(normalizeVersion("2.1.201")).toBe("2.1.201");
  });
  test("strips trailing product text", () => {
    expect(normalizeVersion("2.1.201 (Claude Code)")).toBe("2.1.201");
    expect(normalizeVersion("  0.142.5\n")).toBe("0.142.5");
  });
});

describe("catalog invariants", () => {
  test("interrupt is claude-code-only", () => {
    expect(scenarios["interrupted-mid-reply"].interrupt).toBe(true);
    expect(interruptSpecs["claude-code"]).toBeDefined();
    expect(interruptSpecs["codex"]).toBeUndefined();
  });
});

// ---- recording tests (real PTY, hermetic fake harness) ----------------------

describe("recorder end-to-end", () => {
  // Test 1 + Test 5: valid triple, normalized probed version, self-consistent replay.
  test("writes a valid scenario triple and self-consistent replay", async () => {
    const out = outDir("tool-call");
    const code = await runRecorder(
      ["--harness", "codex", "--out", out, "--bin", fakeHarness],
      codexScript(1),
      "5.5.5",
    );
    expect(code).toBe(ExitOK);

    // discover-equivalent predicate: BOTH meta.json AND bytes.raw present.
    expect(existsSync(join(out, "meta.json"))).toBe(true);
    expect(existsSync(join(out, "bytes.raw"))).toBe(true);
    expect(existsSync(join(out, "expected.txt"))).toBe(true);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.harness).toBe("codex");
    // meta records the NORMALIZED PROBED version, not a passed pin.
    expect(meta.binary_version).toBe("5.5.5");
    expect(meta.cols).toBe(120);
    expect(meta.rows).toBe(40);

    // Test 5 — self-consistency replay (regression/plumbing check, NOT a
    // fidelity gate): bytes.raw re-rendered through a fresh newScreen() equals
    // the expected.txt captured from the same live run. Near-tautological by
    // construction — it proves the recorder wrote a self-consistent scenario.
    const bytes = new Uint8Array(readFileSync(join(out, "bytes.raw")));
    const expected = readFileSync(join(out, "expected.txt"), "utf8");
    const screen = newScreen(meta.cols, meta.rows);
    await screen.write(bytes);
    const replay = screen.snapshot().text;
    const strip = (s: string) => s.replace(/\s+$/u, "");
    expect(NormalizedDistance(strip(replay), strip(expected))).toBe(0);
  });

  // Test 1 (multi-turn variant): the per-turn completion loop drives >1 turn.
  test("drives a multi-turn scenario to completion", async () => {
    const out = outDir("multi-turn");
    const code = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        out,
        "--scenario",
        "multi-turn",
        "--bin",
        fakeHarness,
      ],
      codexScript(3),
    );
    expect(code).toBe(ExitOK);
    expect(existsSync(join(out, "bytes.raw"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.binary_version).toBe(FAKE_VERSION);
  });

  // Test 2: --binary-version cross-check.
  test("--binary-version matching succeeds, mismatch fails with no partial", async () => {
    const okOut = outDir("tool-call");
    const okCode = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        okOut,
        "--bin",
        fakeHarness,
        "--binary-version",
        FAKE_VERSION,
      ],
      codexScript(1),
    );
    expect(okCode).toBe(ExitOK);
    expect(existsSync(join(okOut, "meta.json"))).toBe(true);

    const badOut = outDir("tool-call");
    const badCode = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        badOut,
        "--bin",
        fakeHarness,
        "--binary-version",
        "9.9.9", // != probed FAKE_VERSION
      ],
      codexScript(1),
    );
    expect(badCode).toBe(ExitError);
    // Corpus-integrity failure writes NO partial scenario.
    expect(existsSync(join(badOut, "bytes.raw"))).toBe(false);
    expect(existsSync(join(badOut, "meta.json"))).toBe(false);
    expect(existsSync(join(badOut, "expected.txt"))).toBe(false);
  });

  // Test 4: unsupported-scenario (interrupt for non-claude) errors explicitly.
  test("interrupt scenario for codex fails with no partial", async () => {
    const out = outDir("interrupted-mid-reply");
    const code = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        out,
        "--scenario",
        "interrupted-mid-reply",
        "--bin",
        fakeHarness,
      ],
      codexScript(1),
    );
    expect(code).toBe(ExitError);
    expect(existsSync(join(out, "bytes.raw"))).toBe(false);
    expect(existsSync(join(out, "meta.json"))).toBe(false);
  });

  test("unknown scenario name is a usage error", async () => {
    const out = outDir("no-such-scenario");
    const code = await runRecorder(
      ["--harness", "codex", "--out", out, "--bin", fakeHarness],
      codexScript(1),
    );
    expect(code).toBe(ExitUsage);
  });
});

// ---- rebake smoke (Test 3) --------------------------------------------------

describe("rebake-corpus smoke", () => {
  test("finds recorder, resolves fake by harness-name, records + skips pi, exit 0", () => {
    if (!existsSync(recorderDist)) {
      throw new Error(
        `built recorder not found at ${recorderDist} — run \`npm run build\` first`,
      );
    }
    // On-PATH wrapper resolving the harness binary by NAME (the resolution path
    // rebake actually uses), so the recorder's manifest → entry.binary →
    // resolveBinary(PATH) chain finds the fake.
    const binDir = mkdtempSync(join(tmpdir(), "sbrec-bin-"));
    const wrapper = `#!/bin/sh\nexec node ${JSON.stringify(fakeHarness)} "$@"\n`;
    for (const name of ["fake-codex", "fake-pi"]) {
      const w = join(binDir, name);
      writeFileSync(w, wrapper, { mode: 0o755 });
      chmodSync(w, 0o755);
    }

    // Fixture manifest: codex is in the per-harness SCENARIOS map (records
    // multi-turn + tool-call); pi is pinned but NOT in the map → skipped, logged.
    const manifestDir = mkdtempSync(join(tmpdir(), "sbrec-manifest-"));
    const manifest = join(manifestDir, "versions.rebake.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        codex: {
          package: "@fake/codex",
          binary: "fake-codex",
          pinned: FAKE_VERSION,
          verified_at: "2026-01-01",
        },
        pi: {
          package: "@fake/pi",
          binary: "fake-pi",
          pinned: FAKE_VERSION,
          verified_at: "2026-01-01",
        },
      }),
    );

    const scriptPath = codexScript(3);
    // rebake writes into the REAL corpus dirs; restore them afterward.
    const clobbered = [
      "test/corpus/codex/multi-turn",
      "test/corpus/codex/tool-call",
    ];
    try {
      const res = spawnSync("node", [join("scripts", "rebake-corpus.mjs")], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          META_HARNESS_REBAKE_MANIFEST: manifest,
          META_HARNESS_SCREENBENCH_RECORD: recorderDist,
          FAKEHARNESS_SCRIPT: scriptPath,
          FAKE_HARNESS_VERSION: FAKE_VERSION,
        },
      });

      expect(res.status).toBe(ExitOK);
      // pi (pinned, not in map) is skipped BY DESIGN with a logged line.
      expect(res.stderr).toContain("pi has no in-scope scenarios (deferred)");
      // codex cells recorded end-to-end.
      for (const scenario of ["multi-turn", "tool-call"]) {
        const dir = join(root, "test", "corpus", "codex", scenario);
        expect(existsSync(join(dir, "bytes.raw"))).toBe(true);
        const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
        expect(meta.harness).toBe("codex");
        expect(meta.binary_version).toBe(FAKE_VERSION);
      }
    } finally {
      spawnSync("git", ["restore", "--", ...clobbered], { cwd: root });
    }
  }, 60_000);
});
