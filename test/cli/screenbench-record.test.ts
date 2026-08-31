// Tests for the generic screenbench recorder (src/cli/screenbench-record.ts).
//
// The recorder drives a REAL PTY, so the recording tests spawn the hermetic fake
// harness (test/cli/testdata/fake-record-harness.mjs) built with the shared
// codex frame vocabulary (test/chat/fakeharness.ts Builder). The rebake smoke
// test execs the real script against a fixture manifest + fake-on-PATH, then
// restores the (overwritten) corpus dirs from git.

import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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
  dialogSpecs,
  claudeTrustState,
  recorderOwnedMeta,
  ExitOK,
  ExitError,
  ExitUsage,
} from "../../src/cli/screenbench-record.ts";
import { expandScenario, type Step } from "../../src/cli/recordSteps.ts";
import { New, type Builder } from "../chat/fakeharness.ts";
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

/**
 * claudeScript writes a claude-code fake-harness script built by `build` and
 * returns its path. Used by the trust-dialog recordings, whose terminal state is
 * a blocking dialog rather than a TurnComplete.
 */
function claudeScript(build: (b: Builder) => Builder): string {
  const b = build(New("claude-code"));
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
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const prevScript = process.env.FAKEHARNESS_SCRIPT;
  const prevVersion = process.env.FAKE_HARNESS_VERSION;
  const prevExtra = new Map<string, string | undefined>();
  process.env.FAKEHARNESS_SCRIPT = scriptPath;
  process.env.FAKE_HARNESS_VERSION = version;
  for (const [k, v] of Object.entries(extraEnv)) {
    prevExtra.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return await main(argv);
  } finally {
    if (prevScript === undefined) delete process.env.FAKEHARNESS_SCRIPT;
    else process.env.FAKEHARNESS_SCRIPT = prevScript;
    if (prevVersion === undefined) delete process.env.FAKE_HARNESS_VERSION;
    else process.env.FAKE_HARNESS_VERSION = prevVersion;
    for (const [k, v] of prevExtra) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
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

  // --workdir is a TRUE ALIAS of --cwd: one field, two spellings. It is not a
  // second concept, and a disagreeing pair is a caller bug, not last-wins.
  test("--workdir writes the same field as --cwd", () => {
    const spaced = parseArgs([
      "--harness",
      "codex",
      "--out",
      "/x/y",
      "--workdir",
      "/x",
    ]);
    expect(spaced.error).toBeUndefined();
    expect(spaced.cwd).toBe("/x");

    const inline = parseArgs([
      "--harness",
      "codex",
      "--out",
      "/x/y",
      "--workdir=/x",
    ]);
    expect(inline.error).toBeUndefined();
    expect(inline.cwd).toBe("/x");
  });

  test("--cwd and --workdir agree: fine; disagree: usage error", () => {
    const same = parseArgs([
      "--harness",
      "codex",
      "--out",
      "/x/y",
      "--cwd",
      "/a",
      "--workdir",
      "/a",
    ]);
    expect(same.error).toBeUndefined();
    expect(same.cwd).toBe("/a");

    const clash = parseArgs([
      "--harness",
      "codex",
      "--out",
      "/x/y",
      "--cwd",
      "/a",
      "--workdir",
      "/b",
    ]);
    expect(clash.error).toBeDefined();
  });

  // --- the scripted-step flags (PUPPET-312) ---

  const base = ["--harness", "codex", "--out", "/x/y"];

  test("--prompt is repeatable and keeps order", () => {
    const p = parseArgs([...base, "--prompt", "one", "--prompt", "two"]);
    expect(p.error).toBeUndefined();
    expect(p.prompts).toEqual(["one", "two"]);
  });

  test("--keys accepts an embedded escape and is repeatable", () => {
    const p = parseArgs([...base, "--keys", "1,\\t,\\x1b[Z", "--keys", "\\r"]);
    expect(p.error).toBeUndefined();
    expect(p.keys).toEqual(["1,\\t,\\x1b[Z", "\\r"]);
  });

  test("--keys with an empty burst is a usage error at PARSE time", () => {
    // Not at write time: finding a typo after a live recording has started costs
    // a paid session.
    expect(parseArgs([...base, "--keys", "1,,2"]).error).toMatch(/empty key/);
    expect(parseArgs([...base, "--keys", ""]).error).toMatch(/empty key/);
    expect(parseArgs([...base, "--keys", "1,"]).error).toMatch(/empty key/);
  });

  test("--keys with a bad escape is a usage error", () => {
    expect(parseArgs([...base, "--keys", "\\q"]).error).toMatch(
      /unknown escape/,
    );
  });

  test("--stop-on-input is bare, with an optional inline kind", () => {
    const bare = parseArgs([...base, "--stop-on-input"]);
    expect(bare.error).toBeUndefined();
    expect(bare.stopOnInput).toBe(true);
    expect(bare.stopOnInputKind).toBe("");

    const kind = parseArgs([...base, "--stop-on-input=question"]);
    expect(kind.stopOnInput).toBe(true);
    expect(kind.stopOnInputKind).toBe("question");
  });

  test("bare --stop-on-input does not swallow the next flag", () => {
    const p = parseArgs([...base, "--stop-on-input", "--keys", "1"]);
    expect(p.error).toBeUndefined();
    expect(p.stopOnInput).toBe(true);
    expect(p.keys).toEqual(["1"]);
  });

  test("--launch-arg is repeatable and keeps order", () => {
    const p = parseArgs([
      ...base,
      "--launch-arg",
      "--dangerously-skip-permissions",
      "--launch-arg",
      "--verbose",
    ]);
    expect(p.launchArgs).toEqual([
      "--dangerously-skip-permissions",
      "--verbose",
    ]);
  });

  test("--no-warmup and --allow-overwrite are bare booleans", () => {
    const p = parseArgs([...base, "--no-warmup", "--allow-overwrite"]);
    expect(p.error).toBeUndefined();
    expect(p.noWarmup).toBe(true);
    expect(p.allowOverwrite).toBe(true);
    expect(parseArgs([...base, "--no-warmup=1"]).error).toBeDefined();
    expect(parseArgs([...base, "--allow-overwrite=yes"]).error).toBeDefined();
  });

  test("--attempts defaults to 1 and must be a positive integer", () => {
    expect(parseArgs(base).attempts).toBe(1);
    expect(parseArgs([...base, "--attempts", "3"]).attempts).toBe(3);
    expect(parseArgs([...base, "--attempts", "0"]).error).toBeDefined();
    expect(parseArgs([...base, "--attempts", "x"]).error).toBeDefined();
    expect(parseArgs([...base, "--attempts", "1.5"]).error).toBeDefined();
  });

  // The unknown-flag rejection must survive the new cases: a typo has to fail
  // loudly rather than be absorbed as a scenario name.
  test("an unknown flag still errors alongside the new ones", () => {
    expect(parseArgs([...base, "--stop-on-inputs"]).error).toBeDefined();
    expect(parseArgs([...base, "--key", "1"]).error).toBeDefined();
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

  test("trust-dialog is a promptless, dialog-terminated, fresh-workdir cell", () => {
    const sc = scenarios["trust-dialog"];
    expect(sc.dialog).toBe(true);
    expect(sc.freshWorkdir).toBe(true);
    // `prompts` is optional now that a scenario may script itself, so this reads
    // the list rather than its length.
    expect(sc.prompts).toEqual([]);
  });

  test("the startup dialog is claude-code-only", () => {
    expect(dialogSpecs["claude-code"]).toBeDefined();
    expect(dialogSpecs["codex"]).toBeUndefined();
  });

  // Every entry must declare exactly one driving shape. `prompts` is sugar for
  // [prompt, await-turn] per entry; `steps` is an explicit script. Declaring
  // both is a usage error rather than a silent precedence rule, so the catalog
  // itself must never be in that state.
  test("every entry declares prompts XOR steps", () => {
    for (const [name, sc] of Object.entries(scenarios)) {
      const hasPrompts = sc.prompts !== undefined;
      const hasSteps = sc.steps !== undefined;
      expect(
        hasPrompts !== hasSteps,
        `${name} must declare exactly one of prompts / steps`,
      ).toBe(true);
      // …and every entry must actually expand.
      expect(() => expandScenario(sc)).not.toThrow();
    }
  });

  // requiresHarness is refused for any OTHER harness, before any file write.
  // Vacuous while no catalog entry declares it — the point is that adding one
  // cannot skip the gate; the live refusal is exercised in "pre-write guards".
  test("every requiresHarness entry names a harness that can drive it", () => {
    for (const [name, sc] of Object.entries(scenarios)) {
      if (sc.requiresHarness === undefined) continue;
      expect(
        ["claude-code", "codex", "pi", "opencode", "generic"],
        `${name} requires an unknown harness`,
      ).toContain(sc.requiresHarness);
    }
  });

  // The three legacy entries must keep desugaring to EXACTLY the step list the
  // pre-interpreter loop drove, or the shipped corpus silently changes meaning.
  test("the legacy entries expand to the exact legacy step list", () => {
    expect(expandScenario(scenarios["multi-turn"])).toEqual([
      { kind: "prompt", text: "what is the capital of France" },
      { kind: "await-turn" },
      { kind: "prompt", text: "what is its population" },
      { kind: "await-turn" },
      { kind: "prompt", text: "how does that compare to Berlin" },
      { kind: "await-turn" },
    ]);
    expect(expandScenario(scenarios["tool-call"])).toEqual([
      {
        kind: "prompt",
        text: "Use the Read tool to read notes.txt and tell me exactly what it says",
      },
      { kind: "await-turn" },
    ]);
    expect(expandScenario(scenarios["interrupted-mid-reply"])).toEqual([
      {
        kind: "prompt",
        text: "Write a detailed 500 word essay about the history of Paris",
      },
      { kind: "interrupt" },
    ]);
  });

  // trust-dialog stops on the ANCHOR, not on an adapter event — the distinction
  // the migration turns on, and it is legible from the expansion alone.
  test("trust-dialog expands to the anchor stop condition, not await-input", () => {
    expect(expandScenario(scenarios["trust-dialog"])).toEqual([
      { kind: "await-dialog-anchor" },
    ]);
  });

  // Guards a copy-paste divergence: the recorder's dialog anchors must be the
  // SAME strings src/chat/ready.ts blocks on, or the recorder could settle on a
  // frame the readiness gate does not consider a dialog (or vice versa).
  test("dialog anchors are exactly the readiness layer's trust anchors", () => {
    expect([...dialogSpecs["claude-code"].anchors].sort()).toEqual(
      [
        "Do you trust the files in this folder?",
        "Is this a project you created or one you trust?",
      ].sort(),
    );
  });
});

describe("claudeTrustState", () => {
  const fixture = join(here, "testdata", "claude-trusted.json");

  test("an accepted entry reports true", () => {
    expect(
      claudeTrustState("/private/tmp/meta-harness-fixture-trusted", fixture),
    ).toBe(true);
  });

  test("a seen-but-declined entry reports false, not true", () => {
    // `false` is the normal "launched here, said no" state — the dialog still
    // fires, so this must NOT block a recording.
    expect(
      claudeTrustState("/private/tmp/meta-harness-fixture-seen", fixture),
    ).toBe(false);
  });

  test("an unknown path reports false", () => {
    expect(claudeTrustState("/private/tmp/never-launched-here", fixture)).toBe(
      false,
    );
  });

  // null is "cannot tell", NOT "trusted" — an unreadable config must not block a
  // legitimate recording.
  test("a missing config reports null", () => {
    expect(
      claudeTrustState(
        "/private/tmp/meta-harness-fixture-trusted",
        join(here, "testdata", "no-such-claude-config.json"),
      ),
    ).toBeNull();
  });

  test("a malformed config reports null", () => {
    const bad = join(mkdtempSync(join(tmpdir(), "sbrec-cfg-")), "claude.json");
    writeFileSync(bad, "{ not json");
    expect(
      claudeTrustState("/private/tmp/meta-harness-fixture-trusted", bad),
    ).toBeNull();
  });

  test.runIf(process.platform === "darwin")(
    "a /tmp path matches a config entry stored as /private/tmp",
    () => {
      // On macOS /tmp is a symlink to /private/tmp and claude stores the
      // resolved path. A raw-only comparison would make this check silently
      // useless exactly where recordings are taken.
      const raw = "/tmp/meta-harness-fixture-trusted";
      mkdirSync(raw, { recursive: true });
      expect(claudeTrustState(raw, fixture)).toBe(true);
    },
  );
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

  // Dialog gate: mirrors the interrupt-gate test exactly — an unsupported
  // (harness × capability) pair errors BEFORE any file is written.
  test("dialog scenario for codex fails with no partial", async () => {
    const out = outDir("trust-dialog");
    const code = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        out,
        "--scenario",
        "trust-dialog",
        "--bin",
        fakeHarness,
      ],
      codexScript(1),
    );
    expect(code).toBe(ExitError);
    expect(existsSync(out)).toBe(false);
  });

  // Untrusted-directory precondition: an explicit --cwd claude has already been
  // trusted in would record a ready composer, not the dialog.
  test("trust-dialog into an already-trusted --cwd fails with no partial", async () => {
    const out = outDir("trust-dialog");
    const code = await runRecorder(
      [
        "--harness",
        "claude-code",
        "--out",
        out,
        "--scenario",
        "trust-dialog",
        "--cwd",
        "/private/tmp/meta-harness-fixture-trusted",
        "--bin",
        fakeHarness,
      ],
      claudeScript((b) => b.ClaudeTrustPrompt(0).StayAliveUntilStopped()),
      FAKE_VERSION,
      {
        META_HARNESS_CLAUDE_CONFIG: join(
          here,
          "testdata",
          "claude-trusted.json",
        ),
      },
    );
    expect(code).toBe(ExitError);
    expect(existsSync(out)).toBe(false);
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

describe("recorder: trust-dialog (dialog-terminated scenario)", () => {
  const anchor = "Is this a project you created or one you trust?";

  test("records the unanswered dialog frame as a valid, self-consistent triple", async () => {
    const out = outDir("trust-dialog");
    const spawnLog = join(mkdtempSync(join(tmpdir(), "sbrec-spawn-")), "log");
    const code = await runRecorder(
      [
        "--harness",
        "claude-code",
        "--scenario",
        "trust-dialog",
        "--out",
        out,
        "--bin",
        fakeHarness,
      ],
      claudeScript((b) => b.ClaudeTrustPrompt(0).StayAliveUntilStopped()),
      FAKE_VERSION,
      { FAKE_HARNESS_SPAWN_LOG: spawnLog },
    );
    expect(code).toBe(ExitOK);

    expect(existsSync(join(out, "bytes.raw"))).toBe(true);
    expect(existsSync(join(out, "meta.json"))).toBe(true);
    expect(existsSync(join(out, "expected.txt"))).toBe(true);

    const expected = readFileSync(join(out, "expected.txt"), "utf8");
    expect(expected).toContain(anchor);
    expect(expected).toContain("No, exit");
    expect(expected).toContain("Yes, I trust this folder");

    // NO-WARMUP PROOF, asserted directly: the warmup pass exists to answer and
    // persist the trust decision, so running it would leave nothing to record.
    // Exactly one PTY launch means it was skipped. (The --version probe exits
    // before the ledger, so it never contributes a line.)
    const spawns = readFileSync(spawnLog, "utf8").trim().split("\n");
    expect(spawns.length).toBe(1);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.harness).toBe("claude-code");
    expect(meta.binary_version).toBe(FAKE_VERSION);
    // workdir is recorded because the captured frame renders an absolute path
    // verbatim — a reader can tell it is a recorder artifact.
    expect(typeof meta.workdir).toBe("string");
    expect(meta.workdir.length).toBeGreaterThan(0);
    expect(meta.keystrokes).toBe("none (dialog captured unanswered)");

    // Self-consistency replay, same shape as the codex triple test.
    const bytes = new Uint8Array(readFileSync(join(out, "bytes.raw")));
    const screen = newScreen(meta.cols, meta.rows);
    await screen.write(bytes);
    const strip = (s: string) => s.replace(/\s+$/u, "");
    expect(
      NormalizedDistance(strip(screen.snapshot().text), strip(expected)),
    ).toBe(0);
  }, 60_000);

  // NO-AUTO-ANSWER PROOF: the script blocks on a menu choice after the dialog
  // frame and only then paints the ready composer. The recorder must finish
  // with the dialog still up — leaving it unanswered is what keeps
  // hasTrustDialogAccepted unwritten for the throwaway directory.
  test("never answers the dialog", async () => {
    const out = outDir("trust-dialog");
    const code = await runRecorder(
      [
        "--harness",
        "claude-code",
        "--scenario",
        "trust-dialog",
        "--out",
        out,
        "--bin",
        fakeHarness,
      ],
      claudeScript((b) =>
        b.ClaudeTrustPrompt(0).AwaitMenuChoice().Idle().StayAliveUntilStopped(),
      ),
    );
    expect(code).toBe(ExitOK);
    const expected = readFileSync(join(out, "expected.txt"), "utf8");
    expect(expected).toContain(anchor);
    // The post-choice Idle frame paints claude's resume hint; its absence means
    // AwaitMenuChoice never fired.
    expect(expected).not.toContain("claude --resume");
  }, 60_000);

  // Pin the non-overlap the proof above relies on: AwaitMenuChoice matches a
  // digit followed by CR, which the 2.1.251 answer keystroke (ESC [ B then CR)
  // is NOT — so a recorder that *did* answer would still not trip that wait.
  // Documented here so the proof above is read as a real assertion.
  test("AwaitMenuChoice's digit+CR pattern does not match ESC[B + CR", () => {
    expect(new RegExp("[0-9]\\r").test("\x1b[B\r")).toBe(false);
    expect(new RegExp("[0-9]\\r").test("1\r")).toBe(true);
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

// ---- recorderOwnedMeta (the overwrite guard's predicate) --------------------

describe("recorderOwnedMeta", () => {
  test("a meta.json this CLI wrote is owned", () => {
    expect(
      recorderOwnedMeta({
        recorder: "src/cli/screenbench-record.ts (scripted steps)",
      }),
    ).toBe(true);
  });

  test("the pre-`recorder` shape this CLI used to write is owned", () => {
    // Every recorder-written cell on disk today predates the `recorder` field.
    // Without this the guard would refuse to re-record the cells rebake owns.
    expect(
      recorderOwnedMeta({
        harness: "codex",
        binary_version: "0.52.0",
        recorded_at: "2026-01-01T00:00:00.000Z",
        cols: 120,
        rows: 40,
        notes: "screenbench-record multi-turn: …",
      }),
    ).toBe(true);
  });

  test("a hand-captured meta.json is NOT owned", () => {
    // The real shape from test/corpus/claude-code/permission-mode-cycle.
    expect(
      recorderOwnedMeta({
        harness: "claude-code",
        mode: "scripted-probe",
        recorder: "test/corpus/tools/probe-shift-tab.ts (PTY bridge)",
        measured_ring_length: 4,
        not_measured: ["bypass"],
      }),
    ).toBe(false);
    expect(
      recorderOwnedMeta({
        harness: "claude-code",
        binary_version: "2.1.218",
        cols: 120,
        rows: 40,
        notes: "…",
        mode: "hand-recorded-interactive",
      }),
    ).toBe(false);
  });

  test("it fails CLOSED on anything it cannot recognize", () => {
    expect(recorderOwnedMeta(null)).toBe(false);
    expect(recorderOwnedMeta("nope")).toBe(false);
    expect(recorderOwnedMeta([])).toBe(false);
    expect(recorderOwnedMeta({ recorder: 42 })).toBe(false);
  });
});

// ---- the real corpus, read as data ------------------------------------------

describe("overwrite guard vs. the checked-in corpus", () => {
  // The guard is only worth having if it draws the line in the right place on
  // the ACTUAL artifacts: every hand-captured cell protected, every
  // recorder-written cell still re-recordable by rebake.
  test("hand-captured cells are protected, recorder cells are not", () => {
    const handCaptured = [
      "claude-code/permission-mode-cycle",
      "claude-code/permission-mode-manual",
      "codex/permission-mode-cycle",
      "codex/status-box",
    ];
    for (const cell of handCaptured) {
      const meta = JSON.parse(
        readFileSync(join(root, "test", "corpus", cell, "meta.json"), "utf8"),
      );
      expect(recorderOwnedMeta(meta), `${cell} must be protected`).toBe(false);
    }
    for (const cell of ["codex/multi-turn", "claude-code/tool-call"]) {
      const meta = JSON.parse(
        readFileSync(join(root, "test", "corpus", cell, "meta.json"), "utf8"),
      );
      expect(recorderOwnedMeta(meta), `${cell} must be re-recordable`).toBe(
        true,
      );
    }
  });
});

// ---- pre-write guards (scripted steps) --------------------------------------
//
// Each case here must refuse BEFORE any file is written, so a rejected request
// never leaves a partial scenario dir behind for `discover` to pick up. The
// scenarios are injected into the exported catalog and removed again: this
// ticket adds the interpreter, and the dialog-driving catalog entries land with
// the hermetic dialog recordings in the next child.
async function withScenario<T>(
  name: string,
  sc: (typeof scenarios)[string],
  fn: () => Promise<T>,
): Promise<T> {
  scenarios[name] = sc;
  try {
    return await fn();
  } finally {
    delete scenarios[name];
  }
}

describe("pre-write guards", () => {
  test("a cycle step on a harness with no cycle keystroke is refused", async () => {
    // pi's adapter implements no permissionCycleKeys(); claude-code's and
    // codex's do. The bytes are never hard-coded here — the refusal is decided
    // by the same structural probe the chat layer uses.
    const out = outDir("cycle-guard");
    const code = await withScenario(
      "cycle-guard",
      { steps: [{ kind: "cycle" }], notes: "guard" },
      () =>
        runRecorder(
          [
            "--harness",
            "pi",
            "--out",
            out,
            "--scenario",
            "cycle-guard",
            "--bin",
            fakeHarness,
          ],
          codexScript(1),
        ),
    );
    expect(code).toBe(ExitError);
    expect(existsSync(out)).toBe(false);
  });

  test("a requiresHarness mismatch is refused", async () => {
    const out = outDir("harness-guard");
    const code = await withScenario(
      "harness-guard",
      {
        prompts: ["hello"],
        requiresHarness: "claude-code",
        notes: "guard",
      },
      () =>
        runRecorder(
          [
            "--harness",
            "codex",
            "--out",
            out,
            "--scenario",
            "harness-guard",
            "--bin",
            fakeHarness,
          ],
          codexScript(1),
        ),
    );
    expect(code).toBe(ExitError);
    expect(existsSync(out)).toBe(false);
  });

  test("a dump step with a traversing filename is a usage error", async () => {
    const out = outDir("dump-guard");
    const code = await withScenario(
      "dump-guard",
      {
        steps: [{ kind: "dump", file: "../escaped.txt" }],
        notes: "guard",
      },
      () =>
        runRecorder(
          [
            "--harness",
            "codex",
            "--out",
            out,
            "--scenario",
            "dump-guard",
            "--bin",
            fakeHarness,
          ],
          codexScript(1),
        ),
    );
    expect(code).toBe(ExitUsage);
    expect(existsSync(out)).toBe(false);
  });

  test("a scenario declaring both prompts and steps is a usage error", async () => {
    const out = outDir("both-guard");
    const code = await withScenario(
      "both-guard",
      {
        prompts: ["hello"],
        steps: [{ kind: "await-turn" }],
        notes: "guard",
      },
      () =>
        runRecorder(
          [
            "--harness",
            "codex",
            "--out",
            out,
            "--scenario",
            "both-guard",
            "--bin",
            fakeHarness,
          ],
          codexScript(1),
        ),
    );
    expect(code).toBe(ExitUsage);
    expect(existsSync(out)).toBe(false);
  });

  test("--prompt against a catalog scenario is a usage error", async () => {
    const out = outDir("multi-turn");
    const code = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        out,
        "--scenario",
        "multi-turn",
        "--prompt",
        "something else",
        "--bin",
        fakeHarness,
      ],
      codexScript(1),
    );
    expect(code).toBe(ExitUsage);
    expect(existsSync(out)).toBe(false);
  });

  test("an unknown scenario WITH --prompt records as an ad-hoc script", async () => {
    const out = outDir("adhoc");
    const code = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        out,
        "--scenario",
        "adhoc",
        "--prompt",
        "what is the capital of France",
        "--bin",
        fakeHarness,
      ],
      codexScript(1),
    );
    expect(code).toBe(ExitOK);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.steps).toEqual([
      { kind: "prompt", text: "what is the capital of France" },
      { kind: "await-turn" },
    ]);
  }, 60_000);
});

// ---- the overwrite guard, end to end ----------------------------------------

describe("overwrite guard", () => {
  function handCaptured(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const meta = join(dir, "meta.json");
    writeFileSync(
      meta,
      JSON.stringify(
        {
          harness: "claude-code",
          mode: "hand-recorded-interactive",
          recorder: "test/corpus/tools/record-pty.ts --interactive",
          notes: "the measured ring length and both probed encodings",
        },
        null,
        2,
      ),
    );
    return meta;
  }

  test("refuses to overwrite a hand-captured recording, writing nothing", async () => {
    const out = outDir("tool-call");
    const meta = handCaptured(out);
    const before = readFileSync(meta, "utf8");
    const code = await runRecorder(
      ["--harness", "codex", "--out", out, "--bin", fakeHarness],
      codexScript(1),
    );
    expect(code).toBe(ExitError);
    // Nothing written: the prose is intact and no recording was started.
    expect(readFileSync(meta, "utf8")).toBe(before);
    expect(existsSync(join(out, "bytes.raw"))).toBe(false);
    expect(existsSync(join(out, "expected.txt"))).toBe(false);
  });

  test("--allow-overwrite proceeds", async () => {
    const out = outDir("tool-call");
    handCaptured(out);
    const code = await runRecorder(
      [
        "--harness",
        "codex",
        "--out",
        out,
        "--bin",
        fakeHarness,
        "--allow-overwrite",
      ],
      codexScript(1),
    );
    expect(code).toBe(ExitOK);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.mode).toBe("scripted");
    expect(meta.recorder).toMatch(/^src\/cli\/screenbench-record\.ts/);
  }, 60_000);

  test("re-records over its OWN output without the flag", async () => {
    const out = outDir("tool-call");
    const args = ["--harness", "codex", "--out", out, "--bin", fakeHarness];
    expect(await runRecorder(args, codexScript(1))).toBe(ExitOK);
    expect(await runRecorder(args, codexScript(1))).toBe(ExitOK);
  }, 60_000);
});

// ---- the step interpreter, against the hermetic fake -----------------------

/** Captures everything the recorder writes to stderr during `fn`. */
async function captureStderr(
  fn: () => Promise<number>,
): Promise<[number, string]> {
  let text = "";
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown) => {
      text += String(chunk);
      return true;
    });
  try {
    return [await fn(), text];
  } finally {
    spy.mockRestore();
  }
}

