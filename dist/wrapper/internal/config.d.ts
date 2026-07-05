import { type Sentinel } from "../../internal/async/errors.ts";
import { type Classifier } from "./classification.ts";
import { type Emitter } from "../trace.ts";
/**
 * Wrapper-level sentinel errors. Callers use isSentinel(err, X) to distinguish
 * wrapper failures from harness outcomes — the cause-chain analogue of Go's
 * errors.Is with the package's sentinel vars.
 */
export declare const ErrInvalidConfig: Sentinel;
export declare const ErrBinaryNotFound: Sentinel;
/** Configuration for a wrapper run. Durations are in milliseconds. */
export interface Config {
    /** Path to the harness binary (required). */
    binaryPath?: string;
    /** Destination for harness stdout (required). */
    stdout?: unknown;
    /** Harness name ("claude", "codex", "claude-code", …). */
    harness?: string;
    /** Harness CLI args. */
    args?: string[];
    /** Environment as "KEY=VALUE" entries. */
    env?: string[];
    /** Reasoning effort (low/medium/high/xhigh/max). */
    effort?: string;
    /** Model override. */
    model?: string;
    /** Quiet threshold (ms). */
    idleQuiet?: number;
    /** Classify threshold (ms). */
    idleClassify?: number;
    /** Stale threshold (ms). */
    staleThreshold?: number;
    /** Wait after SIGTERM before escalating to SIGKILL (ms). */
    waitDelay?: number;
    /** Optional explicit classifier overriding per-harness resolution. */
    classifier?: Classifier | null;
    /** Working directory for the harness. Defaults to the current directory. */
    workingDir?: string;
    /** Source forwarded into the harness PTY input. */
    stdin?: unknown;
    /** Diagnostic trace emitter. Defaults to Discard. */
    trace?: Emitter | null;
    /**
     * Durable internal line tap. Receives every complete line of the harness's
     * RAW PTY output, in order, with no drops: invoked synchronously in the PTY
     * read loop. This is the load-bearing tap for session-id capture and live
     * transcript parsing. Bytes are split on '\n' with a trailing '\r' trimmed;
     * a final unterminated line is flushed once when the PTY closes. ANSI/control
     * sequences are NOT stripped.
     */
    onLine?: ((line: string) => void) | null;
}
/**
 * Validate a config, returning an Error (wrapping ErrInvalidConfig) on failure
 * or null when the config is acceptable to Start.
 */
export declare function validateConfig(cfg: Config): Error | null;
/** Report whether err indicates the configured harness binary was not found. */
export declare function isBinaryNotFound(err: unknown): boolean;
//# sourceMappingURL=config.d.ts.map