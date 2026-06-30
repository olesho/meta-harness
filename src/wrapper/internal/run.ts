// Start / Run — the wrapper's two entry points.
//
// Start launches the harness under the Node PTY bridge and returns a live
// Session. Run is the blocking convenience wrapper (Start + wait) for callers
// that don't need a live handle. Mirrors pkg/wrapper/wrapper.go.

import { isSentinel } from "../../internal/async/errors.ts"
import { type Config, ErrBinaryNotFound, validateConfig } from "./config.ts"
import { argsWithHarnessEffort, envWithHarnessEffort } from "./effort.ts"
import { argsWithHarnessModel } from "./mode.ts"
import { binaryNotFoundError, PtyProcess, resolveBinary } from "./pty.ts"
import {
  applyDefaults,
  type Result,
  type Session,
  startSession,
} from "./session.ts"
import { StatusBinaryNotFound } from "./status.ts"
import { ErrNone } from "./errorclass.ts"

/** A cancellation context (the async toolkit's Context, or anything done()-shaped). */
export interface RunContext {
  done(): Promise<void>
  err?(): unknown
}

function envToRecord(env: string[]): Record<string, string> | undefined {
  if (env.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const entry of env) {
    const i = entry.indexOf("=")
    if (i < 0) {
      out[entry] = ""
    } else {
      out[entry.slice(0, i)] = entry.slice(i + 1)
    }
  }
  return out
}

/**
 * Launch the configured harness under a pseudoterminal and return a live
 * Session. Throws a cause-chain error (ErrInvalidConfig / ErrBinaryNotFound /
 * ErrPTYAllocation) only when the wrapper itself fails to start; once a Session
 * is returned, every harness outcome flows through Session.wait().
 */
export async function start(ctx: RunContext | undefined, cfg: Config): Promise<Session> {
  const invalid = validateConfig(cfg)
  if (invalid) throw invalid
  applyDefaults(cfg)

  let args = cfg.args ?? []
  args = argsWithHarnessEffort(cfg.harness ?? "", args, cfg.effort ?? "")
  args = argsWithHarnessModel(cfg.harness ?? "", args, cfg.model ?? "")
  const env = envWithHarnessEffort(cfg.harness ?? "", cfg.env ?? null, cfg.effort ?? "")
  const envRecord = envToRecord(env)

  // Preflight the binary: node-pty only surfaces a missing harness as an opaque
  // exit(1), so resolve it up front and fail with ErrBinaryNotFound.
  const resolved = resolveBinary(cfg.binaryPath ?? "", envRecord)
  if (resolved === null) throw binaryNotFoundError(cfg.binaryPath ?? "")

  cfg.trace?.emit({
    at: new Date(),
    kind: "wrapper_started",
    fields: {
      binary_path: cfg.binaryPath,
      args,
      working_dir: cfg.workingDir,
      idle_quiet: cfg.idleQuiet,
      idle_classify: cfg.idleClassify,
      wait_delay: cfg.waitDelay,
    },
  })

  const pty = await PtyProcess.spawn({
    binaryPath: resolved,
    args,
    cwd: cfg.workingDir,
    env: envRecord,
  })
  return startSession(cfg, pty, ctx)
}

/**
 * Start the harness, supervise it to completion, and return the normalized
 * outcome. A non-null err means the wrapper itself failed; harness outcomes are
 * always reported through result with err === null.
 */
export async function run(
  ctx: RunContext | undefined,
  cfg: Config,
): Promise<{ result: Result; err: Error | null }> {
  let session: Session
  try {
    session = await start(ctx, cfg)
  } catch (err) {
    const result: Result = {
      status: "",
      class: ErrNone,
      exitCode: -1,
      signal: "",
      reason: "",
      pid: 0,
      startedAt: null,
      endedAt: null,
      lastOutputAt: null,
    }
    if (isSentinel(err, ErrBinaryNotFound)) {
      result.status = StatusBinaryNotFound
      result.reason = err instanceof Error ? err.message : String(err)
    }
    return { result, err: err instanceof Error ? err : new Error(String(err)) }
  }
  return session.wait()
}
