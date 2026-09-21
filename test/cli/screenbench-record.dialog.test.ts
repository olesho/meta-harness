// Hermetic tests for the recorder's DIALOG catalog cells (PUPPET-313).
//
// A separate file from test/cli/screenbench-record.test.ts on purpose: that
// file's assertions cover the interpreter's vocabulary (PUPPET-312) and stay
// untouched and reviewable. What is new here is the CATALOG — the nine
// claude-code cells whose terminal state is an AskUserQuestion pane or a
// permission-mode footer — so these tests drive the catalog entries THEMSELVES
// wherever they can, rather than test-local look-alikes. A step list that
// drifts from what the fixtures were recorded with fails here.
//
// Everything runs against a real PTY and the shared fake harness
// (test/cli/testdata/fake-record-harness.mjs) built with the Builder frame
// vocabulary (test/chat/fakeharness.ts). No live binary, no network, no cost.
//
// WHAT THESE TESTS DO NOT PROVE: that the cells record correctly against the
// REAL claude binary. That is a live question with a live answer, and
// test/corpus/README.md records the per-cell status. See in particular the
// 2.1.252 readiness finding recorded there — it blocks live recording of every
// claude-code cell, legacy ones included, and no hermetic test can see it,
// because the fake's Idle() paints the bare "❯" composer the readiness
// predicate was written against.

import { describe, expect, test, vi } from "vitest";
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
  main,
  scenarios,
  echoProbe,
  ExitOK,
  ExitError,
} from "../../src/cli/screenbench-record.ts";
import { expandScenario, type Step } from "../../src/cli/recordSteps.ts";
import { New as newClaudeAdapter } from "../../src/turns/harness/claudecode.ts";
import { New, type Builder } from "../chat/fakeharness.ts";
import { newScreen } from "../../src/screen/index.ts";
import { NormalizedDistance } from "../corpus/tools/screenbench-metrics.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fakeHarness = join(here, "testdata", "fake-record-harness.mjs");

try {
  chmodSync(fakeHarness, 0o755);
} catch {
  /* best effort */
}

const FAKE_VERSION = "7.7.7";

/** The submit key claude-code's adapter writes (CSI 13u), in `keys` spelling. */
const submitKeys = "\\x1b[13u";

function claudeScript(build: (b: Builder) => Builder): string {
  const b = build(New("claude-code"));
  const dir = mkdtempSync(join(tmpdir(), "sbrec-dlg-script-"));
  const p = join(dir, "script.json");
  writeFileSync(p, JSON.stringify(b.Build()), { mode: 0o600 });
  return p;
}

async function runRecorder(
  argv: string[],
  scriptPath: string,
  extraEnv: Record<string, string> = {},
): Promise<number> {
  const saved = new Map<string, string | undefined>();
  const env: Record<string, string> = {
    FAKEHARNESS_SCRIPT: scriptPath,
    FAKE_HARNESS_VERSION: FAKE_VERSION,
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) {
    saved.set(k, process.env[k]);
    process.env[k] = v;
  }
  try {
    return await main(argv);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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

/** Registers a test-local catalog entry for the duration of `fn`. */
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

function outDir(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "sbrec-dlg-out-")), name);
}

/** The argv every recording here shares. */
function baseArgs(scenario: string, out: string): string[] {
  return [
    "--harness",
    "claude-code",
    "--out",
    out,
    "--scenario",
    scenario,
    "--bin",
    fakeHarness,
    // The fake is not a claude and persists no trust decision, so a warmup pass
    // would be a second PTY launch that proves nothing.
    "--no-warmup",
  ];
}

/** bytes.raw replayed through a fresh screen must equal expected.txt. */
async function assertSelfConsistent(out: string): Promise<void> {
  const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
  const bytes = new Uint8Array(readFileSync(join(out, "bytes.raw")));
  const expected = readFileSync(join(out, "expected.txt"), "utf8");
  const screen = newScreen(meta.cols, meta.rows);
  await screen.write(bytes);
  const strip = (s: string) => s.replace(/\s+$/u, "");
  expect(
    NormalizedDistance(strip(screen.snapshot().text), strip(expected)),
  ).toBe(0);
}

/** The prompt text a catalog scenario's first `prompt` step carries. */
function promptOf(scenario: string): string {
  const first = (scenarios[scenario].steps ?? [])[0];
  if (!first || first.kind !== "prompt") {
    throw new Error(`scenario ${scenario} does not open with a prompt step`);
  }
  return first.text;
}