describe("step interpreter", () => {
  // The `keys` step drives the fake through AwaitSubmit without a `prompt`
  // step: the fake deliberately does NOT echo keystrokes onto the screen it
  // paints, so claude-code's "prompt was not echoed" assertion cannot be
  // satisfied hermetically. Writing the submit key directly exercises the same
  // interpreter path with none of that coupling.
  const submitKeys = "\\x1b[13u";

  test("records a scripted claude run: stdin.log, keystrokes, steps, no warmup", async () => {
    const out = outDir("scripted");
    const spawnLog = join(mkdtempSync(join(tmpdir(), "sbrec-spawn-")), "log");
    const code = await withScenario(
      "scripted",
      {
        steps: [
          { kind: "keys", bytes: submitKeys, label: "submit" },
          { kind: "await-turn" },
          { kind: "dump", file: "screen-final.txt" },
        ],
        notes: "scripted keys + turn + dump",
      },
      () =>
        runRecorder(
          [
            "--harness",
            "claude-code",
            "--out",
            out,
            "--scenario",
            "scripted",
            "--bin",
            fakeHarness,
            "--no-warmup",
            "--launch-arg",
            "--verbose",
          ],
          claudeScript((b) =>
            b
              .Idle()
              .AwaitSubmit()
              .Reply(40, "the answer is Paris", "Cerebrating", "3s")
              // The /quit teardown writes "/quit" + CSI 13u, which this second
              // AwaitSubmit consumes — so the fake exits on the quit instead of
              // making the recorder wait out its 15 s grace.
              .AwaitSubmit()
              .Exit(0),
          ),
          FAKE_VERSION,
          { FAKE_HARNESS_SPAWN_LOG: spawnLog },
        ),
    );
    expect(code).toBe(ExitOK);

    // --no-warmup proof: exactly one PTY launch (the --version probe exits
    // before the ledger, so it never contributes a line).
    expect(readFileSync(spawnLog, "utf8").trim().split("\n").length).toBe(1);

    // stdin.log: one timestamped, printable()-rendered line per write.
    const log = readFileSync(join(out, "stdin.log"), "utf8").trimEnd();
    expect(log.split("\n").length).toBe(1);
    expect(log).toMatch(/^\s*\d+\.\d{3}s {2}submit {5}\\x1b\[13u$/);

    // The dump step wrote its screen inside --out.
    expect(existsSync(join(out, "screen-final.txt"))).toBe(true);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.mode).toBe("scripted");
    expect(meta.recorder).toMatch(/^src\/cli\/screenbench-record\.ts/);
    expect(meta.launch_args).toEqual(["--verbose"]);
    expect(meta.keystrokes).toEqual(["\\x1b[13u"]);
    // The expanded script is recorded verbatim.
    expect(meta.steps).toEqual([
      { kind: "keys", bytes: submitKeys, label: "submit" },
      { kind: "await-turn" },
      { kind: "dump", file: "screen-final.txt" },
    ]);
  }, 60_000);

  test("an answer step with no pending request fails by name, writing no meta", async () => {
    const out = outDir("answer-nothing");
    const [code, err] = await captureStderr(() =>
      withScenario(
        "answer-nothing",
        {
          steps: [{ kind: "answer", optionID: "1" }],
          notes: "guard",
        },
        () =>
          runRecorder(
            [
              "--harness",
              "claude-code",
              "--out",
              out,
              "--scenario",
              "answer-nothing",
              "--bin",
              fakeHarness,
              "--no-warmup",
            ],
            claudeScript((b) => b.Idle().StayAliveUntilStopped()),
          ),
      ),
    );
    expect(code).toBe(ExitError);
    expect(err).toContain("no pending input request");
    // A null deref would have produced a TypeError instead of this.
    expect(err).toContain("must follow an `await-input` step");
    // Partial bytes.raw is expected (today's behaviour); a meta.json is not.
    expect(existsSync(join(out, "meta.json"))).toBe(false);
    expect(existsSync(join(out, "expected.txt"))).toBe(false);
  }, 60_000);

  test("an answer step with an unknown option lists the available ids", async () => {
    const out = outDir("answer-unknown");
    const [code, err] = await captureStderr(() =>
      withScenario(
        "answer-unknown",
        {
          steps: [
            { kind: "keys", bytes: submitKeys },
            { kind: "await-input", timeoutMs: 30_000 },
            { kind: "answer", optionID: "no-such-option" },
          ],
          notes: "guard",
        },
        () =>
          runRecorder(
            [
              "--harness",
              "claude-code",
              "--out",
              out,
              "--scenario",
              "answer-unknown",
              "--bin",
              fakeHarness,
              "--no-warmup",
            ],
            claudeScript((b) =>
              b
                .Idle()
                .AwaitSubmit()
                .Question(40, " ☐ Colour", "Which colour?", [
                  ["Red", "the warm one"],
                  ["Blue", "the cool one"],
                ])
                .StayAliveUntilStopped(),
            ),
          ),
      ),
    );
    expect(code).toBe(ExitError);
    expect(err).toContain("no-such-option");
    // The ids that WERE available — the whole point of surfacing this one.
    expect(err).toMatch(/available option ids: [^\n]*1/);
    expect(existsSync(join(out, "meta.json"))).toBe(false);
  }, 60_000);
});

