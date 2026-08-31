#!/usr/bin/env node
import { type Step } from "./recordSteps.ts";
export declare const ExitOK = 0;
export declare const ExitError = 1;
export declare const ExitUsage = 2;
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
export declare const interruptSpecs: Record<string, InterruptSpec>;
interface DialogSpec {
    /** Any one of these on the settled frame means the dialog is up. */
    anchors: string[];
    /** Human name used in error/progress text. */
    what: string;
}
export declare const dialogSpecs: Record<string, DialogSpec>;
interface Scenario {
    /** Legacy sugar: one `[prompt, await-turn]` pair per entry. */
    prompts?: string[];
    /** Explicit script. Mutually exclusive with `prompts`. */
    steps?: Step[];
    /** Interrupt the (single) prompt's reply once streaming is visible. */
    interrupt?: boolean;
    /** Terminal state is a blocking dialog, not a TurnComplete. See dialogSpecs. */
    dialog?: boolean;
    /**
     * The recording requires a directory the harness has NOT yet been trusted in.
     * Suppresses the trust-accepting warmup pass and mints a unique cwd.
     */
    freshWorkdir?: boolean;
    /**
     * Extra argv for the harness binary. `PtyProcess.spawn` used to be called with
     * a hard-coded empty `args`, which made every launch-flag-dependent cell
     * unrecordable. `--launch-arg` overrides this per run.
     */
    launchArgs?: string[];
    /**
     * The scenario is meaningful for exactly one harness; recording it for any
     * other is refused before any file is written (same shape as the interrupt and
     * dialog spec gates, but declared BY THE SCENARIO rather than by a spec map —
     * it is a property of the script, not of a missing seam).
     */
    requiresHarness?: string;
    notes: string;
    setup?: (cwd: string) => void;
}
export declare const scenarios: Record<string, Scenario>;
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
    /** Ad-hoc prompts (repeatable `--prompt`); only for a non-catalog scenario. */
    prompts: string[];
    /** Raw `--keys` specs (repeatable), each a comma-separated burst list. */
    keys: string[];
    /** `--stop-on-input[=<kind>]`: the ad-hoc spelling of an `await-input` step. */
    stopOnInput: boolean;
    stopOnInputKind: string;
    /** `--launch-arg` (repeatable): overrides the scenario's own launchArgs. */
    launchArgs: string[];
    /** `--no-warmup`: skip the claude trust-accepting warmup pass. */
    noWarmup: boolean;
    /** `--allow-overwrite`: proceed past the hand-captured-recording guard. */
    allowOverwrite: boolean;
    /** `--attempts <n>`: whole-run retries, but ONLY on an await-input timeout. */
    attempts: number;
    help?: boolean;
    error?: string;
}
export declare function parseArgs(argv: string[]): ParsedArgs;
/**
 * normalizeVersion extracts the bare version token from a raw `--version` line.
 * A real harness prints more than the semver (e.g. "2.1.201 (Claude Code)")
 * while the manifest pin is the bare "2.1.201", so meta.json records — and the
 * --binary-version cross-check compares against — the FIRST whitespace token.
 */
export declare function normalizeVersion(raw: string): string;
/**
 * claudeTrustState reports whether claude has already recorded an accepted
 * trust decision for `dir`. Returns null when the config cannot be read — an
 * unreadable config is NOT evidence of trust, so the caller proceeds with a
 * warning rather than blocking a legitimate recording.
 *
 * `configPath` is normally `~/.claude.json`; the caller resolves the TEST-ONLY
 * META_HARNESS_CLAUDE_CONFIG override.
 */
export declare function claudeTrustState(dir: string, configPath: string): boolean | null;
/**
 * True when `meta` describes a recording THIS CLI produced, and may therefore
 * be regenerated without losing anything a human wrote.
 *
 * Fails CLOSED: unreadable, non-object, or unrecognized meta.json is treated as
 * hand-captured. The cost of a wrong `false` is one `--allow-overwrite`; the
 * cost of a wrong `true` is prose that cost a paid live session.
 */
export declare function recorderOwnedMeta(meta: unknown): boolean;
export declare function main(argv: string[]): Promise<number>;
export {};
//# sourceMappingURL=screenbench-record.d.ts.map