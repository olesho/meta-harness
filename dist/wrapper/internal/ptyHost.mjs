#!/usr/bin/env node
// PTY host bridge.
//
// node-pty's native read loop does not run under Bun (onData never fires).
// This script runs under *Node*, owns the real PTY via node-pty, and proxies
// it to a Bun (or Node) parent over an ordinary stdio pipe, which Bun reads
// fine. The parent spawns `node ptyHost.mjs <specJSON>` as a normal child
// process; this script:
//
//   - spawns the harness under a real PTY,
//   - frames PTY output + lifecycle to its OWN stdout,
//   - reads control frames (stdin bytes, resize, kill) from its OWN stdin.
//
// Wire framing (both directions): a 5-byte header (1 type byte + uint32 BE
// payload length) followed by the payload bytes.
//
//   host -> parent:  'r' ready {pid}   'o' output bytes   'x' exit {exitCode,signal}
//   parent -> host:  'i' stdin bytes   'w' resize {cols,rows}   'k' kill {signal}

import pty from "node-pty"

const T_READY = "r".charCodeAt(0)
const T_OUTPUT = "o".charCodeAt(0)
const T_EXIT = "x".charCodeAt(0)
const T_STDIN = "i".charCodeAt(0)
const T_RESIZE = "w".charCodeAt(0)
const T_KILL = "k".charCodeAt(0)

function frame(type, payload) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload ?? "", "utf8")
  const head = Buffer.allocUnsafe(5)
  head[0] = type
  head.writeUInt32BE(body.length, 1)
  return Buffer.concat([head, body])
}

function send(type, payload) {
  process.stdout.write(frame(type, payload))
}

const spec = JSON.parse(process.argv[2] || "{}")

let proc
try {
  proc = pty.spawn(spec.binaryPath, spec.args ?? [], {
    name: "xterm-256color",
    cols: spec.cols ?? 80,
    rows: spec.rows ?? 24,
    cwd: spec.cwd || process.cwd(),
    env: spec.env ?? process.env,
  })
} catch (err) {
  send(T_EXIT, JSON.stringify({ exitCode: -1, signal: 0, error: String(err) }))
  process.exit(0)
}

send(T_READY, JSON.stringify({ pid: proc.pid }))

proc.onData((d) => send(T_OUTPUT, Buffer.from(d, "utf8")))

let exited = false
proc.onExit(({ exitCode, signal }) => {
  if (exited) return
  exited = true
  send(T_EXIT, JSON.stringify({ exitCode, signal: signal ?? 0 }))
  // Give the pipe a tick to flush before tearing down.
  setTimeout(() => process.exit(0), 10)
})

// Decode control frames arriving on our stdin.
let buf = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk])
  for (;;) {
    if (buf.length < 5) break
    const type = buf[0]
    const len = buf.readUInt32BE(1)
    if (buf.length < 5 + len) break
    const payload = buf.subarray(5, 5 + len)
    buf = buf.subarray(5 + len)
    handleControl(type, payload)
  }
})

function handleControl(type, payload) {
  if (exited) return
  switch (type) {
    case T_STDIN:
      proc.write(payload.toString("utf8"))
      break
    case T_RESIZE: {
      const { cols, rows } = JSON.parse(payload.toString("utf8"))
      try {
        proc.resize(cols, rows)
      } catch {
        /* terminal teardown races; ignore */
      }
      break
    }
    case T_KILL: {
      const { signal } = JSON.parse(payload.toString("utf8"))
      try {
        proc.kill(signal)
      } catch {
        /* already gone */
      }
      break
    }
  }
}

// If the parent closes our stdin, treat it as a teardown request.
process.stdin.on("end", () => {
  if (!exited) {
    try {
      proc.kill("SIGTERM")
    } catch {
      /* already gone */
    }
  }
})
