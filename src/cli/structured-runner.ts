#!/usr/bin/env node
// Structured sandbox runner — a Node entry that drives ONE harness turn in-guest
// and emits a single JSON line carrying the reply AND the canonical transcript
// (read from the harness's on-disk session), so a host orchestrator gets
// transcript_entries without a second round-trip.
//
// Contrast with run.ts: that is the reply-on-stdout CLI (the reply is the whole
// contract, and it can't expose harnessSessionID). This one takes the prompt via
// --prompt-file when present, otherwise from stdin (Go-structured-run parity) —
// file wins, stdin is the fallback. Both are SAFE transports (never
// shell-interpolated). It reads the transcript back via the per-harness Readers
// and prints a structured result. Loom's sandbox task runner parses the LAST
// stdout line as that result.
//
// Grammar:
//   structured-runner [--prompt-file <path>] [--effort E] [--model M] [--permission-mode P] [--sandbox-defaults] <name> -- <harness args...>
//
// Exit codes (coarse orchestration signal; the JSON payload is the source of truth):
//   0   — completed
//   1   — errored / startup failure / fatal
//   2   — usage: bad args, unknown harness, missing/empty prompt
//   124 — deadline (also prints the literal harness-wrapper deadline line on stderr)

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  runOneShotDetailed,
  cleanEnv,
  type OneShotOutcome,
} from "../oneshot/index.ts";
import { Context } from "../async/index.ts";
import {
  ClaudeCodeReader,
  CodexReader,
  toPublicJSON,
  usageToPublicJSON,
} from "../transcript/index.ts";
// Reached DIRECTLY rather than through a barrel: neither module is re-exported
// from src/wrapper/api.ts, deliberately — a public re-export would move
// test/testdata/ts_surface.golden, and src/cli/** is outside both barrel guards.
// Precedent: src/cli/screenbench-record.ts imports ../wrapper/internal/pty.ts.
import {
  argvPermissionPin,
  isSupportedPermissionMode,
} from "../wrapper/internal/permission.ts";
import { effectiveLaunchRung } from "../wrapper/internal/permissionrungs.ts";

// Exit codes + DeadlineLine come from the ONE shared protocol module
// (src/turnproto). Re-exported here so this CLI's tested surface — test/cli/
// structured-runner.test.ts imports ExitOK from this module — stays UNCHANGED.
export {
  ExitOK,
  ExitError,
  ExitUsage,
  ExitDeadline,
  DeadlineLine,
} from "../turnproto/index.ts";

import {
  ExitOK,
  ExitError,
  ExitUsage,
  ExitDeadline,
  DeadlineLine,
  parseTimeoutMs,
} from "../turnproto/index.ts";

// resolveHarnessName / resolveBinaryPath are NOT protocol (the exit codes now
// live in src/turnproto). They mirror run.ts's helpers and stay local to each
// CLI so neither pulls the other into its module graph.
export function resolveHarnessName(
  name: string,
): "claude-code" | "codex" | null {
  switch (name) {
    case "claude":
    case "claude-code":
      return "claude-code";
    case "codex":
      return "codex";
    default:
      return null;
  }
}

function resolveBinaryPath(
  harness: string,
  env: Record<string, string | undefined>,
): string {
  const key = "HARNESS_BINARY_" + harness.toUpperCase().replace(/-/g, "_");
  return env[key] ?? env.HARNESS_BINARY ?? harness;
}

