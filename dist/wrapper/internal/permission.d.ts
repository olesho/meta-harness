/**
 * isSupportedPermissionMode reports whether mode is an accepted input spelling
 * FOR THIS HARNESS.
 *
 * It takes the harness — unlike isSupportedEffort(effort), which does not —
 * because the accepted vocabulary genuinely differs per harness: the claude
 * native spellings (acceptEdits, bypassPermissions, dontAsk) have no codex
 * meaning, and the codex native sandbox values (read-only, workspace-write,
 * danger-full-access) have no claude meaning. A single harness-blind predicate
 * could only be the union, which would accept `dontAsk` on codex.
 *
 * Matching is CASE-SENSITIVE: normHarness lowercases the HARNESS, not the
 * value, and claude's own CLI matches its camelCase --permission-mode values
 * exactly. A wrong-case value fails validateConfig loudly rather than being
 * guessed.
 */
export declare function isSupportedPermissionMode(harness: string, mode: string): boolean;
/**
 * harnessSupportsPermissionMode reports whether the harness has a launch-time
 * permission axis at all. Mirrors harnessSupportsEffort.
 */
export declare function harnessSupportsPermissionMode(harness: string): boolean;
/**
 * argsWithHarnessPermissionMode prepends the per-harness permission argv for
 * mode. An empty mode, an unknown harness, or a value this harness does not
 * accept all leave args unchanged.
 *
 * The argsWith* family deliberately does NOT validate — validation happens at
 * config time (validateConfig, run first in start()), not launch time. So a
 * value that somehow slipped past validateConfig must no-op here rather than
 * emit garbage argv.
 *
 * Emitted mapping:
 *
 *	input mode          claude / claude-code                codex
 *	plan                --permission-mode plan              -s read-only -a untrusted
 *	manual              --permission-mode manual            -s workspace-write -a untrusted
 *	ask                 --permission-mode acceptEdits       -s workspace-write -a on-request
 *	auto                --permission-mode auto              -s workspace-write -a never
 *	bypass              --permission-mode bypassPermissions -s danger-full-access -a never
 *	acceptEdits         --permission-mode acceptEdits       (unsupported -> no-op)
 *	bypassPermissions   --permission-mode bypassPermissions (unsupported -> no-op)
 *	dontAsk             --permission-mode dontAsk           (unsupported -> no-op)
 *	read-only           (unsupported -> no-op)              -s read-only
 *	workspace-write     (unsupported -> no-op)              -s workspace-write
 *	danger-full-access  (unsupported -> no-op)              -s danger-full-access
 *
 * codex has TWO arms. A canonical rung takes the PAIR arm (both -s and -a). A
 * codex-native sandbox value takes the SINGLE-AXIS arm: `-s <value>` only,
 * leaving the approval axis at whatever ~/.codex/config.toml holds. That
 * mirrors shipped Go (harness-wrapper/pkg/wrapper/wrapper.go:598), where
 * codexPermissionMode returns an empty approval for those three values — a
 * native sandbox value names HALF a posture, which is a valid request, not an
 * error.
 *
 * codex `manual` is workspace-write + untrusted, NOT read-only: claude's manual
 * permits writes after approval, while read-only forbids them outright.
 *
 * codex `plan` is the LAUNCH HALF ONLY. `-s read-only -a untrusted` pins the
 * permissions axis deterministically; the collaboration-axis `/plan` write
 * cannot live in the wrapper (it lands with META-HARNESS-106). Report it
 * honestly as "permissions pinned, collaboration axis unset" — this is NOT
 * launch-time parity with claude's plan.
 *
 * Explicit-override-wins is ALL-OR-NOTHING per harness: if any guarded flag or
 * config key is present we inject NOTHING. Half-injecting (say, adding an
 * approval override when the caller pinned only the sandbox) would silently
 * rewrite the caller's intent.
 */
export declare function argsWithHarnessPermissionMode(harness: string, args: string[], mode: string): string[];
//# sourceMappingURL=permission.d.ts.map