// Per-harness launch-time permission-mode translation — the INJECTION half of
// the permission knob (Claude Code --permission-mode, Codex -s/--sandbox plus
// -a/--ask-for-approval). The REPLAY half (effectiveLaunchRung) and the
// canonical rung constants live in permissionrungs.ts; this module imports them
// rather than redeclaring any rung string.
//
// VERIFIED against claude-code 2.1.217 and codex-cli 0.144.5. (src/versions/
// versions.json still pins 2.1.201 / 0.142.5; bumping that pin is its own
// change. The argv shapes below need >= 2.1.217 / >= 0.144.5.)
//
// End-to-end re-confirmation (META-HARNESS-153, claude-code 2.1.218 /
// codex-cli 0.144.5) — every row below was launched for real and read back:
//
//	claude --permission-mode plan               footer "⏸ plan mode on"
//	claude --permission-mode bypassPermissions  blocking "WARNING: Claude Code
//	                                            running in Bypass Permissions
//	                                            mode" screen, then footer
//	                                            "⏵⏵ bypass permissions on"
//	codex -s read-only      -a untrusted        /status "Read Only (untrusted)"
//	codex -s workspace-write -a untrusted       /status "Custom (workspace, untrusted)"
//	codex -s workspace-write -a never           /status "Custom (workspace, never)"
//
// Two observations worth freezing, because both were expected otherwise:
//
//  1. codex `plan` lands in codex's NAMED "Read Only" preset, not the
//     `Custom (…)` bucket that `manual` and `auto` land in. Nothing depends on
//     the label — we pin the axes by flag — but do not "fix" a report that
//     reads "Read Only (untrusted)" into "Custom (read-only, untrusted)".
//  2. /status always PRINTS a `Collaboration mode:` row; under every rung above
//     it reads `Default`. "Collaboration axis unset" therefore means "not set
//     to Plan", NOT "the row is absent". The claude bypass screen in particular
//     is load-bearing: it is the premise of the default `trust_prompt` policy
//     launchInputPolicy installs in src/chat/conversation.ts, and it does still
//     paint on a fresh HOME (probed with an otherwise-authenticated HOME that
//     carried no prior trust/bypass acceptance).
//
// The canonical rung is `ask`, NOT `acceptEdits`: the wire contract freezes
// {plan, manual, ask, auto, bypass}. `acceptEdits` is (i) claude's NATIVE argv
// value, which the `ask` rung emits, and (ii) an accepted INPUT spelling.
// Ordering is deliberate: `ask` sits ABOVE `manual` because it auto-accepts
// edits.
//
// Encoding note (settled by META-HARNESS-132 against codex-cli 0.144.5): we
// emit `-s`/`-a` flags, never `-c sandbox_mode=` / `-c approval_policy=`. Flags
// beat `-c` unconditionally in either order; a repeated `-c` is silent
// last-wins while a repeated `-s` is a hard exit-2. `-c` fails open and quiet,
// `-s`/`-a` fails closed or loud. The `-c` spellings remain the equivalent form
// a CALLER may pass verbatim (which suppresses injection, see below), never
// what we emit. Rationale mirrored in docs/design/permission-argv-parity.md §2.
// codex's `--full-auto` is NOT used: removed in 0.144.5, now a hard error.
import { argsContainAnyFlag, argsContainConfigKey, normHarness, prependArgs, } from "./harnessargs.js";
import { ClaudeModeAcceptEdits, ClaudeModeBypassPermissions, ClaudeModeDontAsk, ClaudeSkipPermissionsFlags, CodexApprovalNever, CodexApprovalOnRequest, CodexApprovalUntrusted, CodexBypassFlag, CodexSandboxDangerFullAccess, CodexSandboxReadOnly, CodexSandboxWorkspaceWrite, PermissionModeAsk, PermissionModeAuto, PermissionModeBypass, PermissionModeManual, PermissionModePlan, } from "./permissionrungs.js";
/**
 * claude flags that pin the permission axis out of band. Any of them in argv
 * suppresses injection entirely.
 */
const claudeGuardFlags = [
    "--permission-mode",
    ...ClaudeSkipPermissionsFlags,
];
/**
 * codex flags that pin (or can pin) either permission axis out of band.
 *
 * The set is deliberately a STRICT SUPERSET of what we emit: we emit only
 * `-s`/`-a`, yet `-p`/`--profile` is guarded too, because a profile
 * ($CODEX_HOME/<name>.config.toml) supplies every axis the caller leaves
 * unset — probed at 0.144.5, a flag or `-c` beats the profile on the axis it
 * SETS, in either order, but the profile still fills in the rest, so
 * `-s read-only -p wide` is a posture that is not a rung at all. The rule is
 * unconditional on `-p`'s presence, NOT scoped to "-p and no -s".
 *
 * `-p` is SUPPRESSED rather than REJECTED because argv proves nothing here:
 * reject when argv proves the launch would be unrestricted; suppress when argv
 * makes the launch posture unknowable.
 *
 * Note the claude asymmetry — `-p` must NEVER be guarded on claude, where it
 * is `--print`.
 */
