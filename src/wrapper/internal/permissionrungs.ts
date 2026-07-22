// Canonical permission rungs and the REPLAY surface that reconstructs, from
// launch argv plus the requested mode, the rung a harness actually launched
// at. The TS counterpart of Go's PermissionRungs / MorePermissive /
// EffectiveLaunchRung (pkg/wrapper/wrapper.go).
//
// This module owns the canonical rung constants — it is the single TS rung
// list. The forthcoming permission.ts (the injection half) re-imports them
// from here rather than redeclaring them. It deliberately depends on nothing
// but harnessargs.ts.

import {
  argsContainAnyFlag,
  argsContainConfigKey,
  configKeyValue,
  flagValue,
  normHarness,
} from "./harnessargs.ts";

// The canonical rung vocabulary, least to most permissive. "ask" is the
// canonical spelling; "acceptEdits" is claude's NATIVE --permission-mode
// spelling and only ever an accepted INPUT that normalizes to "ask".
export const PermissionModePlan = "plan";
export const PermissionModeManual = "manual";
export const PermissionModeAsk = "ask";
export const PermissionModeAuto = "auto";
export const PermissionModeBypass = "bypass";

// claude-native --permission-mode spellings.
export const ClaudeModeAcceptEdits = "acceptEdits";
export const ClaudeModeDontAsk = "dontAsk";
export const ClaudeModeBypassPermissions = "bypassPermissions";

// codex -s/--sandbox values.
export const CodexSandboxReadOnly = "read-only";
export const CodexSandboxWorkspaceWrite = "workspace-write";
export const CodexSandboxDangerFullAccess = "danger-full-access";

// codex -a/--ask-for-approval values.
export const CodexApprovalUntrusted = "untrusted";
export const CodexApprovalOnRequest = "on-request";
export const CodexApprovalNever = "never";

/**
 * Claude Code's blanket permission-bypass flags. Both spellings exist at
 * claude-code 2.1.217; either one in argv leaves the harness unrestricted.
 */
export const ClaudeSkipPermissionsFlags: readonly string[] = [
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
];

/** codex's blanket approval+sandbox bypass flag. */
export const CodexBypassFlag = "--dangerously-bypass-approvals-and-sandbox";

/** codex's profile flag: a profile can set BOTH permission axes out of band. */
const codexProfileFlags: readonly string[] = ["-p", "--profile"];

/** codex's approval-axis flag. */
const codexApprovalFlags: readonly string[] = ["-a", "--ask-for-approval"];

/** codex config keys that move a permission axis out of band. */
const codexSandboxConfigKey = "sandbox_mode";
const codexApprovalConfigKey = "approval_policy";

/**
 * permissionRungs returns the canonical rungs, ordered least to most
 * permissive.
 *
 * A fresh array per call: callers (a permission ring, say) may sort, truncate
 * or reverse the result without corrupting a later call.
 */
export function permissionRungs(): string[] {
  return [
    PermissionModePlan,
    PermissionModeManual,
    PermissionModeAsk,
    PermissionModeAuto,
    PermissionModeBypass,
  ];
}

/**
 * rungIndex returns the position of rung in permissionRungs(), or -1 when rung
 * is not a canonical rung.
 */
function rungIndex(rung: string): number {
  return permissionRungs().indexOf(rung);
}

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
export function morePermissive(a: string, b: string): boolean {
  const ai = rungIndex(a);
  const bi = rungIndex(b);
  if (ai < 0 || bi < 0) return false;
  return ai > bi;
}

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
export function effectiveLaunchRung(
  harness: string,
  args: string[],
  mode: string,
): string {
  switch (normHarness(harness)) {
    case "claude":
    case "claude-code":
      if (argsContainAnyFlag(args, ClaudeSkipPermissionsFlags)) {
        // Definite bypass, and it beats a restrictive --permission-mode in the
        // same argv: the flag leaves the harness unrestricted either way.
        return PermissionModeBypass;
      }
      {
        const [value, ok] = flagValue(args, "--permission-mode");
        // argv wins, mirroring the suppression rule.
        if (ok) return claudeRung(value);
      }
      return claudeRung(mode);
    case "codex":
      return codexLaunchRung(args, mode);
    default:
      // No launch-time permission axis: nothing was injected and nothing in
      // argv is ours to interpret.
      return "";
  }
}

