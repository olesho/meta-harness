/**
 * One instruction in a recording script.
 *
 * The interpreter runs these in order against a single live PTY + adapter;
 * every `await-*` kind polls the adapter's event stream on one shared cadence.
 */
export type Step = {
    kind: "prompt";
    text: string;
} | {
    kind: "await-turn";
    timeoutMs?: number;
} | {
    kind: "await-input";
    inputKind?: string;
    timeoutMs?: number;
} | {
    kind: "await-dialog-anchor";
    timeoutMs?: number;
} | {
    kind: "await-text";
    text: string;
    timeoutMs?: number;
} | {
    kind: "answer";
    optionID?: string;
    optionIDs?: string[];
} | {
    kind: "keys";
    bytes: string;
    label?: string;
} | {
    kind: "cycle";
    presses?: number;
} | {
    kind: "interrupt";
} | {
    kind: "settle";
    ms: number;
} | {
    kind: "dump";
    file: string;
};
/** Every `Step["kind"]`, in union order. Exported for validation + messages. */
export declare const stepKinds: readonly ["prompt", "await-turn", "await-input", "await-dialog-anchor", "await-text", "answer", "keys", "cycle", "interrupt", "settle", "dump"];
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
/**
 * Render bytes as a printable escape string for stdin.log ("\x1b[13u" etc.).
 *
 * Copied VERBATIM from test/corpus/tools/record-pty.ts (and the identical copy
 * in probe-shift-tab.ts) so the recorder's `stdin.log` matches the checked-in
 * hand-captured fixtures byte for byte. Do not "improve" it — a change here is
 * a change to a recorded artifact format.
 */
export declare function printable(data: Uint8Array): string;
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
export declare function decodeKeys(spec: string): Uint8Array;
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
export declare function parseKeysSpec(spec: string): Step[];
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
export declare function validateDumpFile(file: unknown): string;
/** Validate one step, throwing a named usage error. Returns the step. */
export declare function validateStep(step: Step): Step;
/** Validate every step in order. Throws on the first offender. */
export declare function validateSteps(steps: Step[]): Step[];
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
export declare function expandScenario(scenario: StepScenario): Step[];
//# sourceMappingURL=recordSteps.d.ts.map