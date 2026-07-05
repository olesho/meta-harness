// record-scenarios.ts — canonical claude-code corpus scenario driver.
//
// record-pty.ts (the single-prompt probe) cannot drive the checked-in corpus
// scenarios: multi-turn needs several prompt→completion cycles, tool-call needs
// a seeded working dir, and interrupted-mid-reply needs an ESC mid-stream. This
// driver replays those scenarios end-to-end against the live binary using the
// SAME primitives the probe uses (the Node PTY bridge, Screen, readyForInput)
// plus the production turns adapter as the per-turn completion predicate, and
// writes the corpus triple: bytes.raw, meta.json, expected.txt (final rendered
// screen, trailing blanks trimmed).
//
// Each run does a warmup pass first (accept the folder-trust dialog so it never
// pollutes the recording), then the recording pass. The recording is frozen at
// the final settled conversation frame — the trailing graceful /quit is NOT
// teed into bytes.raw, because at 2.1.201 /quit replaces the conversation with
// a goodbye/resume screen and the replay tests assert the adapter's verdict on
// the recording's final frame.
//
// Usage:
//   bun test/corpus/tools/record-scenarios.ts --scenario multi-turn \
//     --out test/corpus/claude-code/multi-turn [--bin claude] [--cwd <dir>]

import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { readyForInput } from "../../../src/chat/ready.ts"
import { Screen } from "../../../src/screen/index.ts"
import * as claudecode from "../../../src/turns/harness/claudecode.ts"
import { Errored, InputRequested, TurnComplete } from "../../../src/turns/index.ts"
import { PtyProcess, resolveBinary } from "../../../src/wrapper/internal/pty.ts"

const COLS = 120
const ROWS = 40
const HARNESS = "claude-code"

const enc = new TextEncoder()
const SUBMIT = enc.encode("\x1b[13u") // kitty-protocol Enter (see chat/ready.ts)
const ESC = enc.encode("\x1b")
const QUIT = enc.encode("/quit\x1b[13u")

const trustAnchors = [
  "Do you trust the files in this folder?",
  "Is this a project you created or one you trust?",
]
const busyMarker = "esc to interrupt"
const interruptedText = "Interrupted · What should Claude do instead?"

interface Scenario {
  prompts: string[]
  /** Interrupt the (single) prompt's reply with ESC once streaming is visible. */
  interrupt?: boolean
  notes: string
  setup?: (cwd: string) => void
}

const scenarios: Record<string, Scenario> = {
  "multi-turn": {
    prompts: [
      "what is the capital of France",
      "what is its population",
      "how does that compare to Berlin",
    ],
    notes: "three consecutive short prompts; each turn must settle before the next",
  },
  "tool-call": {
    prompts: ["Use the Read tool to read notes.txt and tell me exactly what it says"],
    setup: (cwd) =>
      writeFileSync(
        join(cwd, "notes.txt"),
        "The corpus fixture sentinel is: POMELO-CANYON-88\n",
      ),
    notes: "single turn that makes a Read tool call before answering",
  },
  "interrupted-mid-reply": {
    prompts: ["Write a detailed 500 word essay about the history of Paris"],
    interrupt: true,
    notes: "long reply interrupted with ESC mid-stream; must end errored, not complete",
  },
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** process.env minus the outer Claude Code session markers (mirrors cleanHarnessEnv). */
function cleanedEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue
    if (v !== undefined) out[k] = v
  }
  return out
}

interface Live {
  pty: PtyProcess
  screen: Screen
  exited: () => boolean
}

async function spawnLive(
  bin: string,
  cwd: string,
  onData?: (d: Uint8Array) => void,
): Promise<Live> {
  const screen = new Screen(COLS, ROWS)
  const pty = await PtyProcess.spawn({
    binaryPath: bin,
    args: [],
    cwd,
    env: cleanedEnv(),
    cols: COLS,
    rows: ROWS,
  })
  let exited = false
  pty.onExit(() => {
    exited = true
  })
  pty.onData((d) => {
    onData?.(d)
    void screen.write(d)
  })
  return { pty, screen, exited: () => exited }
}

/** Polls `cond` against the rendered screen until true, or throws at `timeoutMs`. */
async function waitFor(
  live: Live,
  what: string,
  cond: (text: string) => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond(live.screen.snapshot().text)) return
    if (live.exited()) throw new Error(`harness exited while waiting for ${what}`)
    await sleep(150)
  }
  throw new Error(
    `timeout waiting for ${what}; screen tail:\n` +
      live.screen.snapshot().text.trimEnd().split("\n").slice(-12).join("\n"),
  )
}

/**
 * Waits for readiness, accepting the folder-trust dialog (option 1) if it
 * blocks the way. Used by warmup (and defensively by the recording pass, where
 * the dialog should no longer appear).
 */
async function waitReady(live: Live, timeoutMs: number): Promise<void> {
  let trustAnswered = false
  await waitFor(
    live,
    "ready composer",
    (text) => {
      if (!trustAnswered && trustAnchors.some((a) => text.includes(a))) {
        live.pty.write(enc.encode("1"))
        trustAnswered = true
        return false
      }
      return readyForInput(HARNESS, text)
    },
    timeoutMs,
  )
}