/**
 * The fake's half of a `prompt` step: block on the typed burst, paint the
 * composer echo the recorder asserts, then block on the submit key.
 */
function sendPrompt(b: Builder, text: string): Builder {
  return b.AwaitTyped(text).ClaudeComposerTyped(40, text).AwaitSubmit();
}

const colorOptions = [
  ["Red", "the warm one"],
  ["Blue", "the cool one"],
];

// ---- 1. record-until-dialog -------------------------------------------------

describe("question-single (catalog)", () => {
  test("records the unanswered question pane as a self-consistent triple", async () => {
    const out = outDir("question-single");
    const prompt = promptOf("question-single");
    const code = await runRecorder(
      baseArgs("question-single", out),
      claudeScript((b) =>
        sendPrompt(b.Idle(), prompt)
          .Question(
            60,
            "←  ☐ Color  →",
            "Which color should I use?",
            colorOptions,
          )
          .StayAliveUntilStopped(),
      ),
    );
    expect(code).toBe(ExitOK);

    for (const f of ["bytes.raw", "meta.json", "expected.txt", "stdin.log"]) {
      expect(existsSync(join(out, f))).toBe(true);
    }

    const expected = readFileSync(join(out, "expected.txt"), "utf8");
    expect(expected).toContain("Which color should I use?");
    expect(expected).toContain("1. Red");
    expect(expected).toContain("2. Blue");
    await assertSelfConsistent(out);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    // The recorded script is the CATALOG's, verbatim — the artifact says
    // exactly what was driven.
    expect(meta.steps).toEqual(expandScenario(scenarios["question-single"]));
    // The pane is left untouched: the prompt burst and the submit key, nothing
    // after, which is what the PUPPET-301 hand-capture's stdin.log records.
    expect(meta.keystrokes).toEqual([prompt, submitKeys]);
  }, 60_000);

  test("the composer echo is probed on a prefix, so a WRAPPED prompt passes", () => {
    const prompt = promptOf("question-single");
    // The premise: this prompt cannot fit one row of the 120-column geometry
    // every corpus cell is recorded at, so it is necessarily wrapped on screen
    // and a full-string `includes` could never match it.
    expect(prompt.length).toBeGreaterThan(120);
    expect(echoProbe(prompt).length).toBeLessThan(60);
    expect(prompt.startsWith(echoProbe(prompt))).toBe(true);
    // …and the preceding recording test is the end-to-end half of this: it
    // drives the real prompt through a real 120-column screen.
  });
});

// ---- 1b. the multi-select cell and its pre-toggle dump ---------------------

describe("question-multi (catalog)", () => {
  test("dumps the pre-toggle screen, then records the toggled one", async () => {
    const out = outDir("question-multi");
    const prompt = promptOf("question-multi");
    const toppings = ["Mushrooms", "Olives", "Peppers", "Onions"];
    const pane = (marks: string[]): string[][] =>
      toppings.map((t, i) => [`${marks[i]} ${t}`, ""]);
    const code = await runRecorder(
      baseArgs("question-multi", out),
      claudeScript((b) =>
        sendPrompt(b.Idle(), prompt)
          .Question(
            60,
            "←  ☐ Toppings  ✔ Submit  →",
            "Which toppings do you want?",
            pane(["[ ]", "[ ]", "[ ]", "[ ]"]),
          )
          // The fake blocks here, so the pre-toggle frame is unambiguously the
          // one the `dump` step captured.
          .AwaitDigit()
          .Question(
            60,
            "←  ☐ Toppings  ✔ Submit  →",
            "Which toppings do you want?",
            pane(["[✔]", "[ ]", "[ ]", "[ ]"]),
          )
          .AwaitSubmit()
          .Exit(0),
      ),
    );
    expect(code).toBe(ExitOK);

    // The two artifacts differ by exactly the toggle — which is the whole
    // point of producing expected-untoggled.txt from a `dump` step placed
    // before the keystroke rather than from a recorded byte offset.
    const untoggled = readFileSync(join(out, "expected-untoggled.txt"), "utf8");
    const expected = readFileSync(join(out, "expected.txt"), "utf8");
    expect(untoggled).toContain("[ ] Mushrooms");
    expect(untoggled).not.toContain("[✔]");
    expect(expected).toContain("[✔] Mushrooms");
    expect(expected).toContain("[ ] Olives");

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.steps).toEqual(expandScenario(scenarios["question-multi"]));
    // A bare digit, NOT a digit plus a commit: on a checkbox row it toggles in
    // place, which is what the PUPPET-301 capture measured live.
    expect(meta.keystrokes).toEqual([prompt, submitKeys, "1"]);
  }, 60_000);
});

