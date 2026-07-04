// Port of pkg/wrapper/wrapper_test.go — Run() across the mock harness modes.

import { describe, expect, test } from "bun:test"

import {
  ErrBinaryNotFound,
  ErrInvalidConfig,
  run,
  StatusBinaryNotFound,
  StatusBlockedByCost,
  StatusFailed,
  StatusIdle,
  StatusInterrupted,
} from "../../src/wrapper/index.ts"
import { Context } from "../../src/internal/async/index.ts"
import { isSentinel } from "../../src/internal/async/errors.ts"
import { captureStdout, mockHarnessBin, RecordingEmitter } from "./mockbin.ts"

describe("Run", () => {
  test("completed mode → idle, exit 0, output captured", async () => {
    const { sink, drain } = captureStdout()
    const { result, err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "2", "--delay", "1ms"],
      stdout: sink,
    })
    const output = drain()

    expect(err).toBeNull()
    expect(result.status).toBe(StatusIdle)
    expect(result.exitCode).toBe(0)
    expect(result.pid).toBeGreaterThan(0)
    expect(result.lastOutputAt).not.toBeNull()
    for (const want of ["Mock Agent CLI", "Step 1/2", "Step 2/2", "DONE"]) {
      expect(output).toContain(want)
    }
  })

  test("failed mode → failed with exit code and reason", async () => {
    const { sink, drain } = captureStdout()
    const { result, err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "failed", "--exit-code", "7"],
      stdout: sink,
    })
    drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusFailed)
    expect(result.exitCode).toBe(7)
    expect(result.reason).not.toBe("")
  })

  test("empty binary path → ErrInvalidConfig", async () => {
    const { sink } = captureStdout()
    const { err } = await run(undefined, { binaryPath: "", stdout: sink })
    expect(isSentinel(err, ErrInvalidConfig)).toBe(true)
  })

  test("nil stdout → ErrInvalidConfig", async () => {
    const { err } = await run(undefined, { binaryPath: mockHarnessBin })
    expect(isSentinel(err, ErrInvalidConfig)).toBe(true)
  })

  test("binary not found → ErrBinaryNotFound + StatusBinaryNotFound", async () => {
    const { sink } = captureStdout()
    const { result, err } = await run(undefined, {
      binaryPath: "/no/such/binary/harness-wrapper-test-missing",
      stdout: sink,
    })
    expect(isSentinel(err, ErrBinaryNotFound)).toBe(true)
    expect(result.status).toBe(StatusBinaryNotFound)
    expect(result.exitCode).toBe(-1)
    expect(result.reason).not.toBe("")
  })

  test("emits lifecycle trace events in order", async () => {
    const { sink, drain } = captureStdout()
    const emitter = new RecordingEmitter()
    const { result, err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "1", "--delay", "1ms"],
      stdout: sink,
      trace: emitter,
    })
    drain()
    expect(err).toBeNull()

    expect(emitter.kinds()).toEqual([
      "wrapper_started",
      "pty_opened",
      "pty_closed",
      "harness_exited",
    ])
    const started = emitter.events[0]!.fields!
    expect(started.binary_path).toBe(mockHarnessBin)
    expect("args" in started).toBe(true)
    expect(emitter.events[1]!.fields!.pid).toBe(result.pid)
    const exited = emitter.events[3]!.fields!
    expect(exited.status).toBe(StatusIdle)
    expect(exited.exit_code).toBe(0)
    expect(typeof exited.duration_ms).toBe("number")
  })

  test("idle classifier emits quiet and classify events", async () => {
    const { sink, drain } = captureStdout()
    const emitter = new RecordingEmitter()
    const { ctx, cancel } = Context.withDeadline(Context.background(), 1000)
    await run(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      trace: emitter,
      idleQuiet: 50,
      idleClassify: 200,
    })
    cancel()
    drain()
    expect(emitter.kinds()).toContain("output_quiet")
    expect(emitter.kinds()).toContain("output_classify_threshold")
  })

  test("idle classifier escalates a limit prompt to blocked_by_cost", async () => {
    const { sink, drain } = captureStdout()
    const emitter = new RecordingEmitter()
    const { ctx, cancel } = Context.withDeadline(Context.background(), 1000)
    const { result, err } = await run(ctx, {
      binaryPath: mockHarnessBin,
      args: [
        "--mode",
        "needs-input",
        "--prompt",
        "You've hit your limit - resets 5:50pm. What do you want to do? ",
      ],
      stdout: sink,
      trace: emitter,
      idleQuiet: 50,
      idleClassify: 200,
    })
    cancel()
    drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusBlockedByCost)
    expect(emitter.kinds()).toContain("harness_blocked_by_cost")
  })

  test("context cancel interrupts without propagating err", async () => {
    const { sink, drain } = captureStdout()
    const { ctx, cancel } = Context.withCancel(Context.background())
    const p = run(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      waitDelay: 500,
    })
    await new Promise((r) => setTimeout(r, 100))
    cancel()
    const { result, err } = await p
    drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusInterrupted)
    expect(result.reason).toContain("context cancelled")
  })

  test("context DEADLINE interrupts with a distinct 'deadline exceeded' reason", async () => {
    const { sink, drain } = captureStdout()
    // A deadline (ctxDeadlineExceeded) must be distinguishable from a plain
    // cancel so the orchestrator side can synthesize exit-124 only for a real timeout.
    const { ctx } = Context.withDeadline(Context.background(), 100)
    const { result, err } = await run(ctx, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "stuck"],
      stdout: sink,
      waitDelay: 500,
    })
    drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusInterrupted)
    expect(result.reason).toContain("context deadline exceeded")
    expect(result.reason).not.toContain("cancelled")
  })

  test("needs-input mode forwards stdin (delayed stream)", async () => {
    const { sink, drain } = captureStdout()
    const { PassThrough } = await import("node:stream")
    const stdin = new PassThrough()
    setTimeout(() => {
      stdin.write("y\n")
      stdin.end()
    }, 150)

    const { result, err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "needs-input", "--expected-input", "y"],
      stdin,
      stdout: sink,
    })
    const output = drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusIdle)
    expect(output).toContain("Approved. DONE")
  })

  test("cost-limited mode reports blocked_by_cost", async () => {
    const { sink, drain } = captureStdout()
    const { result, err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "cost-limited", "--exit-code", "3"],
      stdout: sink,
    })
    drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusBlockedByCost)
    expect(result.exitCode).toBe(3)
    expect(result.reason).toContain("quota exceeded")
  })

  test("nil trace uses discard (no throw)", async () => {
    const { sink, drain } = captureStdout()
    const { err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "completed", "--steps", "1", "--delay", "1ms"],
      stdout: sink,
    })
    drain()
    expect(err).toBeNull()
  })

  test("idleClassify < idleQuiet rejected", async () => {
    const { sink } = captureStdout()
    const { err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      stdout: sink,
      idleQuiet: 100,
      idleClassify: 10,
    })
    expect(isSentinel(err, ErrInvalidConfig)).toBe(true)
  })

  test("accepts string stdin + buffer stdout", async () => {
    const { sink, drain } = captureStdout()
    const { result, err } = await run(undefined, {
      binaryPath: mockHarnessBin,
      args: ["--mode", "needs-input", "--expected-input", "y"],
      stdin: "y\n",
      stdout: sink,
    })
    const output = drain()
    expect(err).toBeNull()
    expect(result.status).toBe(StatusIdle)
    expect(output).toContain("Approved. DONE")
  })
})
