export declare const PermissionModePlan = "plan";
export declare const PermissionModeManual = "manual";
export declare const PermissionModeAsk = "ask";
export declare const PermissionModeAuto = "auto";
export declare const PermissionModeBypass = "bypass";
export declare const ClaudeModeAcceptEdits = "acceptEdits";
export declare const ClaudeModeDontAsk = "dontAsk";
export declare const ClaudeModeBypassPermissions = "bypassPermissions";
export declare const CodexSandboxReadOnly = "read-only";
export declare const CodexSandboxWorkspaceWrite = "workspace-write";
export declare const CodexSandboxDangerFullAccess = "danger-full-access";
export declare const CodexApprovalUntrusted = "untrusted";
export declare const CodexApprovalOnRequest = "on-request";
export declare const CodexApprovalNever = "never";
/**
 * Claude Code's --permission-mode flag: the single spelling that carries the
 * whole claude permission axis.
 *
 * Exported for the same reason the flag SETS below are: this module is the
 * replay authority for these spellings, so it is their natural home and the
 * one place a live conformance check can derive them from rather than retype
 * them (test/conformance.test.ts, check 1).
 */
export declare const ClaudePermissionModeFlag = "--permission-mode";
/**
 * Claude Code's blanket permission-bypass flags. Both spellings exist at
 * claude-code 2.1.217; either one in argv leaves the harness unrestricted.
 */
export declare const ClaudeSkipPermissionsFlags: readonly string[];
/** codex's blanket approval+sandbox bypass flag. */
export declare const CodexBypassFlag = "--dangerously-bypass-approvals-and-sandbox";
/** codex's sandbox-axis flag, short and long spelling. */
export declare const CodexSandboxFlags: readonly string[];
/** codex's approval-axis flag, short and long spelling. */
export declare const CodexApprovalFlags: readonly string[];
/** codex's profile flag: a profile can set BOTH permission axes out of band. */
export declare const CodexProfileFlags: readonly string[];
/**
 * permissionRungs returns the canonical rungs, ordered least to most
 * permissive.
 *
 * A fresh array per call: callers (a permission ring, say) may sort, truncate
 * or reverse the result without corrupting a later call.
 */
export declare function permissionRungs(): string[];
/**
 * morePermissive reports whether rung a is strictly more permissive than b, by
 * index in permissionRungs().
 *
 * Unknown rungs are never more permissive (fail closed): an empty string, a
 * native spelling ("acceptEdits", "danger-full-access") or a typo yields false
 * for a, so a caller asking "may I stay where I am?" never gets a yes it did
 * not earn. Note b being unknown ALSO yields false, so the answer is false
 * whenever either side is not a canonical rung.
 */
export declare function morePermissive(a: string, b: string): boolean;
/**
 * effectiveLaunchRung reports the rung the harness ACTUALLY launched with,
 * given the caller's argv and the requested permission mode — i.e. it replays
 * the injection suppression rule rather than trusting the knob alone. Unlike
 * argsContainAnyFlag, which answers PRESENCE only, this extracts the VALUE
 * from every spelling (`--permission-mode=x`, `--permission-mode x`,
 * `-sread-only`) and normalizes native spellings (acceptEdits -> ask, codex's
 * -s/-a pairs -> their rungs).
 *
 * A bypass-enabling flag in argv is itself reported as a definite bypass: it
 * suppresses injection AND leaves the harness unrestricted, so there is
 * nothing unknown about the result, and it WINS over a restrictive
 * --permission-mode in the same argv.
 *
 * Returns "" when argv carries a permission flag whose value cannot be
 * resolved (a trailing flag with no operand, an unrecognized spelling), when
 * the launch posture is unknowable (codex's --profile, or a sandbox_mode /
 * approval_policy config override), when only codex's -a axis is set (which
 * suppresses injection but leaves the sandbox at the harness default), and
 * when neither argv nor mode says anything. "" means UNKNOWN, never
 * "default" — callers must not treat it as a definite non-bypass answer.
 *
 * Passing ALREADY-INJECTED args is safe — the function is idempotent over
 * injection, because injection self-suppresses: once the axis is in argv the
 * presence check short-circuits the second pass and the argv arm reads back
 * the value that was injected. Formally,
 * effectiveLaunchRung(h, argsWithHarnessPermissionMode(h, args, mode), mode)
 * === effectiveLaunchRung(h, args, mode).
 *
 * The codex arm resolves in EXACTLY this order:
 *
 *  1. `--dangerously-bypass-approvals-and-sandbox` present -> bypass.
 *  2. Proof-of-unrestricted, checked BEFORE any unknowability rule. If
 *     flagValue(args, "-s", "--sandbox") resolves (last-wins) to
 *     danger-full-access, OR the sandbox_mode config key resolves (quotes
 *     stripped) to danger-full-access -> bypass. Required, not optional: every
 *     unrestricted launch path must report it, and a caller's
 *     `-c sandbox_mode=` suppresses injection, so without this arm the most
 *     dangerous codex launch would report "".
 *  3. Unknowable posture -> "". If -p/--profile is present, or either the
 *     sandbox_mode or approval_policy config key is present -> "". This fires
 *     REGARDLESS of whether -s is present: `-s read-only -p wide` resolves to
 *     read-only plus the profile's own approval policy, and that pair is
 *     nowhere in the forward map — naming it would under-report the approval
 *     axis, the one direction a safety field must never fail in. Rule 2 is the
 *     single exception, and it is a CEILING, not a floor.
 *  4. -s present but unreadable (trailing flag, no operand) -> "".
 *  5. -s readable as v, with p = flagValue(args, "-a", "--ask-for-approval"):
 *     exact (v, p) pair match -> that rung, per the forward map; p absent or
 *     unreadable -> the CEILING for v; v unrecognized -> "".
 *  6. -s absent and -a/--ask-for-approval present -> "".
 *  7. Otherwise -> the knob arm, codexRung(mode).
 *
 * The forward map is a bijection on (sandbox, approval) pairs:
 *
 *	rung     emitted (-s, -a)                  replayed as
 *	plan     (read-only, untrusted)            manual   <- never plan
 *	manual   (workspace-write, untrusted)      manual
 *	ask      (workspace-write, on-request)     ask
 *	auto     (workspace-write, never)          auto
 *	bypass   (danger-full-access, never)       bypass
 *
 * manual is workspace-write, NOT read-only — codex manual must permit writes
 * after approval, matching claude's. Two rungs therefore share an -s value,
 * which is exactly why the replay must read BOTH axes; a single-axis inverse
 * would replay a manual launch as ask, i.e. MORE permissive than requested.
 */
export declare function effectiveLaunchRung(harness: string, args: string[], mode: string): string;
//# sourceMappingURL=permissionrungs.d.ts.map