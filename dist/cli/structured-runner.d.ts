#!/usr/bin/env node
export { ExitOK, ExitError, ExitUsage, ExitDeadline, DeadlineLine, } from "../turnproto/index.ts";
export declare function resolveHarnessName(name: string): "claude-code" | "codex" | null;
/** buildGuestEnv assembles the guest env entries from the host env. With
 *  sandboxDefaults, IS_SANDBOX is set/OVERWRITTEN to "1" — a single entry, never
 *  a duplicate KEY=VALUE pair when the host already sets IS_SANDBOX. Without it,
 *  the host env passes through verbatim: a host-preset IS_SANDBOX is neither
 *  stripped nor rewritten. Composed with cleanEnv by the caller. */
export declare function buildGuestEnv(baseEnv: Record<string, string | undefined>, sandboxDefaults: boolean): string[];
/**
 * resolveTimeoutMs — precedence: LOOM_LOCAL_TASK_TIMEOUT_MS (plain milliseconds,
 * structured-runner-only loom override) → HARNESS_WRAPPER_RUN_TIMEOUT (Go
 * duration, shared with the run CLI and the Go wrapper) → 15m default. Invalid
 * or non-positive values fall through to the next source in the chain.
 */
export declare function resolveTimeoutMs(env: Record<string, string | undefined>): number;
export interface StructuredArgs {
    help?: boolean;
    error?: string;
    name?: string;
    promptFile?: string;
    effort?: string;
    model?: string;
    /**
     * permissionMode — launch-time permission rung forwarded to the wrapper via
     * OneShotConfig. Canonical rungs least→most permissive: plan, manual, ask,
     * auto, bypass (`ask` sits ABOVE `manual` because it auto-accepts edits).
     * Unset / "" injects nothing. Supported on claude-code and codex only.
     *
     * Validation is the WRAPPER's, and on the src/env/turn.ts path that config is
     * validated INSIDE the guest — so an invalid rung surfaces as this runner's
     * caught throw: `{ status: "errored", reason: "wrapper: invalid config:
     * PermissionMode …" }` on stdout with exit 1. A guest image that predates the
     * flag instead hits the unknown-flag branch below: `structured-runner: unknown
     * flag: --permission-mode` on stderr, ExitUsage (2), and no JSON at all.
     */
    permissionMode?: string;
    sandboxDefaults?: boolean;
    harnessArgs: string[];
}
export declare function parseStructuredArgs(argv: string[]): StructuredArgs;
/** readTranscript reads the harness's on-disk session and maps to the public DTO. */
export declare function readTranscript(harness: string, harnessSessionID: string, workingDir: string): Record<string, unknown>[];
/** readUsage reads the session's token totals; null when none recorded. */
export declare function readUsage(harness: string, harnessSessionID: string, workingDir: string): Record<string, number> | null;
/**
 * reportedPermissionRung computes StructuredTurnResult.permission_mode for this
 * launch: the rung the runner LAUNCHED the harness at, or undefined when
 * nothing was requested and nothing was injected. Pure — argv arithmetic only,
 * no I/O — so the whole table is unit-tested directly rather than through a
 * real-pty turn.
 *
 * It CONSUMES metaHarnessArgs' output rather than restating its condition. That
 * coupling is the point: the runner's own `--sandbox-defaults` injection is
 * read back as ARGV, so a future change to what metaHarnessArgs emits (a codex
 * injection, a second claude flag) cannot silently desynchronise the reported
 * rung from the command line that actually launched.
 *
 * The composed argv is exactly what the wrapper sees — chat prepends only the
 * effort/model prefix, never a permission flag — so effectiveLaunchRung's
 * replay of the all-or-nothing suppression rule is the same replay the wrapper
 * performs. In particular argv BEATS the requested mode, which is why
 * `--permission-mode plan` alongside a bypass flag reports "bypass" and never
 * "plan": under-reporting permissiveness is the one direction this field must
 * never fail in.
 *
 * effectiveLaunchRung returns "" for BOTH "argv says nothing" and "argv pins
 * something unnameable"; argvPermissionPin tells those apart, because absence
 * here means "nothing was requested" and must never be read as "pinned, posture
 * unknown". A pinned-but-unnameable posture reports "override"; a pin naming a
 * spelling with no canonical rung (claude's dontAsk) passes through verbatim
 * rather than being erased.
 */
export declare function reportedPermissionRung(harness: string, parsed: StructuredArgs): string | undefined;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=structured-runner.d.ts.map