#!/usr/bin/env node
// Scriptable stand-in for an interactive coding harness — the TS/Node port of
// cmd/fakeharness (Go). It is spawned by the chat package's PTY-driven
// integration tests over a real PTY, so replaying a script drives the genuine
// screen emulator, turn watcher, and idle-completion timers end to end.
//
// It reads a JSON script (path in $FAKEHARNESS_SCRIPT), switches its PTY slave
// to raw mode like a real TUI, and replays the script's timeline: paint frames
// on a delay, block until the wrapper types an expected byte sequence,
// optionally echo the captured prompt back. See fakeharness.ts for the script
// format and builder.

import { readFileSync, writeFileSync } from "node:fs"

const ENV_VAR = "FAKEHARNESS_SCRIPT"
// When set, the launch argv (minus node + this script) is written here as JSON
// so resume-injection tests can assert the harness received `--resume <uuid>`.
const ARGV_OUT_VAR = "FAKEHARNESS_ARGV_OUT"
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A byte accumulator over stdin that resolves once its buffer matches a RegExp.
// The PTY slave is in raw mode, so the match sees control bytes (the CSI-13u
// submit) directly, with no line buffering. Matching runs on a latin1 view so
// string index === byte index; the captured prefix is decoded as UTF-8.
function readUntil(re) {
  return new Promise((resolve) => {
    const chunks = []
    let acc = Buffer.alloc(0)
    const onData = (chunk) => {
      chunks.push(chunk)
      acc = Buffer.concat(chunks)
      const m = re.exec(acc.toString("latin1"))
      if (m) {
        process.stdin.off("data", onData)
        process.stdin.pause()
        resolve({ buf: acc, index: m.index })
      }
    }
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}

// Block forever (until the parent closes the PTY and kills us).
function holdUntilClosed() {
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.on("data", () => {})
    process.stdin.on("end", resolve)
    process.stdin.on("close", resolve)
  })
}

async function run() {
  const path = process.env[ENV_VAR]
  if (!path) throw new Error(`${ENV_VAR} not set`)
  const sc = JSON.parse(readFileSync(path, "utf8"))

  // Record the launch args (past `node fakeharness.mjs`) for resume tests.
  const argvOut = process.env[ARGV_OUT_VAR]
  if (argvOut) writeFileSync(argvOut, JSON.stringify(process.argv.slice(2)))

  // A real TUI switches its PTY slave to raw so it can read control bytes — the
  // CSI-13u submit carries no newline, so canonical mode would block forever —
  // and so keystrokes are not echoed onto the screen we paint. Mirror that.
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(true)
    } catch {
      /* best effort */
    }
  }

  let captured = ""
  for (const step of sc.steps ?? []) {
    if (step.frame) {
      const f = step.frame
      if (f.delay_ms > 0) await sleep(f.delay_ms)
      let body = f.screen
      if (f.echo) body = body.split("{{prompt}}").join(captured)
      // Raw mode disables ONLCR (LF→CRLF) post-processing, so emit CRLF
      // explicitly — without the CR, lines staircase and a wrapped line can
      // split a detection-critical string (e.g. the resume UUID) across rows.
      body = body.split("\n").join("\r\n")
      // Clear + home so each frame fully repaints; no stale footer bleeds into
      // a settled frame and fakes Busy(). NoClear frames append verbatim.
      if (!f.no_clear) body = "\x1b[2J\x1b[H" + body
      process.stdout.write(body)
    } else if (step.wait_input) {
      const wi = step.wait_input
      const re = new RegExp(wi.until_regex)
      const { buf, index } = await readUntil(re)
      if (wi.capture) captured = buf.subarray(0, index).toString("utf8")
    } else if (step.hold) {
      await holdUntilClosed()
      return
    } else if (step.exit) {
      process.exit(step.exit.code)
    }
  }

  // Stay alive after the timeline so the idle-completion watcher can confirm the
  // final turn while the process is still up — a real interactive harness sits
  // at its prompt waiting for the next message.
  await holdUntilClosed()
}

run().catch((err) => {
  process.stderr.write(`fakeharness: ${err?.stack ?? err}\n`)
  process.exit(1)
})
