// META-HARNESS-34: the PTY bridge must resolve a real `node` interpreter even
// when the gate shell has none on PATH. These cover resolveNode() (the spawn-time
// resolver) and findNode() (the strict, null-on-miss variant the test preload
// uses) plus the ENOENT → ErrNodeNotFound mapping guard.

import { afterEach, describe, expect, test } from "vitest"
import { spawn } from "node:child_process"

import {
  ErrNodeNotFound,
  ErrPTYAllocation,
  findNode,
  PtyProcess,
  resolveNode,
} from "../../src/wrapper/internal/pty.ts"
import { isSentinel } from "../../src/internal/async/errors.ts"

const KEY = "META_HARNESS_NODE"
const original = process.env[KEY]
afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

describe("resolveNode", () => {
  test("honors META_HARNESS_NODE verbatim", () => {
    process.env[KEY] = "/custom/bin/node"
    expect(resolveNode()).toBe("/custom/bin/node")
  })

  test("honors META_HARNESS_NODE from an explicit env arg over process.env", () => {
    delete process.env[KEY]
    expect(resolveNode({ META_HARNESS_NODE: "/from/arg/node" })).toBe("/from/arg/node")
  })

  test("ignores a blank override", () => {
    process.env[KEY] = "   "
    // Under Node this is process.execPath; under Bun it's a resolved node path.
    // Either way it must not be the blank override.
    expect(resolveNode().trim()).not.toBe("")
  })

  test("under Node, reuses process.execPath when no override is set", () => {
    delete process.env[KEY]
    if (process.versions.bun) return // production-path assertion only holds on Node
    expect(resolveNode()).toBe(process.execPath)
  })

  test("always returns a non-empty interpreter string", () => {
    delete process.env[KEY]
    expect(resolveNode().length).toBeGreaterThan(0)
  })
})

describe("findNode", () => {
  test("resolves a real, executable node in this environment", () => {
    delete process.env[KEY]
    const node = findNode()
    // The test suite itself runs under an interpreter, and the ensure-node-on-path
    // preload guarantees one on PATH — so a real node must resolve here.
    expect(node).not.toBeNull()
    expect(node as string).toContain("node")
  })

  test("returns the override when it is executable", () => {
    // process.execPath is guaranteed executable; use it as a stand-in node.
    process.env[KEY] = process.execPath
    expect(findNode()).toBe(process.execPath)
  })

  test("returns null when the override points at a non-existent file", () => {
    process.env[KEY] = "/nonexistent/definitely/not/node"
    expect(findNode()).toBeNull()
  })
})

describe("bridge spawn ENOENT → ErrNodeNotFound", () => {
  test("a missing interpreter surfaces as ErrNodeNotFound, not ErrPTYAllocation", async () => {
    // Pin the bridge interpreter to a path that cannot be spawned so the child
    // emits ENOENT — the exact failure mode of an nvm-less gate shell.
    process.env[KEY] = "/nonexistent/definitely/not/node"
    let err: unknown
    try {
      await PtyProcess.spawn({ binaryPath: "/bin/true", args: [] })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    expect(isSentinel(err, ErrNodeNotFound)).toBe(true)
    expect(isSentinel(err, ErrPTYAllocation)).toBe(false)
  })

  test("spawn ENOENT reproduces the classifier signal directly", async () => {
    // Sanity: spawning a missing binary really does raise a code:"ENOENT" error,
    // the condition the bridge maps to ErrNodeNotFound.
    const code = await new Promise<string | undefined>((resolve) => {
      const child = spawn("/nonexistent/definitely/not/node", [])
      child.on("error", (e: NodeJS.ErrnoException) => resolve(e.code))
      child.on("exit", () => resolve(undefined))
    })
    expect(code).toBe("ENOENT")
  })
})
