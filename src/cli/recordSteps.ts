// recordSteps.ts — the scripted-step vocabulary for `screenbench-record`.
//
// PUPPET-306 §3.1/§3.3 replaces the recorder's `prompts: string[]` driving with
// an explicit step list. This module owns the vocabulary and everything about it
// that can be decided WITHOUT a terminal: the `Step` union, the desugaring of
// the legacy scenario shape (`expandScenario`), the keystroke escape codec
// (`decodeKeys` / `printable`), the `--keys` spec parser (`parseKeysSpec`), and
// step validation.
//
// It is deliberately PURE — no `node:fs`, no PTY, no adapters — so the whole
// vocabulary is unit-testable without a harness binary, and so the interpreter
// (src/cli/screenbench-record.ts) is left with only the parts that genuinely
// need a live screen.
//
// Not a public barrel: src/cli/** is flat CLI-entrypoint code and is not in
// test/testdata/ts_surface.golden. Deep-import it (`../cli/recordSteps.ts`);
// do not add it to an `exports` map.

/**
 * One instruction in a recording script.
 *
 * The interpreter runs these in order against a single live PTY + adapter;
 * every `await-*` kind polls the adapter's event stream on one shared cadence.
 */
export type Step =
  | { kind: "prompt"; text: string } // type, assert echo, submit
  | { kind: "await-turn"; timeoutMs?: number } // poll to TurnComplete
  | { kind: "await-input"; inputKind?: string; timeoutMs?: number }
  // The ANCHOR-based stop condition, a sibling of `await-input`: it polls the
  // harness's `dialogSpecs[harness].anchors` against the rendered screen rather
  // than the adapter's event stream. It exists because the startup trust dialog
  // must be recordable on builds where `DetectInput` cannot parse the menu at
  // all — which is the entire point of the trust-dialog capture. `await-input`
  // stays the adapter-event stop condition (used by the question scenarios), so
  // which one a scenario used is legible from the expanded `steps` in meta.json.
  | { kind: "await-dialog-anchor"; timeoutMs?: number }
  | { kind: "await-text"; text: string; timeoutMs?: number }
  | { kind: "answer"; optionID?: string; optionIDs?: string[] }
  | { kind: "keys"; bytes: string; label?: string } // literal, escape-decoded
  | { kind: "cycle"; presses?: number } // permissionCycleKeys()
  | { kind: "interrupt" } // the existing interrupt-spec path
  | { kind: "settle"; ms: number }
  | { kind: "dump"; file: string }; // screen -> <out>/<file>

/** Every `Step["kind"]`, in union order. Exported for validation + messages. */
export const stepKinds = [
  "prompt",
  "await-turn",
  "await-input",
  "await-dialog-anchor",
  "await-text",
  "answer",
  "keys",
  "cycle",
  "interrupt",
  "settle",
  "dump",
] as const;

/**
 * The scenario fields this module reads.
 *
 * Structurally a subset of the recorder's `Scenario`, so a catalog entry can be
 * passed straight in without the catalog's `notes` / `setup` / `launchArgs`
 * leaking into the pure layer.
 */
export interface StepScenario {
  /** Legacy sugar: each prompt desugars to `[prompt, await-turn]`. */
  prompts?: string[];
  /** Explicit script. Mutually exclusive with `prompts`. */
  steps?: Step[];
  /** Legacy sugar: replaces the LAST `await-turn` with `{ kind: "interrupt" }`. */
  interrupt?: boolean;
  /**
   * Legacy sugar: the scenario's terminal state is a blocking startup dialog
   * detected by ANCHOR, not by the adapter. Appends a trailing
   * `{ kind: "await-dialog-anchor" }`.
   */
  dialog?: boolean;
}

// --- escape codec ------------------------------------------------------------

/**
 * Render bytes as a printable escape string for stdin.log ("\x1b[13u" etc.).
 *
 * Copied VERBATIM from test/corpus/tools/record-pty.ts (and the identical copy
 * in probe-shift-tab.ts) so the recorder's `stdin.log` matches the checked-in
 * hand-captured fixtures byte for byte. Do not "improve" it — a change here is
 * a change to a recorded artifact format.
 */
export function printable(data: Uint8Array): string {
  let out = "";
  for (const b of data) {
    if (b === 0x1b) out += "\\x1b";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x09) out += "\\t";
    else if (b < 0x20 || b === 0x7f)
      out += "\\x" + b.toString(16).padStart(2, "0");
    else out += String.fromCharCode(b);
  }
  return out;
}

const enc = new TextEncoder();
const hex = /^[0-9a-fA-F]{2}$/;

/**
 * Decode an escape-encoded keystroke spec into the bytes to write.
 *
 * Understands `\xNN` (so `\x1b` for ESC), `\t`, `\r`, `\n`, and `\\` for a
 * literal backslash. Any other escape is a usage error rather than a silent
 * pass-through, so a typo like `\e` fails loudly instead of writing "e".
 *
 * This is the inverse of `printable()` for everything `printable()` emits;
 * `\\` is the one addition, because `printable()` passes a literal 0x5c byte
 * through unescaped and a spec still needs a way to say "backslash".
 */