// ---- 2. answer through the production seam ---------------------------------

describe("answer steps", () => {
  test("an answer step writes the option's OWN keys and logs them", async () => {
    const out = outDir("answered-single");
    const code = await withScenario(
      "answered-single",
      {
        requiresHarness: "claude-code",
        steps: [
          { kind: "keys", bytes: submitKeys, label: "submit" },
          { kind: "await-input", inputKind: "question", timeoutMs: 30_000 },
          { kind: "answer", optionID: "1" },
        ],
        notes: "answers a single-select pane through answerKeys()",
      },
      () =>
        runRecorder(
          baseArgs("answered-single", out),
          claudeScript((b) =>
            b
              .Idle()
              .AwaitSubmit()
              .Question(
                40,
                " ☐ Color",
                "Which color should I use?",
                colorOptions,
              )
              // Reaching the next frame IS the assertion that '1' was written:
              // the fake blocks here until a bare digit arrives, and the digit
              // came from answerKeys(), never from this test.
              .AwaitDigit()
              .QuestionAnswered(40, [["Which color should I use?", "Red"]])
              .AwaitSubmit()
              .Exit(0),
          ),
        ),
    );
    expect(code).toBe(ExitOK);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.keystrokes).toEqual([submitKeys, "1"]);
    const log = readFileSync(join(out, "stdin.log"), "utf8");
    expect(log).toMatch(/answer1 +1$/m);
  }, 60_000);

  // ---- 3. multi-select: toggles THEN the commit key, in order ---------------
  test("a multi-select answer toggles each option then commits, in order", async () => {
    const out = outDir("answered-multi");
    const code = await withScenario(
      "answered-multi",
      {
        requiresHarness: "claude-code",
        steps: [
          { kind: "keys", bytes: submitKeys, label: "submit" },
          { kind: "await-input", inputKind: "question", timeoutMs: 30_000 },
          { kind: "answer", optionIDs: ["1", "2"] },
        ],
        notes: "toggles two checkbox rows and commits",
      },
      () =>
        runRecorder(
          baseArgs("answered-multi", out),
          claudeScript((b) =>
            b
              .Idle()
              .AwaitSubmit()
              // "[ ]" on every row is what makes the pane MULTI-SELECT to the
              // production parser (parseQuestionRegion's checkbox test), which
              // is what gives the request its submitKeys.
              .Question(40, " ☐ Toppings", "Which toppings do you want?", [
                ["[ ] Mushrooms", ""],
                ["[ ] Olives", ""],
              ])
              .AwaitDigit()
              .AwaitDigit()
              // The commit key is a bare tab — claudecode.ts pins it as the
              // request's submitKeys, and this gate is what proves it was sent
              // rather than assumed.
              .AwaitTyped("\t")
              .QuestionAnswered(40, [
                ["Which toppings do you want?", "Mushrooms, Olives"],
              ])
              .AwaitSubmit()
              .Exit(0),
          ),
        ),
    );
    expect(code).toBe(ExitOK);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    // ORDER is the assertion: both toggles, then the commit — a bare toggle
    // would leave the dialog up forever, and a commit-first would answer
    // nothing.
    expect(meta.keystrokes).toEqual([submitKeys, "1", "2", "\\t"]);
    const log = readFileSync(join(out, "stdin.log"), "utf8");
    const answers = log
      .split("\n")
      .filter((l) => l.includes("answer"))
      .map((l) => l.trim().split(/\s+/).slice(-1)[0]);
    expect(answers).toEqual(["1", "2", "\\t"]);
  }, 60_000);
});

// ---- 4. the review pane: a new request supersedes the old -------------------

