// Wrapper configuration, validation, and wrapper-level sentinel errors.
//
// PTY supervision (Session/Run) is out of scope for the classifier core; this
// module ports only the config surface those entry points validate against,
// plus the cause-chain sentinels callers test with isSentinel.

import { defineSentinel, isSentinel, wrap, type Sentinel } from "../../internal/async/errors.ts"
import { type Classifier } from "./classification.ts"
import { harnessSupportsEffort, isSupportedEffort } from "./effort.ts"
import { type Emitter } from "../trace.ts"

/**
 * Wrapper-level sentinel errors. Callers use isSentinel(err, X) to distinguish
 * wrapper failures from harness outcomes — the cause-chain analogue of Go's
 * errors.Is with the package's sentinel vars.
 */
export const ErrInvalidConfig: Sentinel = defineSentinel(
  "wrapper:invalid-config",
  "wrapper: invalid config",
)
export const ErrBinaryNotFound: Sentinel = defineSentinel(
  "wrapper:binary-not-found",
  "wrapper: binary not found",
)

/** Configuration for a wrapper run. Durations are in milliseconds. */
export interface Config {
  /** Path to the harness binary (required). */
  binaryPath?: string
  /** Destination for harness stdout (required). */
  stdout?: unknown
  /** Harness name ("claude", "codex", "gemini", "claude-code", …). */
  harness?: string
  /** Harness CLI args. */
  args?: string[]
  /** Environment as "KEY=VALUE" entries. */
  env?: string[]
  /** Reasoning effort (low/medium/high/xhigh/max). */
  effort?: string
  /** Model override. */
  model?: string
  /** Quiet threshold (ms). */
  idleQuiet?: number
  /** Classify threshold (ms). */
  idleClassify?: number
  /** Stale threshold (ms). */
  staleThreshold?: number
  /** Wait after SIGTERM before escalating to SIGKILL (ms). */
  waitDelay?: number
  /** Optional explicit classifier overriding per-harness resolution. */
  classifier?: Classifier | null
  /** Working directory for the harness. Defaults to the current directory. */
  workingDir?: string
  /** Source forwarded into the harness PTY input. */
  stdin?: unknown
  /** Diagnostic trace emitter. Defaults to Discard. */
  trace?: Emitter | null
  /**
   * Durable internal line tap. Receives every complete line of the harness's
   * RAW PTY output, in order, with no drops: invoked synchronously in the PTY
   * read loop. This is the load-bearing tap for session-id capture and live
   * transcript parsing. Bytes are split on '\n' with a trailing '\r' trimmed;
   * a final unterminated line is flushed once when the PTY closes. ANSI/control
   * sequences are NOT stripped.
   */
  onLine?: ((line: string) => void) | null
}

/**
 * Validate a config, returning an Error (wrapping ErrInvalidConfig) on failure
 * or null when the config is acceptable to Start.
 */
export function validateConfig(cfg: Config): Error | null {
  if (!cfg.binaryPath) {
    return wrap("wrapper: invalid config: BinaryPath is required", ErrInvalidConfig)
  }
  if (cfg.stdout == null) {
    return wrap("wrapper: invalid config: Stdout is required", ErrInvalidConfig)
  }
  const idleClassify = cfg.idleClassify ?? 0
  const idleQuiet = cfg.idleQuiet ?? 0
  const staleThreshold = cfg.staleThreshold ?? 0
  if (idleClassify > 0 && idleQuiet > 0 && idleClassify < idleQuiet) {
    return wrap(
      `wrapper: invalid config: IdleClassify (${idleClassify}) must be >= IdleQuiet (${idleQuiet})`,
      ErrInvalidConfig,
    )
  }
  if (staleThreshold > 0 && idleClassify > 0 && staleThreshold < idleClassify) {
    return wrap(
      `wrapper: invalid config: StaleThreshold (${staleThreshold}) must be >= IdleClassify (${idleClassify})`,
      ErrInvalidConfig,
    )
  }
  if (cfg.effort && cfg.effort !== "") {
    if (!isSupportedEffort(cfg.effort)) {
      return wrap(
        "wrapper: invalid config: Effort must be one of low, medium, high, xhigh, max",
        ErrInvalidConfig,
      )
    }
    if (!harnessSupportsEffort(cfg.harness ?? "")) {
      return wrap(
        "wrapper: invalid config: Effort is only supported for claude, codex, and gemini harnesses",
        ErrInvalidConfig,
      )
    }
  }
  return null
}

/** Report whether err indicates the configured harness binary was not found. */
export function isBinaryNotFound(err: unknown): boolean {
  if (isSentinel(err, ErrBinaryNotFound)) return true
  // Node's spawn surfaces a missing executable as ENOENT.
  let cur: unknown = err
  const seen = new Set<unknown>()
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur)
    if ((cur as { code?: unknown }).code === "ENOENT") return true
    cur = (cur as { cause?: unknown }).cause
  }
  return false
}
