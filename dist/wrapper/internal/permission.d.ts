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
/**
 * How a GIVEN args slice pins the permission axis for `harness` — the SHAPE of
 * the pin only, deliberately NOT its canonical rung (that is
 * effectiveLaunchRung's job, and duplicating it here would fork the vocabulary).
 *
 *	"none"   nothing in args pins permissions, so argsWithHarnessPermissionMode
 *	         WOULD inject — the all-or-nothing precedence's complement;
 *	"native" pinned by a single --permission-mode flag whose operand is readable
 *	         and non-empty, but which names no canonical rung (claude's dontAsk
 *	         at 2.1.217, or a spelling a newer claude added). `value` is that
 *	         operand VERBATIM — the caller reports it rather than erasing a
 *	         precisely-known posture behind a sentinel;
 *	"opaque" pinned, but no single token names the result: a valueless or
 *	         empty-valued --permission-mode, a bypass-enabling flag alongside
 *	         another pin, or any codex pin (two orthogonal axes, plus -p/--profile
 *	         and the -c sandbox_mode= / approval_policy= keys, whose forward map
 *	         has no inverse).
 *
 * Reads the SAME guarded sets as argsWithHarnessPermissionMode, so the two can
 * never disagree about what counts as a pin. Note "native" is claude-only by
 * construction: codex has no single-token permission spelling other than
 * CodexBypassFlag, which effectiveLaunchRung already resolves to a rung.
 */
export type ArgvPermissionPin = {
    kind: "none";
} | {
    kind: "native";
    value: string;
} | {
    kind: "opaque";
};
/**
 * argvPermissionPin classifies how args pins permissions for harness.
 *
 * The intended use is as effectiveLaunchRung's DISAMBIGUATOR: that function
 * collapses "argv says nothing" and "argv pins something unnameable" onto the
 * same "" return, and a telemetry field must tell those apart — absent means
 * nothing was requested or injected, never "pinned, posture unknown". Call it
 * only on the "" branch; a resolved rung needs no classification.
 *
 * Pass the COMPOSED argv (any harness-generated injection plus the caller's
 * own tail), the same slice argsWithHarnessPermissionMode would see.
 */
export declare function argvPermissionPin(harness: string, args: string[]): ArgvPermissionPin;
//# sourceMappingURL=permission.d.ts.map