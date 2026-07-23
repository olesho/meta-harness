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
    /** Permission-mode rung forwarded to the harness wrapper via the runner's
     *  `--permission-mode` flag. Canonical rungs, least to most permissive:
     *  `plan`, `manual`, `ask`, `auto`, `bypass` (`ask` sits ABOVE `manual`
     *  because it auto-accepts edits). Unset or `""` injects nothing. Supported
     *  on claude-code and codex only. COMPOSES with `sandboxDefaults` — see that
     *  field for the precedence rule.
     *
     *  The value is validated INSIDE THE GUEST, so an operator meets it as one of
     *  two distinct result shapes rather than a host-side throw:
     *
     *  - Invalid rung, current guest image: `structured-runner` parses the flag
     *    fine, the wrapper throws `ErrInvalidConfig`, and the runner's catch emits
     *    a JSON line `{ status: "errored", reason: "wrapper: invalid config:
     *    PermissionMode …" }` and exits 1. That payload is returned VERBATIM —
     *    status `errored`, message preserved in `reason`. (`statusForExit` is not
     *    consulted: it only runs when stdout carried no JSON.)
     *  - Guest image predates this flag: `parseStructuredArgs` rejects the unknown
     *    flag → `ExitUsage` (2) with NO JSON → `statusForExit` → status
     *    `startup_error`, with the runner's stderr in `reason`, reading
     *    `structured-runner: unknown flag: --permission-mode`. That string is the
     *    version-skew fingerprint.
     *
     *  Codex honesty caveat: codex `plan` pins the PERMISSIONS axis only
     *  (`-s read-only -a untrusted`); the collaboration-axis `/plan` write is
     *  META-HARNESS-106. */
    permissionMode?: string;
    /** Extra args forwarded verbatim to the harness after `--`. */
    harnessArgs?: string[];
    /** Opt into the runner's sandbox defaults (`--sandbox-defaults`): IS_SANDBOX=1
     *  in the guest env (all harnesses) and --dangerously-skip-permissions on the
     *  argv (claude-code only). Off by default — argv/env forwarded verbatim.
     *
     *  Equivalent in intent to `permissionMode: "bypass"` for claude-code only.
     *  When `permissionMode` is also set it wins for argv (the runner emits no
     *  --dangerously-skip-permissions); the IS_SANDBOX=1 half still applies,
     *  unconditionally and independently of the resolved mode. The env half is a
     *  guest-CONTAINER affordance (it is what permits running as root), not a
     *  permission directive, so it is gated on this flag alone — the runner's
     *  buildGuestEnv takes no permission-mode parameter at all. Both flags may be
     *  set together; `sandboxDefaults` + `permissionMode: "bypass"` is in fact the
     *  fresh-HOME-safe pairing. */
    sandboxDefaults?: boolean;
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