// metaHarnessArgs — sandbox-default argv injection, OPT-IN via --sandbox-defaults
// (off by default so argv is forwarded verbatim, matching Go structured-run):
// when set, claude gets the permission bypass, codex gets no argv injection.
// effort/model flow through OneShotConfig, not here.
//
// Equivalent in intent to `permissionMode: "bypass"` for claude-code only.
// When --permission-mode is also set it wins for argv (this returns []); the
// IS_SANDBOX=1 half still applies, unconditionally and independently of the
// resolved mode — see buildGuestEnv, which takes no mode parameter at all.
//
// PRECEDENCE, and why it lives HERE. Under the wrapper's all-or-nothing
// injection-suppression rule --dangerously-skip-permissions sits in claude's
// guarded flag set, so leaving it on the argv would make argsWithHarnessPermission-
// Mode inject NOTHING: a harness-GENERATED flag silently beating the caller's
// EXPLICIT knob (`--sandbox-defaults --permission-mode plan claude` would run as
// bypass). Suppressing the injection here — in the single auditable place the
// bypass token is generated, rather than by teaching the wrapper chain about
// --sandbox-defaults — removes that footgun for the tokens meta-harness itself
// emits. The pair is LEGAL, not an error: --sandbox-defaults --permission-mode
// bypass is precisely the fresh-HOME-safe combination (IS_SANDBOX=1 suppresses
// claude's "Bypass Permissions mode" acceptance screen, src/chat/ready.ts).
//
// The predicate tests SET-ness, not validity. "" means unset (matching
// src/env/turn.ts's buildArgv guard and the wrapper chain's argsWithHarnessEffort),
// so `--sandbox-defaults --permission-mode "" claude` keeps the bypass token
// rather than silently losing BOTH halves of the argv. An unrecognized rung does
// suppress the token, but never silently: the wrapper's validateConfig rejects it
// with ErrInvalidConfig before any spawn, so the turn fails loudly as `errored`.
//
// NOT covered, deliberately: a caller-supplied --dangerously-skip-permissions
// after `--` still wins over an explicit --permission-mode. A verbatim caller
// argument beating a translated flag is the established convention of the whole
// argsWith… chain; making --permission-mode the one knob that overrides an
// explicit caller token would be the surprising rule. So the two tokens never
// coexist BY INJECTION — a caller can still put both there themselves.
function metaHarnessArgs(
  harness: string,
  sandboxDefaults: boolean,
  permissionMode: string | undefined,
): string[] {
  if (permissionMode !== undefined && permissionMode !== "") return [];
  return sandboxDefaults && harness === "claude-code"
    ? ["--dangerously-skip-permissions"]
    : [];
}

/** buildGuestEnv assembles the guest env entries from the host env. With
 *  sandboxDefaults, IS_SANDBOX is set/OVERWRITTEN to "1" — a single entry, never
 *  a duplicate KEY=VALUE pair when the host already sets IS_SANDBOX. Without it,
 *  the host env passes through verbatim: a host-preset IS_SANDBOX is neither
 *  stripped nor rewritten. Composed with cleanEnv by the caller. */
export function buildGuestEnv(
  baseEnv: Record<string, string | undefined>,
  sandboxDefaults: boolean,
): string[] {
  const merged = sandboxDefaults ? { ...baseEnv, IS_SANDBOX: "1" } : baseEnv;
  return Object.entries(merged).map(([k, v]) => `${k}=${v ?? ""}`);
}

/**
 * resolveTimeoutMs — precedence: LOOM_LOCAL_TASK_TIMEOUT_MS (plain milliseconds,
 * structured-runner-only loom override) → HARNESS_WRAPPER_RUN_TIMEOUT (Go
 * duration, shared with the run CLI and the Go wrapper) → 15m default. Invalid
 * or non-positive values fall through to the next source in the chain.
 */
export function resolveTimeoutMs(
  env: Record<string, string | undefined>,
): number {
  const raw = (env.LOOM_LOCAL_TASK_TIMEOUT_MS ?? "").trim();
  const ms = Number(raw);
  if (Number.isFinite(ms) && ms > 0) return ms;
  return parseTimeoutMs(env.HARNESS_WRAPPER_RUN_TIMEOUT);
}

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

/**
 * parseStructuredArgs — flags (--prompt-file/--effort/--model/--permission-mode) precede <name>;
 * <name> is the first non-flag token; a `--` separator forwards the remainder to
 * the harness. The prompt is NEVER an argument (it comes from --prompt-file or
 * stdin), so a prompt with quotes/newlines/leading-dashes can't corrupt the argv
 * or the shell.
 */