describe("question-review (catalog)", () => {
  test("latches each pane in turn and ends on the review pane", async () => {
    const out = outDir("question-review");
    const prompt = promptOf("question-review");
    const code = await runRecorder(
      baseArgs("question-review", out),
      claudeScript((b) =>
        sendPrompt(b.Idle(), prompt)
          .Question(
            60,
            "←  ☐ Color  ☐ Size  ✔ Submit  →",
            "Which color should I use?",
            colorOptions,
          )
          .AwaitDigit()
          .Question(
            60,
            "←  ☒ Color  ☐ Size  ✔ Submit  →",
            "Which size should I use?",
            [
              ["Small", "the little one"],
              ["Large", "the big one"],
            ],
          )
          .AwaitDigit()
          .QuestionReview(60, "←  ☒ Color  ☒ Size  ✔ Submit  →", [
            ["Which color should I use?", "Red"],
            ["Which size should I use?", "Small"],
          ])
          .StayAliveUntilStopped(),
      ),
    );
    expect(code).toBe(ExitOK);

    const expected = readFileSync(join(out, "expected.txt"), "utf8");
    expect(expected).toContain("Review your answers");
    expect(expected).toContain("Submit answers");
    await assertSelfConsistent(out);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.steps).toEqual(expandScenario(scenarios["question-review"]));
    // Prompt, submit, and the two bare digits — the PUPPET-301 capture's
    // stdin.log exactly.
    expect(meta.keystrokes).toEqual([prompt, submitKeys, "1", "1"]);
  }, 60_000);
});

// ---- 5. scripted keys: the cycle cells -------------------------------------

describe("permission-mode cells (catalog)", () => {
  test("permission-mode-accept-edits presses the ADAPTER's cycle keys, twice", async () => {
    const out = outDir("permission-mode-accept-edits");
    const code = await runRecorder(
      baseArgs("permission-mode-accept-edits", out),
      claudeScript((b) =>
        b
          .Idle()
          // Each gate matches the adapter's OWN encoding, so a recorder that
          // invented its own bytes would hang here rather than pass.
          .AwaitPermissionCycle()
          .PermissionFooter(40, "manual")
          .AwaitPermissionCycle()
          .PermissionFooter(40, "acceptEdits")
          .AwaitSubmit()
          .Exit(0),
      ),
    );
    expect(code).toBe(ExitOK);

    expect(existsSync(join(out, "screen-press-01.txt"))).toBe(true);
    expect(existsSync(join(out, "screen-press-02.txt"))).toBe(true);
    expect(existsSync(join(out, "screen-press-03.txt"))).toBe(false);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.steps).toEqual([{ kind: "cycle", presses: 2 }]);
    // Read from the adapter, NEVER hard-coded here: claudecode.ts is the one
    // place the encoding is pinned (test/turns/permission_cycle.test.ts keeps
    // it there).
    const cycle = newClaudeAdapter().permissionCycleKeys();
    const rendered = Array.from(cycle)
      .map((byte) =>
        byte === 0x1b
          ? "\\x1b"
          : byte < 0x20
            ? "\\x" + byte.toString(16).padStart(2, "0")
            : String.fromCharCode(byte),
      )
      .join("");
    expect(meta.keystrokes).toEqual([rendered, rendered]);

    // The rung reached on the last press is the one the fixture is FOR.
    expect(readFileSync(join(out, "expected.txt"), "utf8")).toContain(
      "accept edits on",
    );
    expect(readFileSync(join(out, "screen-press-01.txt"), "utf8")).toContain(
      "manual mode on",
    );
  }, 60_000);

  // ---- 7. launchArgs actually reach the harness's argv ----------------------
  test("permission-mode-bypass's launchArgs reach the harness argv", async () => {
    const out = outDir("permission-mode-bypass");
    const code = await runRecorder(
      baseArgs("permission-mode-bypass", out),
      claudeScript((b) =>
        b.Idle().PermissionFooter(60, "bypass").StayAliveUntilStopped(),
      ),
      // The fake EXITS NON-ZERO unless this argument is in its argv, so exit 0
      // is itself the proof — meta.json alone could not distinguish "passed to
      // the process" from "written into the file".
      { FAKE_HARNESS_REQUIRE_ARG: "bypassPermissions" },
    );
    expect(code).toBe(ExitOK);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    expect(meta.launch_args).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
    // No keys at all: the rung is launched into, never cycled to.
    expect(meta.keystrokes).toEqual([]);
    expect(readFileSync(join(out, "expected.txt"), "utf8")).toContain(
      "bypass permissions on",
    );
  }, 60_000);

  test("a missing launch arg fails the recording, so the check is not vacuous", async () => {
    const out = outDir("bypass-missing-arg");
    const [code] = await captureStderr(() =>
      withScenario(
        "bypass-missing-arg",
        {
          requiresHarness: "claude-code",
          steps: [{ kind: "await-text", text: "bypass permissions on" }],
          notes: "control: same script, no launchArgs",
        },
        () =>
          runRecorder(
            baseArgs("bypass-missing-arg", out),
            claudeScript((b) =>
              b.Idle().PermissionFooter(60, "bypass").StayAliveUntilStopped(),
            ),
            { FAKE_HARNESS_REQUIRE_ARG: "bypassPermissions" },
          ),
      ),
    );
    expect(code).toBe(ExitError);
    expect(existsSync(join(out, "meta.json"))).toBe(false);
  }, 60_000);

  test("a cycle step waits for a ready composer before its first press", async () => {
    // The regression this guards, measured live against claude 2.1.252: with no
    // readiness gate the first Shift+Tab is written at t≈0, before the TUI has
    // put the tty into raw mode, so the escape is ECHOED as literal text and
    // the run still exits 0 with a garbage fixture. Here the fake never paints
    // a ready composer at all, so the gate must fail the run BY NAME.
    const out = outDir("cycle-unready");
    const [code, err] = await captureStderr(() =>
      withScenario(
        "cycle-unready",
        {
          requiresHarness: "claude-code",
          steps: [{ kind: "cycle", presses: 1 }],
          notes: "control: never becomes ready",
        },
        () =>
          runRecorder(
            [...baseArgs("cycle-unready", out), "--attempts", "1"],
            // A blocking trust dialog: not-ready by the production predicate,
            // and exactly the state an untrusted --cwd leaves a real claude in.
            claudeScript((b) => b.ClaudeTrustPrompt(0).StayAliveUntilStopped()),
          ),
      ),
    );
    expect(code).toBe(ExitError);
    expect(err).toContain("ready composer");
    expect(existsSync(join(out, "meta.json"))).toBe(false);
    expect(existsSync(join(out, "screen-press-01.txt"))).toBe(false);
  }, 120_000);
});