export function decodeKeys(spec: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c !== "\\") {
      for (const b of enc.encode(c)) out.push(b);
      continue;
    }
    if (i + 1 >= spec.length) {
      throw new Error(
        `trailing backslash in key spec: ${JSON.stringify(spec)}`,
      );
    }
    const esc = spec[i + 1];
    if (esc === "x") {
      const digits = spec.slice(i + 2, i + 4);
      if (!hex.test(digits)) {
        throw new Error(
          `bad \\x escape in key spec: ${JSON.stringify(spec)} (expected two hex digits after \\x)`,
        );
      }
      out.push(parseInt(digits, 16));
      i += 3;
      continue;
    }
    if (esc === "t") out.push(0x09);
    else if (esc === "r") out.push(0x0d);
    else if (esc === "n") out.push(0x0a);
    else if (esc === "\\") out.push(0x5c);
    else {
      throw new Error(
        `unknown escape \\${esc} in key spec: ${JSON.stringify(spec)} (supported: \\xNN, \\t, \\r, \\n, \\\\)`,
      );
    }
    i += 1;
  }
  return Uint8Array.from(out);
}

/**
 * Parse a `--keys` spec — comma-separated escape-encoded bursts — into `keys`
 * steps, one per burst.
 *
 *     parseKeysSpec("1,\\t,\\x1b[Z")
 *       -> [{keys "1"}, {keys "\t"}, {keys "\x1b[Z"}]
 *
 * One burst is one PTY write, which is what makes a burst meaningful: the
 * interpreter settles between bursts. A literal comma inside a burst is spelled
 * `\x2c`. An empty burst (`"1,,2"`, a leading/trailing comma, or an empty spec)
 * is an error, not an empty write.
 */
export function parseKeysSpec(spec: string): Step[] {
  const bursts = spec.split(",");
  const steps: Step[] = [];
  for (const [i, burst] of bursts.entries()) {
    if (burst === "") {
      throw new Error(
        `empty key burst at position ${String(i + 1)} of ${JSON.stringify(spec)}; ` +
          `bursts are comma-separated and a literal comma is \\x2c`,
      );
    }
    decodeKeys(burst); // validate the escapes now, not at write time
    steps.push({ kind: "keys", bytes: burst });
  }
  return steps;
}

// --- validation --------------------------------------------------------------