/** Valued — the flags that take an operand (both `--flag V` and `--flag=V`). */
type Valued = "--prompt-file" | "--effort" | "--model" | "--permission-mode";

export function parseStructuredArgs(argv: string[]): StructuredArgs {
  const out: StructuredArgs = { harnessArgs: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      return out;
    }
    if (a === "--") {
      out.error = "missing <name> before `--`";
      return out;
    }
    const valued = (flag: Valued): boolean => {
      if (a === flag) {
        const v = argv[i + 1];
        if (v === undefined) {
          out.error = `flag ${flag} requires a value`;
          return true;
        }
        assign(flag, v);
        i++;
        return true;
      }
      if (a.startsWith(flag + "=")) {
        assign(flag, a.slice(flag.length + 1));
        return true;
      }
      return false;
    };
    // EXHAUSTIVE switch, deliberately with no assigning catch-all: a bare
    // `else out.model = v` would make every flag added to valued()'s union
    // silently land in `model`. The default branch asserts `never` so widening
    // that union without extending this switch is a COMPILE error.
    const assign = (flag: Valued, v: string) => {
      switch (flag) {
        case "--prompt-file":
          out.promptFile = v;
          break;
        case "--effort":
          out.effort = v;
          break;
        case "--model":
          out.model = v;
          break;
        case "--permission-mode":
          out.permissionMode = v;
          break;
        default: {
          const _exhaustive: never = flag;
          void _exhaustive;
        }
      }
    };
    if (valued("--prompt-file")) {
      if (out.error) return out;
      continue;
    }
    if (valued("--effort")) {
      if (out.error) return out;
      continue;
    }
    if (valued("--model")) {
      if (out.error) return out;
      continue;
    }
    if (valued("--permission-mode")) {
      if (out.error) return out;
      continue;
    }
    // --sandbox-defaults is BOOLEAN (valueless): the =-form is rejected with a
    // deliberate message rather than the catch-all's generic "unknown flag".
    if (a === "--sandbox-defaults") {
      out.sandboxDefaults = true;
      continue;
    }
    if (a.startsWith("--sandbox-defaults=")) {
      out.error = "flag --sandbox-defaults takes no value";
      return out;
    }
    if (a.startsWith("-")) {
      out.error = `unknown flag: ${a}`;
      return out;
    }
    out.name = a;
    i++;
    break;
  }
  // --sandbox-defaults and --permission-mode COMPOSE — the pair is deliberately
  // not a usage error. `--sandbox-defaults --permission-mode bypass` is the
  // fresh-HOME-safe combination, so rejecting it would be wrong. The precedence
  // between them is resolved in metaHarnessArgs (explicit mode wins for argv;
  // the IS_SANDBOX=1 env half is untouched), not by the parser.
  if (out.name === undefined) {
    out.error = "missing <name>";
    return out;
  }
  if (i < argv.length) {
    if (argv[i] === "--") out.harnessArgs = argv.slice(i + 1);
    else {
      out.error = `unexpected argument: ${argv[i]} (harness args must follow \`--\`)`;
      return out;
    }
  }
  return out;
}

/** readTranscript reads the harness's on-disk session and maps to the public DTO. */
export function readTranscript(
  harness: string,
  harnessSessionID: string,
  workingDir: string,
): Record<string, unknown>[] {
  if (!harnessSessionID) return [];
  const reader =
    harness === "claude-code" ? new ClaudeCodeReader() : new CodexReader();
  return reader.read(harnessSessionID, workingDir).map(toPublicJSON);
}