describe("step interpreter: answering and cycling", () => {
  const submitKeys = "\\x1b[13u";

  test("answers a question pane through the chat layer's own byte semantics", async () => {
    const out = outDir("answered");
    const code = await withScenario(
      "answered",
      {
        steps: [
          { kind: "keys", bytes: submitKeys },
          { kind: "await-input", inputKind: "question", timeoutMs: 30_000 },
          { kind: "answer", optionID: "1" },
        ],
        notes: "answers the first option",
      },
      () =>
        runRecorder(
          [
            "--harness",
            "claude-code",
            "--out",
            out,
            "--scenario",
            "answered",
            "--bin",
            fakeHarness,
            "--no-warmup",
          ],
          claudeScript((b) =>
            b
              .Idle()
              .AwaitSubmit()
              .Question(40, " ☐ Colour", "Which colour?", [
                ["Red", "the warm one"],
                ["Blue", "the cool one"],
              ])
              // The answer is written as the option's OWN keys — never bytes
              // this test picked — so this wait is what proves they landed.
              .AwaitDigit()
              .Reply(40, "Red it is", "Cerebrating", "2s")
              .AwaitSubmit()
              .Exit(0),
          ),
        ),
    );
    expect(code).toBe(ExitOK);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    // Two writes: the submit key, then the option's keys.
    expect(meta.keystrokes.length).toBe(2);
    expect(meta.keystrokes[0]).toBe("\\x1b[13u");
    // stdin.log carries the same writes, labelled.
    const log = readFileSync(join(out, "stdin.log"), "utf8");
    expect(log).toMatch(/answer1/);
  }, 60_000);

  test("a cycle step dumps one screen per press and never hard-codes the bytes", async () => {
    const out = outDir("cycled");
    const code = await withScenario(
      "cycled",
      {
        steps: [{ kind: "cycle", presses: 2 }],
        notes: "two permission-mode presses",
      },
      () =>
        runRecorder(
          [
            "--harness",
            "claude-code",
            "--out",
            out,
            "--scenario",
            "cycled",
            "--bin",
            fakeHarness,
            "--no-warmup",
          ],
          claudeScript((b) =>
            b
              .Idle()
              // Each wait matches the adapter's OWN cycle encoding; a recorder
              // that invented its own bytes would hang here.
              .AwaitPermissionCycle()
              .PermissionFooter(40, "plan")
              .AwaitPermissionCycle()
              .PermissionFooter(40, "acceptEdits")
              .AwaitSubmit()
              .Exit(0),
          ),
        ),
    );
    expect(code).toBe(ExitOK);
    expect(existsSync(join(out, "screen-press-01.txt"))).toBe(true);
    expect(existsSync(join(out, "screen-press-02.txt"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.keystrokes).toEqual(["\\x1b[Z", "\\x1b[Z"]);
  }, 60_000);

  // --stop-on-input + --keys compose into an ad-hoc script, in that order: the
  // stop condition first, the scripted keys after it.
  test("--stop-on-input and --keys compose into an ad-hoc script", async () => {
    const out = outDir("adhoc-stop");
    const code = await runRecorder(
      [
        "--harness",
        "claude-code",
        "--out",
        out,
        "--scenario",
        "adhoc-stop",
        "--bin",
        fakeHarness,
        "--no-warmup",
        "--stop-on-input=question",
        "--keys",
        "1",
      ],
      claudeScript((b) =>
        b
          .Idle()
          .Question(40, " ☐ Colour", "Which colour?", [
            ["Red", "the warm one"],
            ["Blue", "the cool one"],
          ])
          .AwaitDigit()
          .Reply(40, "Red it is", "Cerebrating", "2s")
          .AwaitSubmit()
          .Exit(0),
      ),
    );
    expect(code).toBe(ExitOK);
    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.steps).toEqual([
      { kind: "await-input", inputKind: "question" },
      { kind: "keys", bytes: "1" },
    ]);
    expect(meta.keystrokes).toEqual(["1"]);
  }, 60_000);
});

describe("--attempts", () => {
  // A half-answered dialog cannot be rewound, so a retry is always the WHOLE
  // run: teardown, truncate bytes.raw, start over.
  test("retries a timed-out await-input, and only that", async () => {
    const out = outDir("retry");
    const [code, err] = await captureStderr(() =>
      withScenario(
        "retry",
        {
          steps: [{ kind: "await-input", timeoutMs: 1_000 }],
          notes: "never asks",
        },
        () =>
          runRecorder(
            [
              "--harness",
              "claude-code",
              "--out",
              out,
              "--scenario",
              "retry",
              "--bin",
              fakeHarness,
              "--no-warmup",
              "--attempts",
              "2",
            ],
            claudeScript((b) => b.Idle().StayAliveUntilStopped()),
          ),
      ),
    );
    expect(code).toBe(ExitError);
    expect(err).toContain("attempt 1/2");
    expect(err).toContain("re-recording from scratch");
    // The retry did not accumulate: no meta.json, and the second attempt's
    // bytes.raw replaced the first's rather than being appended to it.
    expect(existsSync(join(out, "meta.json"))).toBe(false);
  }, 60_000);

  test("does NOT retry a deterministic failure", async () => {
    const out = outDir("no-retry");
    const [code, err] = await captureStderr(() =>
      withScenario(
        "no-retry",
        { steps: [{ kind: "answer", optionID: "1" }], notes: "guard" },
        () =>
          runRecorder(
            [
              "--harness",
              "claude-code",
              "--out",
              out,
              "--scenario",
              "no-retry",
              "--bin",
              fakeHarness,
              "--no-warmup",
              "--attempts",
              "3",
            ],
            claudeScript((b) => b.Idle().StayAliveUntilStopped()),
          ),
      ),
    );
    expect(code).toBe(ExitError);
    expect(err).not.toContain("re-recording from scratch");
  }, 60_000);
});
