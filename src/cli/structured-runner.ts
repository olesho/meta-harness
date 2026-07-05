#!/usr/bin/env node
// Structured sandbox runner — a Node entry that drives ONE harness turn in-guest
// and emits a single JSON line carrying the reply AND the canonical transcript
// (read from the harness's on-disk session), so a host orchestrator gets
// transcript_entries without a second round-trip.
//
// Contrast with run.ts: that is the Bun-only, reply-on-stdout CLI (the reply is the
// whole contract, and it can't expose harnessSessionID). This one is Node-only
// (consumes the compiled dist), takes the prompt via --prompt-file (a SAFE
// transport — never shell-interpolated), reads the transcript back via the
// per-harness Readers, and prints a structured result. Loom's sandbox task runner
// parses the LAST stdout line as that result.
//
// Grammar:
//   structured-runner --prompt-file <path> [--effort E] [--model M] <name> -- <harness args...>
//
// Exit codes (coarse orchestration signal; the JSON payload is the source of truth):
//   0   — completed
//   1   — errored / startup failure / fatal
//   2   — usage: bad args, unknown harness, missing/empty prompt
//   124 — deadline (also prints the literal harness-wrapper deadline line on stderr)

import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

import { runOneShotDetailed, cleanEnv, type OneShotOutcome } from "../oneshot/index.ts"
import { Context } from "../async/index.ts"
import { ClaudeCodeReader, CodexReader, toPublicJSON } from "../transcript/index.ts"

export const ExitOK = 0
export const ExitError = 1
export const ExitUsage = 2
export const ExitDeadline = 124

/** The literal stderr anchor the orchestrator's deadline regex matches on 124. */
export const DeadlineLine = "harness-wrapper run: context deadline exceeded"

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

// resolveHarnessName / resolveBinaryPath / the exit codes intentionally mirror
// run.ts. They are duplicated (not imported) so run.ts stays a Bun-only leaf that
// this Node entry never pulls into its module graph.
export function resolveHarnessName(name: string): "claude-code" | "codex" | null {
  switch (name) {
    case "claude":
    case "claude-code":
      return "claude-code"
    case "codex":
      return "codex"
    default:
      return null
  }
}

function resolveBinaryPath(harness: string, env: Record<string, string | undefined>): string {
  const key = "HARNESS_BINARY_" + harness.toUpperCase().replace(/-/g, "_")
  return env[key] ?? env.HARNESS_BINARY ?? harness
}

// metaHarnessArgs mirrors loom's local runner + orche: claude needs the permission
// bypass, codex needs none. effort/model flow through OneShotConfig, not here.
function metaHarnessArgs(harness: string): string[] {
  return harness === "claude-code" ? ["--dangerously-skip-permissions"] : []
}

function resolveTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = (env.LOOM_LOCAL_TASK_TIMEOUT_MS ?? "").trim()
  const ms = Number(raw)
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS
}

export interface StructuredArgs {
  help?: boolean
  error?: string
  name?: string
  promptFile?: string
  effort?: string
  model?: string
  harnessArgs: string[]
}

/**
 * parseStructuredArgs — flags (--prompt-file/--effort/--model) precede <name>;
 * <name> is the first non-flag token; a `--` separator forwards the remainder to
 * the harness. The prompt is NEVER an argument (only --prompt-file), so a prompt
 * with quotes/newlines/leading-dashes can't corrupt the argv or the shell.
 */
export function parseStructuredArgs(argv: string[]): StructuredArgs {
  const out: StructuredArgs = { harnessArgs: [] }
  let i = 0
  for (; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "-h" || a === "--help") {
      out.help = true
      return out
    }
    if (a === "--") {
      out.error = "missing <name> before `--`"
      return out
    }
    const valued = (flag: "--prompt-file" | "--effort" | "--model"): boolean => {
      if (a === flag) {
        const v = argv[i + 1]
        if (v === undefined) {
          out.error = `flag ${flag} requires a value`
          return true
        }
        assign(flag, v)
        i++
        return true
      }
      if (a.startsWith(flag + "=")) {
        assign(flag, a.slice(flag.length + 1))
        return true
      }
      return false
    }
    const assign = (flag: string, v: string) => {
      if (flag === "--prompt-file") out.promptFile = v
      else if (flag === "--effort") out.effort = v
      else out.model = v
    }
    if (valued("--prompt-file")) {
      if (out.error) return out
      continue
    }
    if (valued("--effort")) {
      if (out.error) return out
      continue
    }
    if (valued("--model")) {
      if (out.error) return out
      continue
    }
    if (a.startsWith("-")) {
      out.error = `unknown flag: ${a}`
      return out
    }
    out.name = a
    i++
    break
  }
  if (out.name === undefined) {
    out.error = "missing <name>"
    return out
  }
  if (i < argv.length) {
    if (argv[i] === "--") out.harnessArgs = argv.slice(i + 1)
    else {
      out.error = `unexpected argument: ${argv[i]} (harness args must follow \`--\`)`
      return out
    }
  }
  return out
}

