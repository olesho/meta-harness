// record-pty.ts — corpus capture tool for live harness sessions.
//
// Spawns a harness binary under the same Node PTY bridge the wrapper uses in
// production (src/wrapper/internal/pty.ts — node-pty's data stream is dead
// under Bun, so the bridge is the one PTY layer known to work here), tees every
// raw output byte to bytes.raw, logs every stdin write with a timestamp to
// stdin.log, and writes meta.json with the binary version from `<bin> --version`.
//
// Two modes:
//
//   probe (default) — replay the chat layer's send sequence against the live
//     binary: wait until readyForInput(harness, screen) fires (the SAME
//     predicate Conversation.send uses), dump the ready screen, write the
//     prompt, dump the typed screen, write the submit key, then record until
//     assistant output appears (or --max elapses) and dump the final screen.
//
//   --interactive — wire the invoking terminal's stdin straight through to the
//     harness PTY (raw mode) so a human session can be captured as ground
//     truth. Every keystroke lands in stdin.log. Detach with Ctrl-] (0x1d).
//
// Usage:
//   bun test/corpus/tools/record-pty.ts --out <dir> [--bin claude] [--harness claude-code]
//     [--cols 120] [--rows 40] [--prompt "text"] [--submit csi13u|cr|lf|none]
//     [--ready-timeout 45000] [--settle 750] [--max 90000] [--notes "..."]
//     [--no-ready-wait] [--interactive] [-- <extra harness args>]

import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { readyForInput } from "../../../src/chat/ready.ts"
import { Screen } from "../../../src/screen/index.ts"
import { PtyProcess, resolveBinary } from "../../../src/wrapper/internal/pty.ts"

interface Opts {
  out: string
  bin: string
  harness: string
  cols: number
  rows: number
  prompt: string
  submit: string
  readyTimeoutMs: number
  settleMs: number
  maxMs: number
  notes: string
  interactive: boolean
  noReadyWait: boolean
  extraArgs: string[]
}

function parseArgs(argv: string[]): Opts {
  const o: Opts = {
    out: "",
    bin: "claude",
    harness: "claude-code",
    cols: 120,
    rows: 40,
    prompt: "what is the capital of France",
    submit: "csi13u",
    readyTimeoutMs: 45_000,
    settleMs: 750,
    maxMs: 90_000,
    notes: "",
    interactive: false,
    noReadyWait: false,
    extraArgs: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    switch (a) {
      case "--out":
        o.out = next()
        break
      case "--bin":
        o.bin = next()
        break
      case "--harness":
        o.harness = next()
        break
      case "--cols":
        o.cols = Number(next())
        break
      case "--rows":
        o.rows = Number(next())
        break
      case "--prompt":
        o.prompt = next()
        break
      case "--submit":
        o.submit = next()
        break
      case "--ready-timeout":
        o.readyTimeoutMs = Number(next())
        break
      case "--settle":
        o.settleMs = Number(next())
        break
      case "--max":
        o.maxMs = Number(next())
        break
      case "--notes":
        o.notes = next()
        break
      case "--interactive":
        o.interactive = true
        break
      case "--no-ready-wait":
        o.noReadyWait = true
        break
      case "--":
        o.extraArgs = argv.slice(i + 1)
        i = argv.length
        break
      default:
        throw new Error(`unknown flag: ${a}`)
    }
  }
  if (!o.out) throw new Error("--out <dir> is required")
  return o
}

const submitKeys: Record<string, Uint8Array> = {
  csi13u: new TextEncoder().encode("\x1b[13u"),
  cr: new TextEncoder().encode("\r"),
  lf: new TextEncoder().encode("\n"),
  none: new Uint8Array(0),
}

