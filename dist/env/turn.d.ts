import type { Context } from "../async/index.ts";
import { type StructuredTurnResult } from "../turnproto/index.ts";
import type { Workspace } from "./types.ts";
/** Inputs for one structured turn. The prompt is a plain string — it is written
 *  to a temp file and uploaded, NEVER placed on the argv. */
export interface TurnConfig {
    /** Short harness alias (claude → claude-code, codex → codex) or the full name. */
    harness: string;
    /** The prompt text (crosses via --prompt-file, never argv). */
    prompt: string;
    /** Reasoning effort forwarded to the harness. */
    effort?: string;
    /** Model forwarded to the harness. */
    model?: string;
    /** Extra args forwarded verbatim to the harness after `--`. */
    harnessArgs?: string[];
    /** Environment overlaid on the guest process. */
    env?: Record<string, string>;
    /** Guest working directory; defaults to the workspace's repo path. */
    cwd?: string;
    /** Override the guest bin name/path (default meta-harness-structured-run). */
    binary?: string;
    /** OPTIONAL out-of-band RAW-JSONL transcript retrieval to this HOST path.
     *  claude-code ONLY (see below); a codex turn REJECTS this rather than
     *  downloading from the wrong on-disk layout. */
    retrieveTranscriptTo?: string;
}
/** Thrown when stdout carries a payload the client cannot interpret coherently
 *  (e.g. a success exit with NO JSON line — an anomalous producer state). */
export declare class TurnProtocolError extends Error {
    readonly exitCode: number;
    readonly stderr: string;
    constructor(message: string, exitCode: number, stderr: string);
}
/** Thrown when out-of-band retrieval is requested for a harness whose raw-JSONL
 *  download is not implemented here. This client ships CLAUDE-CODE RETRIEVAL
 *  ONLY; codex uses a different (~/.codex/sessions/<Y>/<M>/<D>/rollout-…) layout
 *  with no encodedCWD, and silently downloading from the claude path would be a
 *  correctness bug — so a codex retrieval request is rejected, not misrouted. */
export declare class TranscriptRetrievalUnsupportedError extends Error {
    readonly harness: string;
    constructor(harness: string);
}
/**
 * runStructuredTurn drives one structured turn over `ws` and returns the parsed
 * protocol result.
 *
 * When stdout carries the JSON payload (structured-runner emits it on exit 0,
 * 124, and the caught runtime throw) it IS the source of truth and is returned
 * verbatim. When stdout carries ZERO JSON — exit 2 (usage), exit 1 from a
 * prompt-read failure, and exit 1 from the top-level fatal handler all emit
 * nothing — a coherent result is DERIVED from the exit code + stderr; a success
 * exit with no JSON throws TurnProtocolError (never assume a payload).
 */
export declare function runStructuredTurn(ctx: Context, ws: Workspace, cfg: TurnConfig): Promise<StructuredTurnResult>;
//# sourceMappingURL=turn.d.ts.map