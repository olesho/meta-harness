// Port of pkg/wrapper/session_api_error_test.go — the api_error contract:
// classified mid-run, non-terminal, keeps the harness alive, de-duplicated,
// and never contaminating the terminal Result.Status.

import { describe, expect, test } from "bun:test"

import {
  start,
  StatusAPIError,
  StatusIdle,
  StatusInterrupted,
  type Config,
  type Session,
  type SessionEvent,
} from "../../src/wrapper/index.ts"
import { Context } from "../../src/internal/async/index.ts"
import { captureStdout, mockHarnessBin, RecordingEmitter } from "./mockbin.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Drain events until a non-terminal StatusAPIError arrives, or fail on timeout. */
async function awaitAPIError(sess: Session, timeoutMs: number): Promise<SessionEvent> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("timeout waiting for api_error event")
    const recv = await Promise.race([
      sess.events().receive(),
      sleep(remaining).then(() => "timeout" as const),
    ])
    if (recv === "timeout") throw new Error("timeout waiting for api_error event")
    if (!recv.ok) throw new Error("events channel closed before api_error arrived")
    const ev = recv.value!
    if (ev.status === StatusAPIError && !ev.terminated) return ev
  }
}

/** After the first api_error, keep reading for `extra` ms; return total count. */
async function countAPIErrorsOver(
  sess: Session,
  firstTimeoutMs: number,
  extraMs: number,
): Promise<number> {
  await awaitAPIError(sess, firstTimeoutMs)
  let count = 1
  const deadline = Date.now() + extraMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return count
    const recv = await Promise.race([
      sess.events().receive(),
      sleep(remaining).then(() => "timeout" as const),
    ])
    if (recv === "timeout") return count
    if (!recv.ok) return count
    const ev = recv.value!
    if (ev.status === StatusAPIError && !ev.terminated) count++
  }
}

/** Signal-0 probe: true iff the process is alive. */
function processAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

function apiErrorConfig(sink: Config["stdout"], ...args: string[]): Config {
  return {
    binaryPath: mockHarnessBin,
    args,
    stdout: sink,
    harness: "claude",
    idleQuiet: 200,
    idleClassify: 200,
    waitDelay: 500,
  }
}

async function cleanupStop(sess: Session): Promise<void> {
  await sess.stop()
  await sess.wait()
}

describe("Session api_error", () => {
  test("S1: API error → keep alive", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "API Error: 529 Overloaded.",
    ))
    try {
      const ev = await awaitAPIError(sess, 3000)
      expect(ev.httpCode).toBe(529)
      expect(ev.terminated).toBe(false)
      expect(processAlive(sess.pid())).toBe(true)
      expect(sess.snapshot().status).toBe(StatusAPIError)
    } finally {
      await cleanupStop(sess)
    }
  })

  test("S1b: transport-error variant (no HTTP code)", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "  ⎿  API Error: The socket connection was closed unexpectedly.",
    ))
    try {
      const ev = await awaitAPIError(sess, 3000)
      expect(ev.httpCode).toBe(0)
      expect(ev.reason).toContain("socket connection was closed")
    } finally {
      await cleanupStop(sess)
    }
  })

  test("S2: RetryAfter propagates end-to-end", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "API Error: 429 Too Many Requests. Retry after 30 seconds.",
    ))
    try {
      const ev = await awaitAPIError(sess, 3000)
      expect(ev.httpCode).toBe(429)
      expect(ev.retryAfter).toBe(30_000)
    } finally {
      await cleanupStop(sess)
    }
  })

  test("S3: de-duplication", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "API Error: 529 Overloaded.",
      "--api-error-repeat", "3",
      "--api-error-repeat-gap", "100ms",
    ))
    try {
      const seen = await countAPIErrorsOver(sess, 3000, 1500)
      expect(seen).toBe(1)
    } finally {
      await cleanupStop(sess)
    }
  })

  test("S4: recovery exits idle", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "API Error: 529 Overloaded.",
      "--api-error-recover", "true",
      "--steps", "2",
      "--delay", "1ms",
    ))
    await awaitAPIError(sess, 3000)
    const { result, err } = await sess.wait()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusIdle)
  })

  test("S5: Stop overrides terminal status", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "API Error: 529 Overloaded.",
    ))
    await awaitAPIError(sess, 3000)
    expect(sess.snapshot().status).toBe(StatusAPIError)

    const { ctx, cancel } = Context.withDeadline(Context.background(), 3000)
    expect(await sess.stop(ctx)).toBeNull()
    cancel()
    const { result } = await sess.wait()
    expect(result.status).toBe(StatusInterrupted)
  })

  test("S6: harness_api_error trace emission", async () => {
    const { sink } = captureStdout()
    const rec = new RecordingEmitter()
    const cfg = apiErrorConfig(sink,
      "--mode", "api-error",
      "--api-error-msg", "API Error: 529 Overloaded.",
    )
    cfg.trace = rec
    const sess = await start(undefined, cfg)
    try {
      await awaitAPIError(sess, 3000)
      await sleep(200)
      let found = false
      for (const e of rec.events) {
        if (e.kind !== "harness_api_error") continue
        found = true
        expect(e.fields?.http_code).toBe(529)
      }
      expect(found).toBe(true)
    } finally {
      await cleanupStop(sess)
    }
  })

  test("S7: no regression on idle harness", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "2", "--delay", "1ms"],
      stdout: sink,
    })
    let sawAPIError = false
    for await (const ev of sess.events()) {
      if (ev.status === StatusAPIError) sawAPIError = true
    }
    expect(sawAPIError).toBe(false)
    const { result } = await sess.wait()
    expect(result.status).toBe(StatusIdle)
  })
})