function positiveInt(value: unknown, field: string, kind: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${kind} step: ${field} must be a positive integer (got ${JSON.stringify(value)})`,
    );
  }
}

function nonEmptyString(
  value: unknown,
  field: string,
  kind: string,
): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new Error(
      `${kind} step: ${field} must be a non-empty string (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Reject a `dump` target that is anything but a bare filename.
 *
 * A `dump` step names a file the recorder writes inside `--out`. A scenario is
 * data — it can come from a catalog entry someone edits or, later, a file — so
 * the join happens only after this: no separators, no `..`, nothing absolute.
 *
 * Returns the validated name, so a caller can write
 * `join(out, validateDumpFile(step.file))` and cannot forget the check.
 */
export function validateDumpFile(file: unknown): string {
  nonEmptyString(file, "file", "dump");
  const f = file;
  if (f.includes("/") || f.includes("\\")) {
    throw new Error(
      `dump step: file must be a bare filename, not a path (got ${JSON.stringify(f)})`,
    );
  }
  if (f.includes("..")) {
    throw new Error(
      `dump step: file must not contain ".." (got ${JSON.stringify(f)})`,
    );
  }
  if (f === "." || f.includes("\0")) {
    throw new Error(`dump step: invalid file name ${JSON.stringify(f)}`);
  }
  return f;
}

/** Validate one step, throwing a named usage error. Returns the step. */
export function validateStep(step: Step): Step {
  const kind: unknown = (step as { kind?: unknown }).kind;
  if (
    typeof kind !== "string" ||
    !(stepKinds as readonly string[]).includes(kind)
  ) {
    throw new Error(
      `unknown step kind ${JSON.stringify(kind)} (expected one of: ${stepKinds.join(", ")})`,
    );
  }
  switch (step.kind) {
    case "prompt":
      nonEmptyString(step.text, "text", "prompt");
      break;
    case "await-turn":
      if (step.timeoutMs !== undefined)
        positiveInt(step.timeoutMs, "timeoutMs", "await-turn");
      break;
    case "await-input":
      if (step.inputKind !== undefined)
        nonEmptyString(step.inputKind, "inputKind", "await-input");
      if (step.timeoutMs !== undefined)
        positiveInt(step.timeoutMs, "timeoutMs", "await-input");
      break;
    case "await-dialog-anchor":
      if (step.timeoutMs !== undefined)
        positiveInt(step.timeoutMs, "timeoutMs", "await-dialog-anchor");
      break;
    case "await-text":
      nonEmptyString(step.text, "text", "await-text");
      if (step.timeoutMs !== undefined)
        positiveInt(step.timeoutMs, "timeoutMs", "await-text");
      break;
    case "answer": {
      const one = step.optionID !== undefined;
      const many = step.optionIDs !== undefined;
      if (one === many) {
        throw new Error(
          "answer step: exactly one of optionID or optionIDs must be set",
        );
      }
      if (one) nonEmptyString(step.optionID, "optionID", "answer");
      const ids = step.optionIDs;
      if (ids !== undefined) {
        if (!Array.isArray(ids) || ids.length === 0) {
          throw new Error("answer step: optionIDs must be a non-empty array");
        }
        for (const id of ids) nonEmptyString(id, "optionIDs entry", "answer");
      }
      break;
    }
    case "keys":
      nonEmptyString(step.bytes, "bytes", "keys");
      if (step.label !== undefined) nonEmptyString(step.label, "label", "keys");
      decodeKeys(step.bytes);
      break;
    case "cycle":
      if (step.presses !== undefined)
        positiveInt(step.presses, "presses", "cycle");
      break;
    case "interrupt":
      break;
    case "settle":
      if (
        typeof step.ms !== "number" ||
        !Number.isInteger(step.ms) ||
        step.ms < 0
      ) {
        throw new Error(
          `settle step: ms must be a non-negative integer (got ${JSON.stringify(step.ms)})`,
        );
      }
      break;
    case "dump":
      validateDumpFile(step.file);
      break;
  }
  return step;
}

/** Validate every step in order. Throws on the first offender. */
export function validateSteps(steps: Step[]): Step[] {
  for (const step of steps) validateStep(step);
  return steps;
}

// --- desugaring --------------------------------------------------------------

/**
 * Expand a scenario into the step list the interpreter runs.
 *
 * The legacy shape is sugar, and stays byte-for-byte what the recorder does
 * today:
 *
 *   `prompts: [a, b]` -> `[{prompt a}, {await-turn}, {prompt b}, {await-turn}]`
 *   `interrupt: true` -> the LAST `await-turn` becomes `{ kind: "interrupt" }`
 *   `dialog: true`    -> a trailing `{ kind: "await-dialog-anchor" }`
 *
 * `dialog: true` does NOT desugar to `await-input`: the two are different stop
 * conditions and both must stay legible in the expanded list. `await-input`
 * resolves on an adapter `InputRequested` event; `await-dialog-anchor` resolves
 * on a screen anchor, and must keep working on builds where the adapter cannot
 * parse the dialog at all.
 *
 * Declaring both `prompts` and `steps` is a usage error rather than a silent
 * precedence rule (PUPPET-306 §7.1(7)): a scenario that means to script itself
 * should not also carry a prompt list nobody reads.
 */
export function expandScenario(scenario: StepScenario): Step[] {
  const { prompts, steps: scripted } = scenario;
  if (prompts !== undefined && scripted !== undefined) {
    throw new Error(
      "scenario declares both prompts and steps; use one (prompts is sugar for [prompt, await-turn] per entry)",
    );
  }

  if (scripted !== undefined) {
    if (scenario.interrupt) {
      throw new Error(
        'scenario declares both steps and interrupt: true; an explicit script uses an { kind: "interrupt" } step',
      );
    }
    if (scenario.dialog) {
      throw new Error(
        'scenario declares both steps and dialog: true; an explicit script uses an { kind: "await-dialog-anchor" } step',
      );
    }
    const steps = scripted.slice();
    if (steps.length === 0)
      throw new Error("scenario declares an empty steps list");
    validateSteps(steps);
    return steps;
  }

  // `dialog: true` is the one shape whose whole script can be the stop
  // condition: the trust-dialog cell sends no prompt at all, so an absent (or
  // empty) prompts list is legitimate there and ONLY there.
  if (prompts === undefined && !scenario.dialog) {
    throw new Error("scenario declares neither prompts nor steps");
  }
  if (prompts !== undefined && !Array.isArray(prompts)) {
    throw new Error("scenario declares an empty prompts list");
  }
  if (prompts !== undefined && prompts.length === 0 && !scenario.dialog) {
    throw new Error("scenario declares an empty prompts list");
  }

  const steps: Step[] = [];
  for (const text of prompts ?? []) {
    nonEmptyString(text, "prompts entry", "prompt");
    steps.push({ kind: "prompt", text });
    steps.push({ kind: "await-turn" });
  }

  if (scenario.interrupt) {
    const last = steps.map((s) => s.kind).lastIndexOf("await-turn");
    if (last < 0) {
      throw new Error(
        "scenario sets interrupt: true but has no await-turn step to replace",
      );
    }
    steps[last] = { kind: "interrupt" };
  }

  // The dialog is the TERMINAL state, so its stop condition goes last — after
  // whatever prompts the scenario sends (today: none).
  if (scenario.dialog) steps.push({ kind: "await-dialog-anchor" });

  validateSteps(steps);
  return steps;
}