/** Warmup pass: persist folder trust for `cwd` so the recording starts clean. */
async function warmup(bin: string, cwd: string): Promise<void> {
  const live = await spawnLive(bin, cwd)
  try {
    await waitReady(live, 60_000)
  } finally {
    live.pty.kill("SIGTERM")
    await sleep(400)
    live.pty.kill("SIGKILL")
  }
}

async function quitAndWaitExit(live: Live): Promise<void> {
  live.pty.write(QUIT)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !live.exited()) await sleep(150)
  if (!live.exited()) {
    console.error("[record-scenarios] /quit did not exit; killing")
    live.pty.kill("SIGTERM")
    await sleep(500)
    live.pty.kill("SIGKILL")
  }
  await sleep(300) // let the final output flush through the bridge
}

async function main(): Promise<void> {
  // --- args ---
  let scenarioName = ""
  let out = ""
  let bin = "claude"
  let cwd = ""
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`missing value for ${a}`)
      return v
    }
    if (a === "--scenario") scenarioName = next()
    else if (a === "--out") out = next()
    else if (a === "--bin") bin = next()
    else if (a === "--cwd") cwd = next()
    else throw new Error(`unknown flag: ${a}`)
  }
  const scenario = scenarios[scenarioName]
  if (!scenario) {
    throw new Error(
      `--scenario must be one of: ${Object.keys(scenarios).join(", ")} (got "${scenarioName}")`,
    )
  }
  if (!out) throw new Error("--out <dir> is required")
  if (!cwd) cwd = join(tmpdir(), "meta-harness-corpus-rec", scenarioName)
  mkdirSync(cwd, { recursive: true })
  mkdirSync(out, { recursive: true })

  const resolved = resolveBinary(bin)
  if (!resolved) throw new Error(`binary not found: ${bin}`)
  const rawVersion = execFileSync(resolved, ["--version"], { encoding: "utf8" }).trim()
  const binaryVersion = rawVersion.split(/\s+/)[0] ?? rawVersion

  scenario.setup?.(cwd)

  console.error(`[record-scenarios] warmup in ${cwd}`)
  await warmup(resolved, cwd)

  // --- recording pass ---
  const bytesPath = join(out, "bytes.raw")
  writeFileSync(bytesPath, new Uint8Array(0))
  const startedAt = new Date()
  let recording = true
  const live = await spawnLive(resolved, cwd, (d) => {
    if (recording) appendFileSync(bytesPath, d)
  })
  const adapter = claudecode.New()

  try {
    for (const [i, prompt] of scenario.prompts.entries()) {
      await waitReady(live, 90_000)
      console.error(`[record-scenarios] turn ${i + 1}: ${prompt}`)
      live.pty.write(enc.encode(prompt))
      await sleep(750)
      if (!live.screen.snapshot().text.includes(prompt)) {
        throw new Error(`prompt was not echoed into the composer: ${prompt}`)
      }
      live.pty.write(SUBMIT)

      if (scenario.interrupt && i === scenario.prompts.length - 1) {
        // ESC during the thinking phase (busy marker but no reply text yet)
        // just restores the prompt to the composer — no interrupt marker. Wait
        // until the ⏺ reply bullet is visibly streaming before interrupting.
        await waitFor(
          live,
          "streaming reply",
          (t) => t.includes(busyMarker) && t.includes("⏺"),
          120_000,
        )
        await sleep(1_500) // let a bit more of the reply render before interrupting
        console.error("[record-scenarios] sending ESC interrupt")
        live.pty.write(ESC)
        await waitFor(live, "interrupt marker", (t) => t.includes(interruptedText), 30_000)
      } else {
        // The production adapter is the completion predicate: poll until it
        // fires TurnComplete for this turn (fingerprinting keeps earlier turns
        // from re-firing). A dialog or interrupt here means the scenario went
        // sideways — fail loudly rather than record garbage.
        await waitFor(
          live,
          `turn ${i + 1} completion`,
          () => {
            const evs = adapter.onScreen(live.screen.snapshot())
            for (const ev of evs) {
              if (ev.kind === InputRequested || ev.kind === Errored) {
                throw new Error(`unexpected ${ev.kind} during turn ${i + 1}`)
              }
            }
            return evs.some((ev) => ev.kind === TurnComplete)
          },
          180_000,
        )
      }
    }

    await sleep(1_500) // settle so the final turn fully renders
  } catch (err) {
    live.pty.kill("SIGKILL")
    throw err
  }

  // Freeze the recording at the settled conversation frame, THEN quit: the
  // goodbye/resume screen /quit paints must not leak into bytes.raw.
  const finalText = live.screen.snapshot().text
  recording = false
  await quitAndWaitExit(live)
  writeFileSync(join(out, "expected.txt"), finalText.replace(/\s+$/u, "") + "\n")
  const meta = {
    harness: HARNESS,
    binary_version: binaryVersion,
    recorded_at: startedAt.toISOString(),
    cols: COLS,
    rows: ROWS,
    notes: `record-scenarios ${scenarioName}: ${scenario.notes}`,
  }
  writeFileSync(join(out, "meta.json"), JSON.stringify(meta, null, 2) + "\n")
  console.log(`recorded ${out} (${scenarioName}, binary ${binaryVersion})`)
  process.exit(0)
}

main().catch((err) => {
  console.error("[record-scenarios]", err)
  process.exit(1)
})