const codexGuardFlags = [
    "-s",
    "--sandbox",
    "-a",
    "--ask-for-approval",
    "-p",
    "--profile",
    CodexBypassFlag,
];
/**
 * codex config keys that move a permission axis. Guarded even though we never
 * emit them: do NOT "tidy" these out for symmetry with what we emit. A caller's
 * `-c` is silently last-wins against another `-c` and loses to our `-s`, so
 * dropping them re-opens a fail-open where the rung we report is not the rung
 * that launched.
 */
const codexSandboxConfigKey = "sandbox_mode";
const codexApprovalConfigKey = "approval_policy";
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
export function isSupportedPermissionMode(harness, mode) {
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code":
            return claudePermissionValue(mode) !== "";
        case "codex":
            return codexPermissionArgs(mode).length > 0;
        default:
            return false;
    }
}
/**
 * harnessSupportsPermissionMode reports whether the harness has a launch-time
 * permission axis at all. Mirrors harnessSupportsEffort.
 */
export function harnessSupportsPermissionMode(harness) {
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code":
        case "codex":
            return true;
        default:
            return false;
    }
}
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
export function argsWithHarnessPermissionMode(harness, args, mode) {
    if (mode === "")
        return args;
    switch (normHarness(harness)) {
        case "claude":
        case "claude-code": {
            if (argsContainAnyFlag(args, claudeGuardFlags))
                return args;
            const value = claudePermissionValue(mode);
            if (value === "")
                return args;
            return prependArgs(args, "--permission-mode", value);
        }
        case "codex": {
            if (argsContainAnyFlag(args, codexGuardFlags))
                return args;
            if (argsContainConfigKey(args, codexSandboxConfigKey))
                return args;
            if (argsContainConfigKey(args, codexApprovalConfigKey))
                return args;
            const injected = codexPermissionArgs(mode);
            if (injected.length === 0)
                return args;
            return prependArgs(args, ...injected);
        }
        default:
            return args;
    }
}
/**
 * claudePermissionValue maps an accepted input spelling to claude's native
 * --permission-mode value, or "" when claude does not accept it. Note `ask` and
 * `acceptEdits` collapse onto the same argv, as do `bypass` and
 * `bypassPermissions`.
 */
function claudePermissionValue(mode) {
    switch (mode) {
        case PermissionModePlan:
            return PermissionModePlan;
        case PermissionModeManual:
            return PermissionModeManual;
        case PermissionModeAsk:
        case ClaudeModeAcceptEdits:
            return ClaudeModeAcceptEdits;
        case PermissionModeAuto:
            return PermissionModeAuto;
        case PermissionModeBypass:
        case ClaudeModeBypassPermissions:
            return ClaudeModeBypassPermissions;
        case ClaudeModeDontAsk:
            return ClaudeModeDontAsk;
        default:
            return "";
    }
}
/**
 * codexPermissionArgs returns the codex argv for mode, or an empty array when
 * codex does not accept it. Canonical rungs take the pair arm; the three native
 * sandbox values take the single-axis arm.
 */
function codexPermissionArgs(mode) {
    switch (mode) {
        case PermissionModePlan:
            return ["-s", CodexSandboxReadOnly, "-a", CodexApprovalUntrusted];
        case PermissionModeManual:
            return ["-s", CodexSandboxWorkspaceWrite, "-a", CodexApprovalUntrusted];
        case PermissionModeAsk:
            return ["-s", CodexSandboxWorkspaceWrite, "-a", CodexApprovalOnRequest];
        case PermissionModeAuto:
            return ["-s", CodexSandboxWorkspaceWrite, "-a", CodexApprovalNever];
        case PermissionModeBypass:
            return ["-s", CodexSandboxDangerFullAccess, "-a", CodexApprovalNever];
        case CodexSandboxReadOnly:
        case CodexSandboxWorkspaceWrite:
        case CodexSandboxDangerFullAccess:
            // Single-axis arm: the approval axis stays at the user's config.
            return ["-s", mode];
        default:
            return [];
    }
}
//# sourceMappingURL=permission.js.map