// ---- 6. the ad-hoc --keys path (no catalog entry) ---------------------------

describe("ad-hoc dialog driving", () => {
  test("--prompt + --stop-on-input + --keys records without a catalog entry", async () => {
    const out = outDir("adhoc-question");
    const prompt = "ask me a question about colors";
    const code = await runRecorder(
      [
        "--harness",
        "claude-code",
        "--out",
        out,
        "--scenario",
        "adhoc-question",
        "--bin",
        fakeHarness,
        "--no-warmup",
        "--prompt",
        prompt,
        "--stop-on-input=question",
        "--keys",
        "1",
      ],
      claudeScript((b) =>
        sendPrompt(b.Idle(), prompt)
          .Question(40, " ☐ Color", "Which color should I use?", colorOptions)
          .AwaitDigit()
          .QuestionAnswered(40, [["Which color should I use?", "Red"]])
          .AwaitSubmit()
          .Exit(0),
      ),
    );
    expect(code).toBe(ExitOK);

    const meta = JSON.parse(readFileSync(join(out, "meta.json"), "utf8"));
    // --stop-on-input REPLACES the trailing await-turn a --prompt desugars to;
    // the scripted keys follow it.
    expect(meta.steps).toEqual([
      { kind: "prompt", text: prompt },
      { kind: "await-input", inputKind: "question" },
      { kind: "keys", bytes: "1" },
    ]);
    expect(meta.keystrokes).toEqual([prompt, submitKeys, "1"]);
  }, 60_000);
});

// ---- 8. catalog invariants (the legacy cells are untouched) -----------------

