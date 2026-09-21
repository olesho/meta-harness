// Unit tests for src/cli/recordSteps.ts — the pure scripted-step vocabulary.
//
// Everything here is I/O-free by construction: recordSteps.ts has no PTY, no
// fs and no adapter, which is the whole reason it was split out of
// screenbench-record.ts (PUPPET-306 §5.1). If a test in this file ever needs a
// binary, something has leaked into the pure layer.

import { describe, expect, test } from "vitest";

import {
  decodeKeys,
  expandScenario,
  parseKeysSpec,
  printable,
  stepKinds,
  validateDumpFile,
  validateStep,
  validateSteps,
  type Step,
} from "../../src/cli/recordSteps.ts";

const enc = new TextEncoder();

describe("expandScenario — legacy prompts sugar", () => {
  test("each prompt becomes [prompt, await-turn]", () => {
    expect(expandScenario({ prompts: ["a", "b"] })).toEqual([
      { kind: "prompt", text: "a" },
      { kind: "await-turn" },
      { kind: "prompt", text: "b" },
      { kind: "await-turn" },
    ]);
  });

  test("interrupt: true replaces the LAST await-turn", () => {
    expect(expandScenario({ prompts: ["a", "b"], interrupt: true })).toEqual([
      { kind: "prompt", text: "a" },
      { kind: "await-turn" },
      { kind: "prompt", text: "b" },
      { kind: "interrupt" },
    ]);
  });

  test("empty prompts list is an error", () => {
    expect(() => expandScenario({ prompts: [] })).toThrow(/empty prompts/);
  });

  test("neither prompts nor steps is an error", () => {
    expect(() => expandScenario({})).toThrow(/neither prompts nor steps/);
  });

  test("an empty prompt string is an error", () => {
    expect(() => expandScenario({ prompts: [""] })).toThrow(/non-empty string/);
  });
});

// The three catalog scenarios in src/cli/screenbench-record.ts (and their
// ancestors in test/corpus/tools/record-scenarios.ts) are still declared in the
// legacy shape. These freeze the exact step list each one desugars to, so the
// interpreter rewrite cannot silently change what the shipped corpus records.
describe("expandScenario — the three catalog scenarios", () => {
  test("multi-turn: three prompt/await-turn pairs", () => {
    const prompts = [
      "what is the capital of France",
      "what is its population",
      "how does that compare to Berlin",
    ];
    expect(expandScenario({ prompts })).toEqual([
      { kind: "prompt", text: prompts[0] },
      { kind: "await-turn" },
      { kind: "prompt", text: prompts[1] },
      { kind: "await-turn" },
      { kind: "prompt", text: prompts[2] },
      { kind: "await-turn" },
    ]);
  });

  test("tool-call: one prompt/await-turn pair", () => {
    const text =
      "Use the Read tool to read notes.txt and tell me exactly what it says";
    expect(expandScenario({ prompts: [text] })).toEqual([
      { kind: "prompt", text },
      { kind: "await-turn" },
    ]);
  });

  test("interrupted-mid-reply: the single await-turn becomes interrupt", () => {
    const text = "Write a detailed 500 word essay about the history of Paris";
    expect(expandScenario({ prompts: [text], interrupt: true })).toEqual([
      { kind: "prompt", text },
      { kind: "interrupt" },
    ]);
  });
});

describe("expandScenario — explicit steps", () => {
  test("an explicit script passes through, validated", () => {
    const steps: Step[] = [
      { kind: "prompt", text: "pick one" },
      { kind: "await-input", inputKind: "select", timeoutMs: 240_000 },
      { kind: "answer", optionID: "a" },
      { kind: "dump", file: "screen-answered.txt" },
      { kind: "settle", ms: 0 },
    ];
    expect(expandScenario({ steps })).toEqual(steps);
  });

  test("the returned list is a copy, not the scenario's array", () => {
    const steps: Step[] = [{ kind: "interrupt" }];
    const got = expandScenario({ steps });
    expect(got).not.toBe(steps);
  });

  test("prompts and steps together is a usage error", () => {
    expect(() =>
      expandScenario({ prompts: ["a"], steps: [{ kind: "interrupt" }] }),
    ).toThrow(/both prompts and steps/);
  });

  test("steps plus interrupt: true is a usage error", () => {
    expect(() =>
      expandScenario({ steps: [{ kind: "await-turn" }], interrupt: true }),
    ).toThrow(/both steps and interrupt/);
  });

  test("an empty steps list is an error", () => {
    expect(() => expandScenario({ steps: [] })).toThrow(/empty steps/);
  });

  test("an invalid step inside the script is rejected", () => {
    expect(() =>
      expandScenario({ steps: [{ kind: "dump", file: "../escape.txt" }] }),
    ).toThrow(/bare filename/);
  });
});