/** The codex arm of effectiveLaunchRung; see its doc comment for the rules. */
function codexLaunchRung(args: string[], mode: string): string {
  // 1. Blanket bypass flag.
  if (argsContainAnyFlag(args, [CodexBypassFlag])) return PermissionModeBypass;

  const [sandbox, sandboxOK] = flagValue(args, "-s", "--sandbox");
  const [sandboxCfg, sandboxCfgOK] = configKeyValue(
    args,
    codexSandboxConfigKey,
  );

  // 2. Proof-of-unrestricted, ahead of every unknowability rule.
  if (sandboxOK && sandbox === CodexSandboxDangerFullAccess) {
    return PermissionModeBypass;
  }
  if (sandboxCfgOK && sandboxCfg === CodexSandboxDangerFullAccess) {
    return PermissionModeBypass;
  }

  // 3. Unknowable posture: a profile or a config override can move either axis
  //    out of band, including the approval axis we cannot see from argv.
  if (argsContainAnyFlag(args, codexProfileFlags)) return "";
  if (sandboxCfgOK) return "";
  if (argsContainConfigKey(args, codexApprovalConfigKey)) return "";

  if (sandboxOK) {
    // 4. Present but unreadable.
    if (sandbox === "") return "";
    // 5. Both axes when the approval axis is readable, the ceiling otherwise.
    const [approval, approvalOK] = flagValue(args, "-a", "--ask-for-approval");
    if (approvalOK && approval !== "") return codexPairRung(sandbox, approval);
    return codexSandboxRung(sandbox);
  }

  // 6. Whole-directive suppression fired with no sandbox value to read.
  if (argsContainAnyFlag(args, codexApprovalFlags)) return "";

  // 7. Nothing in argv: replay the knob.
  return codexRung(mode);
}

/**
 * codexPairRung inverts the forward map on an exact (sandbox, approval) pair.
 * A pair no rung emits — e.g. (read-only, never) — is unknown (""), never
 * rounded to a neighbouring rung.
 */
function codexPairRung(sandbox: string, approval: string): string {
  if (sandbox === CodexSandboxReadOnly && approval === CodexApprovalUntrusted) {
    // The only rung emitting this pair is plan, which replays as manual.
    return PermissionModeManual;
  }
  if (sandbox === CodexSandboxWorkspaceWrite) {
    switch (approval) {
      case CodexApprovalUntrusted:
        return PermissionModeManual;
      case CodexApprovalOnRequest:
        return PermissionModeAsk;
      case CodexApprovalNever:
        return PermissionModeAuto;
      default:
        return "";
    }
  }
  if (
    sandbox === CodexSandboxDangerFullAccess &&
    approval === CodexApprovalNever
  ) {
    return PermissionModeBypass;
  }
  return "";
}

/**
 * codexSandboxRung maps a codex -s/--sandbox value, with NO readable approval
 * axis, to its canonical rung — the single-axis CEILING table:
 *
 *	-s value            rung     why
 *	read-only           manual   the only rung emitting it is plan, which
 *	                             reports manual
 *	workspace-write     auto     manual/ask/auto all emit it; auto is the
 *	                             ceiling, and a bare -s leaves approval at
 *	                             whatever ~/.codex/config.toml holds — which
 *	                             /permissions writes into — so it may in fact
 *	                             be never
 *	danger-full-access  bypass   the proof-of-unrestricted guarantee
 *
 * The ceiling lives HERE rather than only in the argv arm because the
 * single-axis KNOB (mode: "workspace-write") emits exactly `-s workspace-write`
 * and leaves -a to the user's config — the identical posture a bare
 * `-s workspace-write` in argv produces. One posture must not get two answers,
 * or idempotency-over-injection breaks for {codex, [], "workspace-write"}.
 */
function codexSandboxRung(value: string): string {
  switch (value) {
    case CodexSandboxReadOnly:
      return PermissionModeManual;
    case CodexSandboxWorkspaceWrite:
      return PermissionModeAuto;
    case CodexSandboxDangerFullAccess:
      return PermissionModeBypass;
    default:
      return "";
  }
}

/**
 * codexRung normalizes the requested permission mode for codex: canonical
 * rungs pass through, codex-native sandbox values map through the ceiling
 * table.
 *
 * plan is the one canonical rung that does NOT pass through: codex has no
 * plan-shaped launch posture, so the plan rung emits (read-only, untrusted),
 * which replays as manual. The knob must agree with the argv it produces or
 * idempotency-over-injection breaks for {codex, [], "plan"}.
 */
function codexRung(value: string): string {
  if (value === PermissionModePlan) return PermissionModeManual;
  if (rungIndex(value) >= 0) return value;
  return codexSandboxRung(value);
}

/**
 * claudeRung normalizes a canonical rung or a claude-native --permission-mode
 * value to a canonical rung. claude's dontAsk has NO canonical rung and so
 * reports unknown ("") rather than being guessed into ask or auto.
 */
function claudeRung(value: string): string {
  switch (value) {
    case ClaudeModeAcceptEdits:
      return PermissionModeAsk;
    case ClaudeModeBypassPermissions:
      return PermissionModeBypass;
    default:
      break;
  }
  if (rungIndex(value) >= 0) return value;
  return "";
}
