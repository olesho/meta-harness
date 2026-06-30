#!/usr/bin/env node
// Mock CLI harness for wrapper tests. A faithful port of
// test/fakeharness/mock/main.go: behaves like an interactive agent CLI —
// prints a banner, performs a configurable behavior selected by --mode, and
// exits with a predictable code.
//
// Modes: completed | failed | stuck | needs-input | trust | emit |
//        cost-limited | api-error
//
// Spawned as a subprocess under a real PTY by the wrapper tests.

import { readFileSync } from "node:fs"

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        out[key] = "true"
      } else {
        out[key] = next
        i++
      }
    }
  }
  return out
}

// parseDuration → milliseconds. Accepts "1ms", "50ms", "2s", "500ms".
function parseDuration(s, def) {
  if (s === undefined) return def
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(s.trim())
  if (!m) return def
  const n = parseFloat(m[1])
  switch (m[2]) {
    case "s":
      return n * 1000
    case "m":
      return n * 60000
    default:
      return n
  }
}

const out = (s) => process.stdout.write(s)
const outln = (s = "") => process.stdout.write(s + "\n")
const errln = (s = "") => process.stderr.write(s + "\n")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Read a single '\n'-terminated line from stdin (trailing CR/LF trimmed).
function readLine() {
  return new Promise((resolve) => {
    let buf = ""
    const onData = (chunk) => {
      buf += chunk.toString("utf8")
      const i = buf.indexOf("\n")
      if (i >= 0) {
        process.stdin.off("data", onData)
        process.stdin.pause()
        resolve(buf.slice(0, i).replace(/\r$/, ""))
      }
    }
    process.stdin.resume()
    process.stdin.on("data", onData)
  })
}

function installSignalCleanup() {
  const handler = () => {
    outln("Mock interrupted.")
    process.exit(130)
  }
  process.on("SIGTERM", handler)
  process.on("SIGINT", handler)
}

async function runCompleted(steps, delay) {
  for (let i = 1; i <= steps; i++) {
    outln(`Step ${i}/${steps}`)
    await sleep(delay)
  }
  outln("DONE")
}

async function runNeedsInput(prompt, expected) {
  outln("Need approval to continue.")
  out(prompt)
  const line = await readLine()
  if (line === expected) {
    outln("Approved. DONE")
    return
  }
  errln("Rejected.")
  process.exit(2)
}

async function runTrust() {
  outln("Do you trust the files in this folder?")
  outln("")
  outln("❯ 1. Yes, proceed")
  outln("  2. No, exit")

  const choice = await readLine()
  if (choice !== "1") {
    errln("Trust declined.")
    process.exit(2)
  }
  out("\x1b[2J\x1b[H")
  outln("Claude Code")
  outln("❯")
  const line = await readLine()
  outln(`assistant reply: ${line}`)
  outln("✻ Baked for 1s")
  await sleep(200)
}

async function runAPIError(msg, repeat, repeatGap, recover, heartbeat, steps, delay) {
  if (repeat < 1) repeat = 1
  for (let i = 0; i < repeat; i++) {
    if (i > 0) await sleep(repeatGap)
    outln(msg)
  }
  if (recover) {
    await sleep(500)
    await runCompleted(steps, delay)
    return
  }
  // Heartbeat: keep the PTY active without recognizable content.
  for (;;) {
    await sleep(heartbeat)
    out(".")
  }
}

function runEmit(path) {
  if (!path) {
    errln("emit mode requires --emit-file")
    process.exit(2)
  }
  let data
  try {
    data = readFileSync(path)
  } catch (e) {
    errln(`emit: ${e}`)
    process.exit(2)
  }
  process.stdout.write(data)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const mode = args["mode"] ?? "completed"
  const delay = parseDuration(args["delay"], 50)
  const exitCode = parseInt(args["exit-code"] ?? "1", 10)
  const steps = parseInt(args["steps"] ?? "3", 10)
  const prompt = args["prompt"] ?? "Continue? [y/N] "
  const expected = args["expected-input"] ?? "y"
  const apiErrorMsg = args["api-error-msg"] ?? "API Error: 529 Overloaded."
  const apiErrorRepeat = parseInt(args["api-error-repeat"] ?? "1", 10)
  const apiErrorRepeatGap = parseDuration(args["api-error-repeat-gap"], 100)
  const apiErrorRecover = args["api-error-recover"] === "true"
  const apiErrorHeartbeat = parseDuration(args["api-error-heartbeat"], 200)
  const readyPrompt = args["ready-prompt"] === "true"
  const failedMsg = args["failed-msg"] ?? "Fatal: workspace is not writable."
  const emitFile = args["emit-file"] ?? ""

  installSignalCleanup()

  outln("Mock Agent CLI")

  if (readyPrompt) {
    outln("Claude Code")
    outln("❯")
    await readLine()
  }

  switch (mode) {
    case "completed":
      await runCompleted(steps, delay)
      break
    case "failed":
      errln(failedMsg)
      process.exit(exitCode)
      break
    case "stuck":
      outln("Thinking...")
      process.stdin.resume()
      await new Promise(() => {})
      break
    case "needs-input":
      await runNeedsInput(prompt, expected)
      break
    case "trust":
      await runTrust()
      break
    case "emit":
      runEmit(emitFile)
      break
    case "cost-limited":
      errln("ERROR: quota exceeded. Please try again after your usage limit resets.")
      process.exit(exitCode)
      break
    case "api-error":
      await runAPIError(
        apiErrorMsg,
        apiErrorRepeat,
        apiErrorRepeatGap,
        apiErrorRecover,
        apiErrorHeartbeat,
        steps,
        delay,
      )
      break
    default:
      errln(`unknown mode "${mode}"`)
      process.exit(2)
  }
}

main()
