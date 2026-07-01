// The scriptable fake harness — the TS port of internal/fakeharness (Go). A test
// builds a Script with the fluent Builder, marshals it to JSON, and points the
// runnable (fakeharness.mjs) at it via the FAKEHARNESS_SCRIPT env var. The
// runnable is spawned by chat.Open over a REAL pty, so replaying a script drives
// the genuine screen emulator, turn watcher, and idle-completion timers end to
// end — the timing-sensitive completion path unit tests calling maybeIdleComplete
// directly cannot reach.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Open, type Conversation, type Turn } from "../../src/chat/index.ts"
import {
  EventTurn,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
} from "../../src/chat/index.ts"
import { newMemStore } from "../../src/chat/index.ts"
import { Context } from "../../src/internal/async/index.ts"

const here = dirname(fileURLToPath(import.meta.url))

/** Env var the runnable reads the script-file path from. */
export const EnvVar = "FAKEHARNESS_SCRIPT"

/** Absolute path to the executable fake-harness runnable (node shebang). */
export const fakeHarnessBin: string = join(here, "fakeharness.mjs")

// Belt-and-suspenders: ensure the executable bit survives a fresh checkout.
try {
  chmodSync(fakeHarnessBin, 0o755)
} catch {
  /* best effort */
}

/**
 * SubmitCSI13u — the bytes chat.Send writes to submit a turn for claude-code and
 * codex: CSI 13 u, unmodified Enter in the kitty keyboard protocol those TUIs
 * enable. Scenarios wait for it via AwaitSubmit, pinning the submit contract.
 */
export const SubmitCSI13u = "\x1b[13u"

/** SubmitCR — the byte chat.Send writes to submit a turn for pi: a bare CR. */
export const SubmitCR = "\r"

const promptPlaceholder = "{{prompt}}"

/** PromptRef returns the placeholder a scenario embeds to have the captured prompt substituted. */
export function PromptRef(): string {
  return promptPlaceholder
}

export interface Frame {
  delay_ms: number
  screen: string
  echo?: boolean
  no_clear?: boolean
}
export interface WaitInput {
  until_regex: string
  capture?: boolean
  label?: string
}
export interface Exit {
  code: number
}
export type Hold = Record<string, never>

export interface Step {
  frame?: Frame
  wait_input?: WaitInput
  hold?: Hold
  exit?: Exit
}

export interface Script {
  harness: string
  session_id?: string
  steps: Step[]
}

const defaultSessionID = "11111111-2222-3333-4444-555555555555"