/** readUsage reads the session's token totals; null when none recorded. */
export function readUsage(
  harness: string,
  harnessSessionID: string,
  workingDir: string,
): Record<string, number> | null {
  if (!harnessSessionID) return null;
  const reader =
    harness === "claude-code" ? new ClaudeCodeReader() : new CodexReader();
  const usage = reader.readUsage(harnessSessionID, workingDir);
  return usage ? usageToPublicJSON(usage) : null;
}

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
export function reportedPermissionRung(
  harness: string,
  parsed: StructuredArgs,
): string | undefined {
  const args = [
    ...metaHarnessArgs(
      harness,
      parsed.sandboxDefaults === true,
      parsed.permissionMode,
    ),
    ...parsed.harnessArgs,
  ];
  const requested = parsed.permissionMode ?? "";

  const rung = effectiveLaunchRung(harness, args, requested);
  if (rung !== "") return rung;

  const pin = argvPermissionPin(harness, args);
  // An off-ladder native spelling in argv — the runner knows the rung PRECISELY
  // even though the ladder cannot name it; a sentinel would erase that.
  if (pin.kind === "native") return pin.value;
  if (pin.kind === "opaque") return "override";
  // Nothing in argv. A requested mode this harness has no canonical rung for
  // (again dontAsk) was still injected verbatim, so report it verbatim — but
  // ONLY when the injector would in fact have injected it. isSupportedPermission
  // Mode is that exact predicate: a harness with no permission axis, or a
  // spelling this harness does not accept, leaves argv untouched, so reporting
  // the request would name a rung nothing ever launched at.
  if (requested !== "" && isSupportedPermissionMode(harness, requested)) {
    return requested;
  }
  // Nothing requested, nothing injected. Key ABSENT — never "" and never
  // "default".
  return undefined;
}

function exitFor(status: OneShotOutcome["status"]): number {
  if (status === "completed") return ExitOK;
  if (status === "deadline") return ExitDeadline;
  return ExitError;
}