describe("dialog catalog invariants", () => {
  const dialogCells = [
    "question-single",
    "question-multi",
    "question-review",
    "permission-mode-manual",
    "permission-mode-accept-edits",
    "permission-mode-plan",
    "permission-mode-cycle",
    "permission-mode-cycle-bypass",
    "permission-mode-bypass",
  ];

  test("every dialog cell is claude-code-only, scripted, and valid", () => {
    for (const name of dialogCells) {
      const sc = scenarios[name];
      expect(sc, name).toBeDefined();
      expect(sc.requiresHarness, name).toBe("claude-code");
      // Scripted, never the legacy `prompts` sugar: these cells stop at a
      // dialog, which the sugar cannot express.
      expect(sc.prompts, name).toBeUndefined();
      expect(sc.steps, name).toBeDefined();
      expect(() => expandScenario(sc)).not.toThrow();
      // Provenance prose is the point of `notes` here, not a label.
      expect(sc.notes.length, name).toBeGreaterThan(80);
    }
  });

  test("the press counts are the rungs the fixtures were captured at", () => {
    const presses = (name: string): number | undefined => {
      const steps: Step[] = scenarios[name].steps ?? [];
      for (const step of steps) {
        if (step.kind === "cycle") return step.presses;
      }
      return undefined;
    };
    // From the launch mode 'auto', the press count IS the rung.
    expect(presses("permission-mode-manual")).toBe(1);
    expect(presses("permission-mode-accept-edits")).toBe(2);
    expect(presses("permission-mode-plan")).toBe(3);
    // The two ring probes: 6 presses from a normal launch (measured ring 4),
    // 7 under --dangerously-skip-permissions (measured ring 5).
    expect(presses("permission-mode-cycle")).toBe(6);
    expect(presses("permission-mode-cycle-bypass")).toBe(7);
    // The bypass rung is off the ring from a normal launch: no presses at all.
    expect(presses("permission-mode-bypass")).toBeUndefined();
  });

  test("the question cells carry the prompts that actually elicited the panes", () => {
    // Verbatim from the PUPPET-301 hand-captures' meta.json.prompt. A reworded
    // prompt is a prompt with no evidence that it elicits the pane.
    expect(promptOf("question-single")).toContain(
      'The question text must be "Which color should I use?"',
    );
    expect(promptOf("question-multi")).toContain("MULTI-SELECT");
    expect(promptOf("question-review")).toContain("exactly TWO questions");
  });

  test("question-multi dumps the pre-toggle screen before it toggles", () => {
    const steps: Step[] = scenarios["question-multi"].steps ?? [];
    const dumpAt = steps.findIndex((s) => s.kind === "dump");
    const keysAt = steps.findIndex((s) => s.kind === "keys");
    expect(dumpAt).toBeGreaterThanOrEqual(0);
    // The ORDER is the artifact's meaning: expected-untoggled.txt must be the
    // frame before the toggle, not after it.
    expect(dumpAt).toBeLessThan(keysAt);
    const dump = steps[dumpAt];
    expect(dump.kind === "dump" ? dump.file : "").toBe(
      "expected-untoggled.txt",
    );
  });

  // rebake's SCENARIOS map lives in a plain .mjs script that runs main() at
  // import time, so it is read as TEXT rather than imported. Parsing it is
  // enough for the two invariants that matter.
  test("every scenario rebake drives exists in the catalog and allows its harness", () => {
    const script = readFileSync(
      join(here, "..", "..", "scripts", "rebake-corpus.mjs"),
      "utf8",
    );
    const block = /const SCENARIOS = \{([\s\S]*?)\n\};/.exec(script);
    if (block === null) throw new Error("SCENARIOS map not found in rebake");
    const body = block[1];
    const wired: [string, string][] = [];
    const rowRE = /^\s*"?([\w-]+)"?:\s*\[([^\]]*)\]/gm;
    for (let m = rowRE.exec(body); m; m = rowRE.exec(body)) {
      for (const q of m[2].matchAll(/"([^"]+)"/g)) wired.push([m[1], q[1]]);
    }
    expect(wired.length).toBeGreaterThan(0);
    for (const [harness, name] of wired) {
      // A rebake entry naming a scenario the catalog does not have would fail
      // at record time, per cell, after the run had already started.
      expect(scenarios[name], `${harness}/${name}`).toBeDefined();
      // …and a cell wired under a harness its own `requiresHarness` refuses
      // would be rejected by the pre-write gate on every single run.
      const required = scenarios[name].requiresHarness;
      if (required !== undefined) {
        expect(required, `${harness}/${name}`).toBe(harness);
      }
    }
  });

  test("the legacy cells still declare `prompts`, not steps", () => {
    for (const name of ["multi-turn", "tool-call", "interrupted-mid-reply"]) {
      expect(scenarios[name].prompts, name).toBeDefined();
      expect(scenarios[name].steps, name).toBeUndefined();
      expect(scenarios[name].requiresHarness, name).toBeUndefined();
    }
    // trust-dialog stays the anchor-terminated, fresh-workdir cell it was.
    expect(scenarios["trust-dialog"].dialog).toBe(true);
    expect(scenarios["trust-dialog"].freshWorkdir).toBe(true);
  });
});
