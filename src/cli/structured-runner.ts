#!/usr/bin/env node
// Structured sandbox runner — a Node entry that drives ONE harness turn in-guest
// and emits a single JSON line carrying the reply AND the canonical transcript
// (read from the harness's on-disk session), so a host orchestrator gets
// transcript_entries without a second round-trip.
//
// Contrast with run.ts: that is the reply-on-stdout CLI (the reply is the whole
// contract, and it can't expose harnessSessionID). This one takes the prompt
// via --prompt-file (a SAFE
// transport — never shell-interpolated), reads the transcript back via the
// per-harness Readers, and prints a structured result. Loom's sandbox task runner
// parses the LAST stdout line as that result.
//
// Grammar:
//   structured-runner --prompt-file <path> [--effort E] [--model M] [--sandbox-defaults] <name> -- <harness args...>
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
} from "../turnproto/index.ts";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

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
function metaHarnessArgs(harness: string, sandboxDefaults: boolean): string[] {
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

function resolveTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = (env.LOOM_LOCAL_TASK_TIMEOUT_MS ?? "").trim();
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

export interface StructuredArgs {
  help?: boolean;
  error?: string;
  name?: string;
  promptFile?: string;
  effort?: string;
  model?: string;
  sandboxDefaults?: boolean;
  harnessArgs: string[];
}

/**
 * parseStructuredArgs — flags (--prompt-file/--effort/--model) precede <name>;
 * <name> is the first non-flag token; a `--` separator forwards the remainder to
 * the harness. The prompt is NEVER an argument (only --prompt-file), so a prompt
 * with quotes/newlines/leading-dashes can't corrupt the argv or the shell.
 */
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
    const valued = (
      flag: "--prompt-file" | "--effort" | "--model",
    ): boolean => {
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
    const assign = (flag: string, v: string) => {
      if (flag === "--prompt-file") out.promptFile = v;
      else if (flag === "--effort") out.effort = v;
      else out.model = v;
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

const HELP = `meta-harness structured-runner — one-shot harness turn → JSON result line

usage: structured-runner --prompt-file <path> [--effort E] [--model M] [--sandbox-defaults] <name> -- <harness args...>

  --prompt-file P     read the prompt from file P (required; safe transport)
  <name>              short alias: claude → claude-code, codex → codex
  --effort E          reasoning effort passed to the harness
  --model M           model passed to the harness
  --sandbox-defaults  opt into sandbox defaults: IS_SANDBOX=1 in the guest env
                      (all harnesses) and --dangerously-skip-permissions
                      prepended to the argv (claude-code only). Off by default:
                      argv and env are forwarded verbatim.
  --                  everything after is forwarded verbatim to the harness

Emits ONE JSON line on stdout: { status, reply, harnessSessionID, transcript_entries,
usage?, reason?, transcript_error?, working_dir }. Exit: 0 completed · 1 errored · 2 usage · 124 deadline.
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
  if (!parsed.promptFile) {
    process.stderr.write("structured-runner: --prompt-file is required\n");
    return ExitUsage;
  }

  let prompt: string;
  try {
    prompt = readFileSync(parsed.promptFile, "utf8");
  } catch (err) {
    process.stderr.write(
      "structured-runner: failed to read prompt file: " + String(err) + "\n",
    );
    return ExitError;
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
        ...metaHarnessArgs(harness, parsed.sandboxDefaults === true),
        ...parsed.harnessArgs,
      ],
      workingDir,
      env,
      effort: parsed.effort,
      model: parsed.model,
    });
  } catch (err) {
    emit({
      status: "errored",
      reply: "",
      harnessSessionID: "",
      transcript_entries: [],
      reason: err instanceof Error ? err.message : String(err),
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