/** reasonOf narrows the union: only errored/startup_error carry a reason. */
function reasonOf(outcome: OneShotOutcome): string | undefined {
  return "reason" in outcome ? outcome.reason : undefined;
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// readStdin mirrors src/cli/run.ts:196-210 verbatim — duplicated privately per
// house style (run.ts and hooks.ts each keep their own copy) rather than exported.
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  let len = 0;
  for (const c of chunks) len += c.length;
  const buf = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

const HELP = `meta-harness structured-runner — one-shot harness turn → JSON result line

usage: structured-runner [--prompt-file <path>] [--effort E] [--model M] [--permission-mode P] [--sandbox-defaults] <name> -- <harness args...>

  --prompt-file P     read the prompt from file P (safe transport; falls back to stdin when absent)
  <name>              short alias: claude → claude-code, codex → codex
  --effort E          reasoning effort passed to the harness
  --model M           model passed to the harness
  --permission-mode P launch-time permission mode (plan, manual, ask, auto, bypass)
  --sandbox-defaults  opt into sandbox defaults: IS_SANDBOX=1 in the guest env
                      (all harnesses) and --dangerously-skip-permissions
                      prepended to the argv (claude-code only). Off by default:
                      argv and env are forwarded verbatim. Equivalent in intent
                      to --permission-mode bypass for claude-code only. When
                      --permission-mode is also set it wins for argv; the
                      IS_SANDBOX=1 half still applies, unconditionally and
                      independently of the resolved mode.
  --                  everything after is forwarded verbatim to the harness

Emits ONE JSON line on stdout: { status, reply, harnessSessionID, transcript_entries,
usage?, reason?, transcript_error?, permission_mode?, working_dir }.
permission_mode is the rung the runner LAUNCHED at (telemetry, not authorization):
a canonical rung, "override" when argv pins a posture no single token names, or
absent when nothing was requested and nothing injected.
Exit: 0 completed · 1 errored · 2 usage · 124 deadline.
`;

export async function main(argv: string[]): Promise<number> {
  const parsed = parseStructuredArgs(argv);
  if (parsed.help) {
    process.stdout.write(HELP);
    return ExitOK;
  }
  if (parsed.error) {
    process.stderr.write("structured-runner: " + parsed.error + "\n");
    return ExitUsage;
  }
  const harness = resolveHarnessName(parsed.name!);
  if (harness === null) {
    process.stderr.write(
      `structured-runner: unknown harness: ${parsed.name}\n`,
    );
    return ExitUsage;
  }
  // Prompt source: --prompt-file wins when present (stdin untouched); otherwise
  // read stdin (Go-structured-run parity). Read-failure → ExitError on both.
  let prompt: string;
  if (parsed.promptFile) {
    try {
      prompt = readFileSync(parsed.promptFile, "utf8");
    } catch (err) {
      process.stderr.write(
        "structured-runner: failed to read prompt file: " + String(err) + "\n",
      );
      return ExitError;
    }
  } else {
    try {
      prompt = await readStdin();
    } catch (err) {
      process.stderr.write(
        "structured-runner: failed to read stdin: " + String(err) + "\n",
      );
      return ExitError;
    }
  }
  if (prompt.trim() === "") {
    process.stderr.write("structured-runner: empty prompt\n");
    return ExitUsage;
  }

  const workingDir =
    (process.env.LOOM_WORKTREE_PATH ?? "").trim() || process.cwd();
  const env = cleanEnv(
    buildGuestEnv(process.env, parsed.sandboxDefaults === true),
  );
  const binaryPath = resolveBinaryPath(harness, process.env);
  // Hoisted ABOVE the try so BOTH emit sites share one expression: the launch
  // was attempted at this rung even when it throws before producing an outcome.
  const permissionMode = reportedPermissionRung(harness, parsed);
  const { ctx, cancel } = Context.withDeadline(
    Context.background(),
    resolveTimeoutMs(process.env),
  );

  let outcome: OneShotOutcome;
  try {
    outcome = await runOneShotDetailed(ctx, {
      harness,
      binaryPath,
      prompt,
      args: [
        ...metaHarnessArgs(
          harness,
          parsed.sandboxDefaults === true,
          parsed.permissionMode,
        ),
        ...parsed.harnessArgs,
      ],
      workingDir,
      env,
      effort: parsed.effort,
      model: parsed.model,
      permissionMode: parsed.permissionMode,
    });
  } catch (err) {
    emit({
      status: "errored",
      reply: "",
      harnessSessionID: "",
      transcript_entries: [],
      reason: err instanceof Error ? err.message : String(err),
      permission_mode: permissionMode,
      working_dir: workingDir,
    });
    return ExitError;
  } finally {
    cancel();
  }

  // Read the transcript + usage back in-guest — best-effort so a Reader failure
  // never erases a successful reply.
  let transcriptEntries: Record<string, unknown>[] = [];
  let transcriptError: string | undefined;
  try {
    transcriptEntries = readTranscript(
      harness,
      outcome.harnessSessionID ?? "",
      workingDir,
    );
  } catch (err) {
    transcriptError = err instanceof Error ? err.message : String(err);
  }
  let usage: Record<string, number> | null = null;
  try {
    usage = readUsage(harness, outcome.harnessSessionID ?? "", workingDir);
  } catch {
    // usage is additive telemetry — a read failure must not fail the turn, and
    // transcript_error already carries the locate/read diagnosis when both fail.
  }

  emit({
    status: outcome.status,
    reply: outcome.status === "completed" ? outcome.reply : "",
    harnessSessionID: outcome.harnessSessionID ?? "",
    transcript_entries: transcriptEntries,
    usage: usage ?? undefined,
    reason: reasonOf(outcome),
    transcript_error: transcriptError,
    permission_mode: permissionMode,
    working_dir: workingDir,
  });
  if (outcome.status === "deadline") {
    process.stderr.write(DeadlineLine + "\n");
  }
  return exitFor(outcome.status);
}

// Entry point — only when executed directly (Node has no import.meta.main).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write("structured-runner: fatal: " + String(err) + "\n");
      process.exit(ExitError);
    },
  );
}