/** Render bytes as a printable escape string for stdin.log ("\x1b[13u" etc.). */
function printable(data: Uint8Array): string {
  let out = ""
  for (const b of data) {
    if (b === 0x1b) out += "\\x1b"
    else if (b === 0x0d) out += "\\r"
    else if (b === 0x0a) out += "\\n"
    else if (b === 0x09) out += "\\t"
    else if (b < 0x20 || b === 0x7f) out += "\\x" + b.toString(16).padStart(2, "0")
    else out += String.fromCharCode(b)
  }
  return out
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2))
  const submitKey = submitKeys[o.submit]
  if (submitKey === undefined) throw new Error(`unknown --submit: ${o.submit}`)

  const resolved = resolveBinary(o.bin)
  if (!resolved) throw new Error(`binary not found: ${o.bin}`)

  let binaryVersion = "unknown"
  try {
    // e.g. "2.1.201 (Claude Code)" — keep the leading version token.
    const raw = execFileSync(resolved, ["--version"], { encoding: "utf8" }).trim()
    binaryVersion = raw.split(/\s+/)[0] ?? raw
  } catch {
    /* leave "unknown" */
  }

  mkdirSync(o.out, { recursive: true })
  const bytesPath = join(o.out, "bytes.raw")
  const stdinLogPath = join(o.out, "stdin.log")
  writeFileSync(bytesPath, new Uint8Array(0))
  writeFileSync(stdinLogPath, "")

  const startedAt = Date.now()
  const stamp = () => ((Date.now() - startedAt) / 1000).toFixed(3).padStart(8)

  const screen = new Screen(o.cols, o.rows)
  const pty = await PtyProcess.spawn({
    binaryPath: resolved,
    args: o.extraArgs,
    cols: o.cols,
    rows: o.rows,
  })

  let exited = false
  let exitInfo = { exitCode: -1, signal: 0 }
  pty.onExit((e) => {
    exited = true
    exitInfo = e
  })
  pty.onData((d) => {
    appendFileSync(bytesPath, d)
    void screen.write(d)
  })

  const writeStdin = (data: Uint8Array, label: string) => {
    appendFileSync(stdinLogPath, `${stamp()}s  ${label.padEnd(10)} ${printable(data)}\n`)
    pty.write(data)
  }
  const dumpScreen = (name: string) => {
    writeFileSync(join(o.out, name), screen.snapshot().text)
  }

  const meta: Record<string, unknown> = {
    harness: o.harness,
    binary_version: binaryVersion,
    recorded_at: new Date(startedAt).toISOString(),
    cols: o.cols,
    rows: o.rows,
    notes: o.notes || `record-pty ${o.interactive ? "interactive" : "probe"} capture`,
  }

  const finish = (outcome: string) => {
    meta.outcome = outcome
    if (exited) meta.exit = exitInfo
    writeFileSync(join(o.out, "meta.json"), JSON.stringify(meta, null, 2) + "\n")
    dumpScreen("screen-final.txt")
    console.log(`recorded ${o.out} (${outcome}, binary ${binaryVersion})`)
  }

  if (o.interactive) {
    meta.mode = "interactive"
    process.stdin.setRawMode?.(true)
    process.stdin.resume()
    process.stdin.on("data", (chunk: Buffer) => {
      if (chunk.includes(0x1d)) {
        // Ctrl-] — detach and finalize.
        process.stdin.setRawMode?.(false)
        process.stdin.pause()
        finish("interactive-detached")
        pty.kill("SIGTERM")
        setTimeout(() => process.exit(0), 300)
        return
      }
      writeStdin(new Uint8Array(chunk), "keys")
    })
    pty.onData((d) => {
      appendFileSync(bytesPath, d)
      void screen.write(d)
      process.stdout.write(d)
    })
    pty.onExit((e) => {
      exited = true
      exitInfo = e
      process.stdin.setRawMode?.(false)
      finish("harness-exited")
      process.exit(0)
    })
    console.error(`[record-pty] interactive; Ctrl-] to detach. Recording to ${o.out}`)
    return
  }

  meta.mode = "probe"
  meta.prompt = o.prompt
  meta.submit = o.submit

  // Phase 1 — wait for readiness (the production predicate), or --no-ready-wait
  // to probe the "write immediately" failure mode.
  let readyAtMs = -1
  if (!o.noReadyWait) {
    const deadline = startedAt + o.readyTimeoutMs
    while (Date.now() < deadline && !exited) {
      if (readyForInput(o.harness, screen.snapshot().text)) {
        readyAtMs = Date.now() - startedAt
        break
      }
      await sleep(100)
    }
    if (readyAtMs < 0) {
      meta.ready_at_ms = null
      finish(exited ? "harness-exited-before-ready" : "ready-timeout")
      pty.kill("SIGKILL")
      process.exit(1)
    }
    meta.ready_at_ms = readyAtMs
  }
  dumpScreen("screen-ready.txt")

  // Phase 2 — write the prompt, let the TUI echo it, snapshot.
  writeStdin(new TextEncoder().encode(o.prompt), "prompt")
  await sleep(o.settleMs)
  dumpScreen("screen-typed.txt")
  meta.prompt_echoed = screen.snapshot().text.includes(o.prompt)

  // Phase 3 — submit, then wait for assistant output ("⏺") or the deadline.
  if (submitKey.length > 0) writeStdin(submitKey, "submit")
  const deadline = startedAt + o.maxMs
  let submitted = false
  while (Date.now() < deadline && !exited) {
    const text = screen.snapshot().text
    if (text.includes("⏺")) {
      submitted = true
      break
    }
    await sleep(200)
  }
  meta.assistant_output_seen = submitted
  if (submitted) await sleep(2000) // let the reply render into the recording
  finish(submitted ? "submitted" : "no-assistant-output")
  pty.kill("SIGTERM")
  await sleep(300)
  pty.kill("SIGKILL")
  process.exit(submitted || submitKey.length === 0 ? 0 : 2)
}

main().catch((err) => {
  console.error("[record-pty]", err)
  process.exit(1)
})