/** readTranscript reads the harness's on-disk session and maps to the public DTO. */
export function readTranscript(
  harness: string,
  harnessSessionID: string,
  workingDir: string,
): Array<Record<string, unknown>> {
  if (!harnessSessionID) return []
  const reader = harness === "claude-code" ? new ClaudeCodeReader() : new CodexReader()
  return reader.read(harnessSessionID, workingDir).map(toPublicJSON)
}

function exitFor(status: OneShotOutcome["status"]): number {
  if (status === "completed") return ExitOK
  if (status === "deadline") return ExitDeadline
  return ExitError
}

/** reasonOf narrows the union: only errored/startup_error carry a reason. */
function reasonOf(outcome: OneShotOutcome): string | undefined {
  return "reason" in outcome ? outcome.reason : undefined
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + "\n")
}

const HELP = `meta-harness structured-runner — one-shot harness turn → JSON result line

usage: structured-runner --prompt-file <path> [--effort E] [--model M] <name> -- <harness args...>

  --prompt-file P   read the prompt from file P (required; safe transport)
  <name>            short alias: claude → claude-code, codex → codex
  --effort E        reasoning effort passed to the harness
  --model M         model passed to the harness
  --                everything after is forwarded verbatim to the harness

Emits ONE JSON line on stdout: { status, reply, harnessSessionID, transcript_entries,
reason?, transcript_error?, working_dir }. Exit: 0 completed · 1 errored · 2 usage · 124 deadline.
`

export async function main(argv: string[]): Promise<number> {
  const parsed = parseStructuredArgs(argv)
  if (parsed.help) {
    process.stdout.write(HELP)
    return ExitOK
  }
  if (parsed.error) {
    process.stderr.write("structured-runner: " + parsed.error + "\n")
    return ExitUsage
  }
  const harness = resolveHarnessName(parsed.name!)
  if (harness === null) {
    process.stderr.write(`structured-runner: unknown harness: ${parsed.name}\n`)
    return ExitUsage
  }
  if (!parsed.promptFile) {
    process.stderr.write("structured-runner: --prompt-file is required\n")
    return ExitUsage
  }

  let prompt: string
  try {
    prompt = readFileSync(parsed.promptFile, "utf8")
  } catch (err) {
    process.stderr.write("structured-runner: failed to read prompt file: " + String(err) + "\n")
    return ExitError
  }
  if (prompt.trim() === "") {
    process.stderr.write("structured-runner: empty prompt\n")
    return ExitUsage
  }

  const workingDir = (process.env.LOOM_WORKTREE_PATH ?? "").trim() || process.cwd()
  const env = cleanEnv([
    ...Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`),
    "IS_SANDBOX=1",
  ])
  const binaryPath = resolveBinaryPath(harness, process.env)
  const { ctx, cancel } = Context.withDeadline(Context.background(), resolveTimeoutMs(process.env))

  let outcome: OneShotOutcome
  try {
    outcome = await runOneShotDetailed(ctx, {
      harness,
      binaryPath,
      prompt,
      args: [...metaHarnessArgs(harness), ...parsed.harnessArgs],
      workingDir,
      env,
      effort: parsed.effort,
      model: parsed.model,
    })
  } catch (err) {
    emit({
      status: "errored",
      reply: "",
      harnessSessionID: "",
      transcript_entries: [],
      reason: err instanceof Error ? err.message : String(err),
      working_dir: workingDir,
    })
    return ExitError
  } finally {
    cancel()
  }

  // Read the transcript back in-guest — best-effort so a Reader failure never
  // erases a successful reply.
  let transcriptEntries: Array<Record<string, unknown>> = []
  let transcriptError: string | undefined
  try {
    transcriptEntries = readTranscript(harness, outcome.harnessSessionID ?? "", workingDir)
  } catch (err) {
    transcriptError = err instanceof Error ? err.message : String(err)
  }

  emit({
    status: outcome.status,
    reply: outcome.status === "completed" ? outcome.reply : "",
    harnessSessionID: outcome.harnessSessionID ?? "",
    transcript_entries: transcriptEntries,
    reason: reasonOf(outcome),
    transcript_error: transcriptError,
    working_dir: workingDir,
  })
  if (outcome.status === "deadline") {
    process.stderr.write(DeadlineLine + "\n")
  }
  return exitFor(outcome.status)
}

// Entry point — only when executed directly (Node has no import.meta.main).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write("structured-runner: fatal: " + String(err) + "\n")
      process.exit(ExitError)
    },
  )
}