describe("decodeKeys", () => {
  test("decodes the documented escapes", () => {
    expect(decodeKeys("\\x1b[Z")).toEqual(enc.encode("\x1b[Z"));
    expect(decodeKeys("\\t")).toEqual(enc.encode("\t"));
    expect(decodeKeys("\\r")).toEqual(enc.encode("\r"));
    expect(decodeKeys("\\n")).toEqual(enc.encode("\n"));
    expect(decodeKeys("\\\\")).toEqual(enc.encode("\\"));
  });

  test("passes literal text through", () => {
    expect(decodeKeys("1")).toEqual(enc.encode("1"));
    expect(decodeKeys("/quit\\x1b[13u")).toEqual(enc.encode("/quit\x1b[13u"));
  });

  test("uppercase hex digits work", () => {
    expect(decodeKeys("\\x1B")).toEqual(enc.encode("\x1b"));
  });

  test("rejects a short or non-hex \\x escape", () => {
    expect(() => decodeKeys("\\x1")).toThrow(/two hex digits/);
    expect(() => decodeKeys("\\xzz")).toThrow(/two hex digits/);
  });

  test("rejects an unknown escape rather than passing it through", () => {
    expect(() => decodeKeys("\\e")).toThrow(/unknown escape/);
  });

  test("rejects a trailing backslash", () => {
    expect(() => decodeKeys("abc\\")).toThrow(/trailing backslash/);
  });
});

describe("printable / decodeKeys round-trip", () => {
  // printable() is copied verbatim from record-pty.ts so stdin.log matches the
  // hand-captured fixtures; these pin both halves against each other.
  test("printable renders the fixture escapes", () => {
    expect(printable(enc.encode("\x1b[13u"))).toBe("\\x1b[13u");
    expect(printable(enc.encode("\x1b[Z"))).toBe("\\x1b[Z");
    expect(printable(enc.encode("\t"))).toBe("\\t");
    expect(printable(enc.encode("\r"))).toBe("\\r");
    expect(printable(enc.encode("\n"))).toBe("\\n");
    expect(printable(Uint8Array.from([0x00]))).toBe("\\x00");
    expect(printable(Uint8Array.from([0x7f]))).toBe("\\x7f");
    expect(printable(enc.encode("hello 1"))).toBe("hello 1");
  });

  test("decodeKeys(printable(bytes)) === bytes", () => {
    const cases = [
      "\x1b[13u",
      "\x1b[Z",
      "\t",
      "\r\n",
      "1",
      "/quit\x1b[13u",
      "Write a detailed 500 word essay",
      "\x00\x01\x7f",
    ];
    for (const s of cases) {
      const bytes = enc.encode(s);
      expect(decodeKeys(printable(bytes))).toEqual(bytes);
    }
  });

  test("printable(decodeKeys(spec)) === spec for canonical specs", () => {
    for (const spec of ["1", "\\t", "\\x1b[Z", "\\x1b[13u", "\\r"]) {
      expect(printable(decodeKeys(spec))).toBe(spec);
    }
  });
});

describe("parseKeysSpec", () => {
  test("splits comma-separated bursts, keeping the encoded form", () => {
    expect(parseKeysSpec("1,\\t,\\x1b[Z")).toEqual([
      { kind: "keys", bytes: "1" },
      { kind: "keys", bytes: "\\t" },
      { kind: "keys", bytes: "\\x1b[Z" },
    ]);
  });

  test("a single burst with an embedded escape stays one write", () => {
    expect(parseKeysSpec("/quit\\x1b[13u")).toEqual([
      { kind: "keys", bytes: "/quit\\x1b[13u" },
    ]);
  });

  test("a literal comma is spelled \\x2c and does not split", () => {
    const steps = parseKeysSpec("a\\x2cb");
    expect(steps).toHaveLength(1);
    expect(decodeKeys((steps[0] as { bytes: string }).bytes)).toEqual(
      enc.encode("a,b"),
    );
  });

  test("an empty burst is rejected", () => {
    expect(() => parseKeysSpec("")).toThrow(/empty key burst/);
    expect(() => parseKeysSpec("1,,2")).toThrow(/empty key burst/);
    expect(() => parseKeysSpec("1,")).toThrow(/empty key burst/);
    expect(() => parseKeysSpec(",1")).toThrow(/empty key burst/);
  });

  test("a bad escape is rejected at parse time, not at write time", () => {
    expect(() => parseKeysSpec("1,\\e")).toThrow(/unknown escape/);
  });
});

describe("dump filename validation", () => {
  test("accepts a bare filename", () => {
    expect(() => validateDumpFile("screen-press-01.txt")).not.toThrow();
    expect(() =>
      validateStep({ kind: "dump", file: "expected.txt" }),
    ).not.toThrow();
  });

  test("rejects anything containing a separator", () => {
    for (const f of [
      "sub/dir.txt",
      "/etc/passwd",
      "a\\b.txt",
      "./screen.txt",
    ]) {
      expect(() => validateDumpFile(f)).toThrow();
    }
  });

  test("rejects anything containing ..", () => {
    for (const f of ["..", "..screen.txt", "screen..txt"]) {
      expect(() => validateDumpFile(f)).toThrow(/\.\./);
    }
  });

  test("rejects an empty filename", () => {
    expect(() => validateDumpFile("")).toThrow(/non-empty string/);
  });
});