// Escape a literal string into a JS-regex-safe pattern (the JS analogue of Go's
// regexp.QuoteMeta). The ESC byte in SubmitCSI13u stays literal and matches the
// raw control byte in the accumulated latin1 view.
function quoteMeta(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const ccHeader = "Claude Code"
const ccPrompt = "❯ "
const ccBusy = "  ⏵⏵ esc to interrupt"
const ccSpinner = "✶ Cerebrating… (3s · ↓ 1.2k tokens)"
const codexPrompt = "› "
const piStatus =
  "↑1.2k ↓32 $0.000 0.9%/131k (auto)                      gpt-oss-120b • medium"
const piRule = "────────────────────────────────────────"
const piSpinner = " ⠧ Working..."

/**
 * Builder assembles a Script with harness-appropriate screen frames. The
 * semantic methods stamp the exact glyphs the corresponding adapter keys off of,
 * kept in one place so a future TUI drift updates fixtures and patterns together.
 */
export class Builder {
  private s: Script

  constructor(harness: string) {
    this.s = { harness, session_id: defaultSessionID, steps: [] }
  }

  /** Overrides the session UUID emitted in the resume hint. */
  Session(id: string): this {
    this.s.session_id = id
    return this
  }

  /** Returns the assembled Script. */
  Build(): Script {
    return this.s
  }

  get harness(): string {
    return this.s.harness
  }

  private frame(delayMs: number, screen: string, echo: boolean): this {
    this.s.steps.push({ frame: { delay_ms: delayMs, screen, echo } })
    return this
  }

  private waitInput(re: string, capture: boolean, label: string): this {
    this.s.steps.push({ wait_input: { until_regex: re, capture, label } })
    return this
  }

  /** Appends a step that terminates the fake with the given code. */
  Exit(code: number): this {
    this.s.steps.push({ exit: { code } })
    return this
  }

  /** Blocks until the wrapper submits a turn (CSI 13u) and captures the prompt. */
  AwaitSubmit(): this {
    return this.waitInput(quoteMeta(SubmitCSI13u), true, "submit")
  }

  /** Blocks until the wrapper selects a menu row (a digit followed by CR). */
  AwaitMenuChoice(): this {
    return this.waitInput("[0-9]\\r", false, "menu-choice")
  }

  /** Blocks until the wrapper submits a turn with a bare CR (pi's submit key). */
  AwaitSubmitCR(): this {
    return this.waitInput(quoteMeta(SubmitCR), true, "submit-cr")
  }

  private ccScreen(...lines: string[]): string {
    return lines.join("\n") + "\n"
  }

  private resumeHint(): string {
    if (this.s.harness === "codex") return "  codex resume " + this.s.session_id
    return "  claude --resume " + this.s.session_id
  }

  /** Paints the startup composer: ready for input, not busy. MUST be first. */
  Idle(): this {
    if (this.s.harness === "codex") {
      return this.frame(0, this.ccScreen("Codex", "", "› ", "", this.resumeHint()), false)
    }
    return this.frame(0, this.ccScreen(ccHeader, "", ccPrompt, "", this.resumeHint()), false)
  }

  /** Paints an in-flight frame: spinner + "esc to interrupt" footer (Busy). */
  Working(delayMs: number, status: string): this {
    const spinner = ccSpinner.replace("Cerebrating", status)
    return this.frame(delayMs, this.ccScreen(ccHeader, "", spinner, "", ccPrompt, ccBusy), false)
  }

  /** Paints an intermediate end-of-turn summary while STILL busy (must defer). */
  Marker(delayMs: number, verb: string, dur: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(ccHeader, "", "✻ " + verb + " for " + dur, ccSpinner, "", ccPrompt, ccBusy),
      false,
    )
  }

  /** Paints the danger frame: footer + spinner absent for one redraw (Busy false). */
  Flicker(delayMs: number, note: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(ccHeader, "", "⏺ " + note, "  running Explore sub-agent", "", ccPrompt),
      false,
    )
  }

  /** The exact trigger for the 3eda8a8 bug: a marker on a flickered-off frame. */
  MarkerFlicker(delayMs: number, verb: string, dur: string, note: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        ccHeader,
        "",
        "✻ " + verb + " for " + dur,
        "⏺ " + note,
        "  running Explore sub-agent",
        "",
        ccPrompt,
      ),
      false,
    )
  }

  /** Paints the genuine end-of-turn frame: bullet, FINAL marker, settled, not busy. */
  Reply(delayMs: number, body: string, verb: string, dur: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        ccHeader,
        "",
        "⏺ " + body,
        "",
        "✻ " + verb + " for " + dur,
        "",
        ccPrompt,
        this.resumeHint(),
      ),
      true,
    )
  }

  /** Paints a settled, ready, non-busy frame with a reply bullet but NO marker. */
  SettleIdle(delayMs: number, body: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(ccHeader, "", "⏺ " + body, "", ccPrompt, this.resumeHint()),
      true,
    )
  }

  // --- codex vocabulary ---

  /** Paints an in-flight codex frame: status, no prompt, no Token-usage footer. */
  CodexWorking(delayMs: number, status: string): this {
    return this.frame(delayMs, this.ccScreen("Codex", "", "• " + status + "…", ""), false)
  }

  /** Paints the end-of-turn codex frame with a fresh Token-usage footer. */
  CodexReply(delayMs: number, body: string): this {
    const n = this.s.steps.length + 1
    const tokenUsage = `Token usage: total=${1000 * n} input=${800 * n} (+ 0 cached) output=${200 * n}`
    return this.frame(
      delayMs,
      this.ccScreen("Codex", "", body, "", tokenUsage, "", codexPrompt, this.resumeHint()),
      true,
    )
  }

  // --- pi vocabulary ---

  private frameLines(...lines: string[]): string {
    return lines.join("\n") + "\n"
  }

  /** Paints pi's idle composer: context-usage status up, no spinner. MUST be first. */
  PiIdle(): this {
    return this.frame(0, this.frameLines(piRule, "", piRule, "~/proj (main)", piStatus), false)
  }

  /** Paints an in-flight pi frame: the "Working..." spinner makes pi.Busy true. */
  PiWorking(delayMs: number): this {
    return this.frame(delayMs, this.frameLines(piSpinner, "", piRule, "", piRule, piStatus), false)
  }

  /** Paints the settled end-of-turn pi frame: reply body + idle status, no spinner. */
  PiReply(delayMs: number, body: string): this {
    return this.frame(
      delayMs,
      this.frameLines(body, "", piRule, "", piRule, "~/proj (main)", piStatus),
      true,
    )
  }

  // --- raw output & lifecycle ---

  /** Emits text verbatim (trailing newline, no clear/home) for the line classifier. */
  Raw(delayMs: number, text: string): this {
    this.s.steps.push({ frame: { delay_ms: delayMs, screen: text + "\n", echo: true, no_clear: true } })
    return this
  }

  /** Holds at the prompt after the timeline until the wrapper terminates it. */
  StayAliveUntilStopped(): this {
    this.s.steps.push({ hold: {} })
    return this
  }
}

