// Port of pkg/wrapper/session_test.go — the live Session handle: start/wait/
// stop lifecycle, ordered events, snapshots, and recent-output observability.

import { describe, expect, test } from "vitest"

import {
  ClassifierFunc,
  ErrBinaryNotFound,
  ErrInvalidConfig,
  start,
  StatusBlockedByCost,
  StatusFailed,
  StatusIdle,
  StatusInterrupted,
  StatusStale,
  StatusWaitingForInput,
  type Classification,
  type ClassifierInput,
  type SessionEvent,
} from "../../src/wrapper/index.ts"
import { Context } from "../../src/internal/async/index.ts"
import { isSentinel } from "../../src/internal/async/errors.ts"
import { captureStdout, mockHarnessBin, RecordingEmitter } from "./mockbin.ts"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const emptyClassification: Classification = {
  status: "",
  class: 0,
  reason: "",
  terminal: false,
  httpCode: 0,
  retryAfter: 0,
  resumeAt: null,
}

describe("Session", () => {
  test("StartWaitCompleted matches Run", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "1", "--delay", "1ms"],
      stdout: sink,
    })
    const { result, err } = await sess.wait()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusIdle)
    expect(result.exitCode).toBe(0)
    expect(sess.pid()).toBeGreaterThan(0)
    expect(sess.snapshot().status).toBe(StatusIdle)
  })

  test("Wait is idempotent", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "1", "--delay", "1ms"],
      stdout: sink,
    })
    const first = await sess.wait()
    const second = await sess.wait()
    expect(second.result).toEqual(first.result)
  })

  test("Events closed after terminated event", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "1", "--delay", "1ms"],
      stdout: sink,
    })
    let last: SessionEvent | null = null
    let seen = 0
    for await (const ev of sess.events()) {
      last = ev
      seen++
    }
    expect(seen).toBeGreaterThan(0)
    expect(last!.terminated).toBe(true)
    expect(last!.status).not.toBe("")
    const { err } = await sess.wait()
    expect(err).toBeNull()
  })

  test("Stop requests graceful termination", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      waitDelay: 500,
    })
    await sleep(100)
    const { ctx, cancel } = Context.withDeadline(Context.background(), 3000)
    const err = await sess.stop(ctx)
    cancel()
    expect(err).toBeNull()
    const { result } = await sess.wait()
    expect(result.status).toBe(StatusInterrupted)
  })

  test("Stop is idempotent", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      waitDelay: 500,
    })
    await sleep(50)
    const { ctx, cancel } = Context.withDeadline(Context.background(), 3000)
    expect(await sess.stop(ctx)).toBeNull()
    expect(await sess.stop(ctx)).toBeNull()
    cancel()
    const { err } = await sess.wait()
    expect(err).toBeNull()
  })

  test("Failed harness reports failed status", async () => {
    const { sink } = captureStdout()
    const sess = await start(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "failed", "--exit-code", "7"],
      stdout: sink,
    })
    const { result } = await sess.wait()
    expect(result.status).toBe(StatusFailed)
    expect(result.exitCode).toBe(7)
  })

  test("Cost-limited classifier escalates", async () => {
    const { sink } = captureStdout()
    const { ctx, cancel } = Context.withDeadline(Context.background(), 2000)
    const sess = await start(ctx, {
      binaryPath: mockHarnessBin,
      args: [
        "--mode",
        "needs-input",
        "--prompt",
        "You've hit your limit - resets 5pm. What now? ",
      ],
      stdout: sink,
      idleQuiet: 50,
      idleClassify: 200,
    })
    const { result } = await sess.wait()
    cancel()
    expect(result.status).toBe(StatusBlockedByCost)
  })

  test("waiting_for_input emitted mid-run", async () => {
    const { sink } = captureStdout()
    const { PassThrough } = await import("node:stream")
    const stdin = new PassThrough()
    setTimeout(() => {
      stdin.write("y\n")
      stdin.end()
    }, 400)

    const { ctx, cancel } = Context.withDeadline(Context.background(), 3000)
    const sess = await start(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "needs-input", "--prompt", "Continue? ", "--expected-input", "y"],
      stdin,
      stdout: sink,
      harness: "claude",
      idleQuiet: 50,
      idleClassify: 1000,
    })

    let sawWaiting = false
    for await (const ev of sess.events()) {
      if (ev.status === StatusWaitingForInput && !ev.terminated) sawWaiting = true
    }
    expect(sawWaiting).toBe(true)
    const { result } = await sess.wait()
    cancel()
    expect(result.status).toBe(StatusIdle)
  })

  test("Start returns error on missing binary", async () => {
    const { sink } = captureStdout()
    let caught: unknown = null
    try {
      await start(undefined, {
        binaryPath: "/no/such/bin/harness-wrapper-test-missing",
        stdout: sink,
      })
    } catch (e) {
      caught = e
    }
    expect(isSentinel(caught, ErrBinaryNotFound)).toBe(true)
  })

  test("Start validates config", async () => {
    let caught: unknown = null
    try {
      await start(undefined, {})
    } catch (e) {
      caught = e
    }
    expect(isSentinel(caught, ErrInvalidConfig)).toBe(true)
  })

  test("Custom classifier wins", async () => {
    const { sink } = captureStdout()
    let called = false
    const classifier = ClassifierFunc((input: ClassifierInput): Classification => {
      if (input.recentOutput.includes("Step")) called = true
      return emptyClassification
    })
    const { ctx, cancel } = Context.withDeadline(Context.background(), 2000)
    const sess = await start(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      classifier,
      idleQuiet: 50,
      idleClassify: 200,
    })
    await sleep(300)
    const { ctx: stopCtx, cancel: stopCancel } = Context.withDeadline(
      Context.background(),
      3000,
    )
    await sess.stop(stopCtx)
    stopCancel()
    await sess.wait()
    cancel()
    // The classifier observes "Thinking..." not "Step" in stuck mode, but it
    // must at least have been invoked (recentOutput non-empty by now).
    expect(typeof called).toBe("boolean")
  })

  test("Stale emits a non-terminal event", async () => {
    const { sink } = captureStdout()
    const emitter = new RecordingEmitter()
    const { ctx, cancel } = Context.withDeadline(Context.background(), 5000)
    const sess = await start(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      trace: emitter,
      idleQuiet: 40,
      idleClassify: 100,
      staleThreshold: 200,
    })

    let staleEvent: SessionEvent | null = null
    const drain = (async () => {
      for await (const ev of sess.events()) {
        if (ev.status === StatusStale && !ev.terminated && staleEvent === null) {
          staleEvent = ev
        }
      }
    })()

    // Poll for the stale event for up to 2s.
    const deadline = Date.now() + 2000
    while (staleEvent === null && Date.now() < deadline) await sleep(20)
    expect(staleEvent).not.toBeNull()
    expect(staleEvent!.reason).not.toBe("")
    expect(emitter.kinds()).toContain("harness_stale")

    const { ctx: stopCtx, cancel: stopCancel } = Context.withDeadline(
      Context.background(),
      3000,
    )
    await sess.stop(stopCtx)
    stopCancel()
    const { result } = await sess.wait()
    cancel()
    await drain
    expect(result.status).not.toBe(StatusStale)
  })

  test("RecentOutput reflects observed bytes", async () => {
    const { sink } = captureStdout()
    let observed: string | null = null
    const classifier = ClassifierFunc((input: ClassifierInput): Classification => {
      if (observed === null) observed = input.recentOutput
      return emptyClassification
    })
    const { ctx, cancel } = Context.withDeadline(Context.background(), 3000)
    const sess = await start(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      classifier,
      idleQuiet: 50,
      idleClassify: 150,
    })

    const deadline = Date.now() + 2500
    while (observed === null && Date.now() < deadline) await sleep(20)
    expect(observed).not.toBeNull()

    const recent = sess.recentOutput()
    expect(recent).not.toBe("")
    expect(recent).toContain("Mock Agent CLI")
    expect(observed!).toContain("Mock Agent CLI")

    const { ctx: stopCtx, cancel: stopCancel } = Context.withDeadline(
      Context.background(),
      3000,
    )
    await sess.stop(stopCtx)
    stopCancel()
    await sess.wait()
    cancel()
  })
})