describe("validateStep", () => {
  test("rejects an unknown kind", () => {
    expect(() => validateStep({ kind: "nope" } as unknown as Step)).toThrow(
      /unknown step kind/,
    );
  });

  test("every kind in stepKinds is a member of the union", () => {
    expect(stepKinds).toContain("interrupt");
    expect(new Set(stepKinds).size).toBe(stepKinds.length);
  });

  test("answer requires exactly one of optionID / optionIDs", () => {
    expect(() => validateStep({ kind: "answer" })).toThrow(/exactly one/);
    expect(() =>
      validateStep({ kind: "answer", optionID: "a", optionIDs: ["b"] }),
    ).toThrow(/exactly one/);
    expect(() => validateStep({ kind: "answer", optionIDs: [] })).toThrow(
      /non-empty array/,
    );
    expect(() =>
      validateStep({ kind: "answer", optionIDs: ["a", "b"] }),
    ).not.toThrow();
  });

  test("timeouts and press counts must be positive integers", () => {
    expect(() => validateStep({ kind: "await-turn", timeoutMs: 0 })).toThrow(
      /positive integer/,
    );
    expect(() =>
      validateStep({ kind: "await-text", text: "x", timeoutMs: -1 }),
    ).toThrow(/positive integer/);
    expect(() => validateStep({ kind: "cycle", presses: 1.5 })).toThrow(
      /positive integer/,
    );
    expect(() => validateStep({ kind: "cycle" })).not.toThrow();
  });

  test("settle allows zero but not a negative", () => {
    expect(() => validateStep({ kind: "settle", ms: 0 })).not.toThrow();
    expect(() => validateStep({ kind: "settle", ms: -1 })).toThrow(
      /non-negative integer/,
    );
  });

  test("keys must decode", () => {
    expect(() => validateStep({ kind: "keys", bytes: "" })).toThrow(
      /non-empty string/,
    );
    expect(() => validateStep({ kind: "keys", bytes: "\\q" })).toThrow(
      /unknown escape/,
    );
    expect(() =>
      validateStep({ kind: "keys", bytes: "\\x1b[Z", label: "shift-tab" }),
    ).not.toThrow();
  });

  test("await-text requires text", () => {
    expect(() => validateStep({ kind: "await-text", text: "" })).toThrow(
      /non-empty string/,
    );
  });

  test("validateSteps throws on the first offender", () => {
    expect(() =>
      validateSteps([{ kind: "interrupt" }, { kind: "settle", ms: -5 }]),
    ).toThrow(/non-negative integer/);
  });
});

// `dialog: true` is the SECOND stop-condition spelling, and it must not become a
// silent alias of `await-input`: it polls screen ANCHORS, so it still works on a
// build whose DetectInput cannot parse the dialog at all — which is the entire
// reason the trust-dialog cell exists.
describe("expandScenario — dialog sugar", () => {
  test("dialog: true appends a trailing await-dialog-anchor", () => {
    expect(expandScenario({ dialog: true })).toEqual([
      { kind: "await-dialog-anchor" },
    ]);
  });

  test("an empty prompts list is legitimate ONLY with dialog: true", () => {
    expect(expandScenario({ prompts: [], dialog: true })).toEqual([
      { kind: "await-dialog-anchor" },
    ]);
    expect(() => expandScenario({ prompts: [] })).toThrow(/empty prompts/);
  });

  test("the dialog stop condition comes last, after any prompts", () => {
    expect(expandScenario({ prompts: ["a"], dialog: true })).toEqual([
      { kind: "prompt", text: "a" },
      { kind: "await-turn" },
      { kind: "await-dialog-anchor" },
    ]);
  });

  test("it desugars to await-dialog-anchor, never to await-input", () => {
    const steps = expandScenario({ dialog: true });
    expect(steps.map((s) => s.kind)).not.toContain("await-input");
  });

  test("steps plus dialog: true is a usage error", () => {
    expect(() =>
      expandScenario({ steps: [{ kind: "await-turn" }], dialog: true }),
    ).toThrow(/both steps and dialog/);
  });

  test("await-dialog-anchor validates its timeout like its siblings", () => {
    expect(validateStep({ kind: "await-dialog-anchor" })).toEqual({
      kind: "await-dialog-anchor",
    });
    expect(() =>
      validateStep({ kind: "await-dialog-anchor", timeoutMs: 0 }),
    ).toThrow(/positive integer/);
    expect(stepKinds).toContain("await-dialog-anchor");
  });
});