/** New starts a Builder for the named harness with the default session ID. */
export function New(harness: string): Builder {
  return new Builder(harness)
}

// Shrunk completion windows so PTY-driven tests run in ~1s instead of ~10s. The
// invariant under test (a flicker must not complete; only a settled prompt may)
// holds at any scale, as long as fixture frame delays stay below markerGap.
export const testIdleGap = 500
export const testMarkerGap = 120

/**
 * openFake spawns the fake harness driving the given script and returns an open
 * Conversation. The script is delivered via a temp file referenced by the
 * FAKEHARNESS_SCRIPT env var; env is the full environment so the child keeps
 * PATH/TERM (and can resolve the node shebang).
 */
export async function openFake(script: Script): Promise<Conversation> {
  const dir = mkdtempSync(join(tmpdir(), "fakeharness-script-"))
  const scriptPath = join(dir, "script.json")
  writeFileSync(scriptPath, JSON.stringify(script), { mode: 0o600 })

  const env = [
    ...Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`),
    `${EnvVar}=${scriptPath}`,
  ]

  return Open(undefined, {
    harness: script.harness,
    binaryPath: fakeHarnessBin,
    env,
    store: newMemStore(),
    cols: 120,
    rows: 40,
    idleGap: testIdleGap,
    markerGap: testMarkerGap,
  })
}

/**
 * sendOneTurn acquires control, sends text, and releases control after the send
 * returns (the in-flight turn continues independently).
 */
export async function sendOneTurn(conv: Conversation, text: string): Promise<void> {
  const ctx = Context.background()
  const release = await conv.acquireControl(ctx)
  try {
    await conv.send(ctx, text)
  } finally {
    release()
  }
}

/**
 * waitForTerminalTurn drains conversation events until an assistant turn reaches
 * a terminal state (complete or errored), or the timeout fires.
 */
export async function waitForTerminalTurn(conv: Conversation, timeoutMs: number): Promise<Turn> {
  const bus = conv.events()
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms waiting for a terminal assistant turn`)), timeoutMs),
  )
  for (;;) {
    const next = (async () => {
      const { value, ok } = await bus.receive()
      if (!ok) throw new Error("event channel closed before a terminal turn")
      return value!
    })()
    const ev = await Promise.race([next, deadline])
    if (
      ev.type === EventTurn &&
      ev.turn?.role === RoleAssistant &&
      (ev.turn.state === TurnStateComplete || ev.turn.state === TurnStateErrored)
    ) {
      return ev.turn
    }
  }
}
