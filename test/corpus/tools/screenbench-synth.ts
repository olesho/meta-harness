// screenbench-synth.ts — deterministic synthetic bake-off corpus generator.
//
// Port of the Go `internal/screenbench/cmd/screenbench-synth/main.go` generator.
// The Go source was never checked into meta-harness; only its OUTPUT (the
// test/corpus/synth/* fixtures) is present. This tool reconstructs a
// deterministic generator that regenerates those fixtures byte-for-byte.
//
// CORE DESIGN — oracle independence:
//   Each scenario is defined by ONE abstract model (a sequence of prompt lines,
//   styled assistant runs, an interrupt/erase, an alt-screen toggle, or a burst
//   of scrollback). From that single model the generator emits TWO artifacts
//   INDEPENDENTLY:
//     - bytes.raw     — the SGR/CSI-laden PTY byte stream, synthesized purely
//                       from the model (no PTY spawn, no randomness, no clock).
//     - expected.txt  — the intended final visible screen text, computed FROM
//                       THE MODEL (line layout + trailing-24 crop), NEVER by
//                       replaying bytes.raw through the Screen emulator. Doing
//                       that would make the downstream fidelity bench
//                       tautological (Screen output vs Screen output).
//   expected.txt lines carry NO trailing whitespace (the Go oracle rtrimmed
//   every emitted line).
//
// DETERMINISM — byte-for-byte regeneration is a hard gate:
//   - bytes.raw:    pure deterministic synthesis from the model.
//   - meta.json:    JSON.stringify(meta, null, 2) with NOTHING appended (the Go
//                   tool ends the file at `\n}` — no trailing newline, unlike
//                   the MH recorders which append "\n"). recorded_at is a PINNED
//                   per-scenario constant; never Date.now().
//   - expected.txt: the oracle's deterministic text output.
//
// Usage:
//   bun test/corpus/tools/screenbench-synth.ts                  # write in place
//   bun test/corpus/tools/screenbench-synth.ts --out <dir>      # write elsewhere
//   bun test/corpus/tools/screenbench-synth.ts --check          # diff vs fixtures
//   bun test/corpus/tools/screenbench-synth.ts --check --out <dir>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const COLS = 80
const ROWS = 24
const HARNESS = "synth"
const BINARY_VERSION = "screenbench-synth"

// ── SGR / CSI byte primitives ────────────────────────────────────────────────
const CSI = "\x1b["
const CLEAR_HOME = `${CSI}2J${CSI}H` // clear screen + cursor home
const SHOW_CURSOR = `${CSI}?25h`
const ERASE_LINE = `${CSI}2K`
const ALT_ENTER = `${CSI}?1049h`
const ALT_EXIT = `${CSI}?1049l`
const CRLF = "\r\n"

// A styled run: `open` and `close` are raw SGR strings ("" for a plain run).
interface Run {
  open: string
  text: string
  close: string
}

const plain = (text: string): Run => ({ open: "", text, close: "" })
/** A run opened by SGR `openCode` and closed by SGR `closeCode` (default 0 = reset). */
const sgr = (openCode: string, text: string, closeCode = "0"): Run => ({
  open: `${CSI}${openCode}m`,
  text,
  close: `${CSI}${closeCode}m`,
})

// The prompt marker "> " is bold, then intensity is reset before the user text.
const PROMPT_OPEN = `${CSI}1m> ${CSI}22m`

// ── The model builder ────────────────────────────────────────────────────────
//
// Every emit method appends bytes to `bytes` and, where the model produces a
// visible logical line, appends that line's plain text to `lines`. Byte-only
// events (alt-screen bleed) append no logical line; erased events append only
// the replacement line. build() crops `lines` to the trailing ROWS and rtrims.
class Synth {
  private readonly bytes: string[] = [CLEAR_HOME]
  private readonly lines: string[] = []

  /** User prompt line: bold "> " + typed text. */
  userPrompt(text: string): void {
    this.bytes.push(`${PROMPT_OPEN}${text}${CRLF}`)
    this.lines.push(`> ${text}`)
  }

  /** A content line built from styled runs. */
  line(runs: Run[]): void {
    for (const r of runs) this.bytes.push(r.open, r.text, r.close)
    this.bytes.push(CRLF)
    this.lines.push(runs.map((r) => r.text).join(""))
  }

  /** A plain (unstyled) content line. */
  text(s: string): void {
    this.line([plain(s)])
  }

  /** A blank line. */
  blank(): void {
    this.bytes.push(CRLF)
    this.lines.push("")
  }

  /**
   * A partial assistant line erased in-place (\r + CSI 2K) and replaced by the
   * interrupt notice. Only the notice contributes a logical line — the model
   * knows the partial text never survives.
   */
  interrupt(partial: string, notice: Run[]): void {
    this.bytes.push(partial, "\r", ERASE_LINE)
    for (const r of notice) this.bytes.push(r.open, r.text, r.close)
    this.bytes.push(CRLF)
    this.lines.push(notice.map((r) => r.text).join(""))
  }

  /**
   * An alt-screen excursion: enter alt, clear, paint one spinner line, exit alt.
   * Byte-only — alt-screen content must not bleed into the main extraction, so
   * it contributes no logical line.
   */
  altScreen(spinner: string): void {
    this.bytes.push(ALT_ENTER, CLEAR_HOME, spinner, CRLF, ALT_EXIT)
  }

  /** The trailing empty prompt that ends every scenario (no CRLF). */
  trailingPrompt(showCursor = false): void {
    this.bytes.push(PROMPT_OPEN)
    if (showCursor) this.bytes.push(SHOW_CURSOR)
    this.lines.push("> ")
  }

  build(): { bytes: Uint8Array; expected: string } {
    const cropped = this.lines.slice(Math.max(0, this.lines.length - ROWS))
    const expected = cropped.map((l) => l.replace(/ +$/, "")).join("\n") + "\n"
    return { bytes: new TextEncoder().encode(this.bytes.join("")), expected }
  }
}

// ── Scenario definitions ─────────────────────────────────────────────────────
interface Scenario {
  name: string
  recordedAt: string
  notes: string
  render: (s: Synth) => void
}

const scenarios: Scenario[] = [
  {
    name: "short-reply",
    recordedAt: "2026-05-14T17:32:26.498871Z",
    notes: "single-turn short reply with SGR styling",
    render: (s) => {
      s.userPrompt("hello")
      s.line([sgr("32", "Hi there!"), plain(" How can I help today?")])
      s.trailingPrompt(true) // short-reply alone re-shows the cursor
    },
  },
  {
    name: "code-block",
    recordedAt: "2026-05-14T17:32:26.499502Z",
    notes: "fenced code block with line-number gutter and SGR keyword highlighting",
    render: (s) => {
      s.userPrompt("show a hello world")
      s.line([sgr("36", "```go")])
      codeLine(s, 1, [sgr("35", "package"), plain(" main")])
      codeLine(s, 2, [])
      codeLine(s, 3, [sgr("35", "import"), plain(' "fmt"')])
      codeLine(s, 4, [])
      codeLine(s, 5, [sgr("35", "func"), plain(" main() {")])
      codeLine(s, 6, [plain('    fmt.Println("hello, world")')])
      codeLine(s, 7, [plain("}")])
      s.line([sgr("36", "```")])
      s.trailingPrompt()
    },
  },
  {
    name: "interrupt-mid-stream",
    recordedAt: "2026-05-14T17:32:26.49975Z",
    notes: "partial assistant line erased via \\r+CSI2K and replaced with interrupt notice",
    render: (s) => {
      s.userPrompt("write a long story")
      s.interrupt("Once upon a time, in a land far away, there lived a curious", [
        sgr("31", "⚠ interrupted by user"),
      ])
      s.trailingPrompt()
    },
  },
  {
    name: "long-markdown",
    recordedAt: "2026-05-14T17:32:26.499271Z",
    notes: "multi-paragraph reply: headings, bold runs, bullet list",
    render: (s) => {
      s.userPrompt("summarize the plan")
      s.line([sgr("1;4", "Overview")])
      s.line([plain("The plan has "), sgr("1", "three phases", "22"), plain(". Each phase is")])
      s.text("independently shippable.")
      s.blank()
      s.line([sgr("1;4", "Phases")])
      bullet(s, "Discovery", " — corpus + bench")
      bullet(s, "Adapters", " — codex, claude-code")
      bullet(s, "Library", " — pkg/chat")
      s.blank()
      s.line([sgr("2", "End of summary.")])
      s.trailingPrompt()
    },
  },
  {
    name: "scrollback-overflow",
    recordedAt: "2026-05-14T17:32:26.500134Z",
    notes: "32 logical lines on a 24-row screen; visible region is the trailing 24",
    render: (s) => {
      s.userPrompt("count to 30")
      for (let i = 1; i <= 30; i++) s.text(`line ${i}`)
      s.trailingPrompt()
    },
  },
  {
    name: "alt-screen-toggle",
    recordedAt: "2026-05-14T17:32:26.499945Z",
    notes: "CSI ?1049h/l alt-screen entry/exit; alt-screen content must not bleed into main extraction",
    render: (s) => {
      s.userPrompt("list files")
      s.altScreen("⠋ loading files...")
      s.text("README.md  go.mod  pkg/")
      s.trailingPrompt()
    },
  },
]

/** A source line with a dim right-aligned line-number gutter ("  N │") + code. */
function codeLine(s: Synth, n: number, code: Run[]): void {
  const gutter = sgr("2", `${String(n).padStart(3)} │`)
  s.line([gutter, plain(" "), ...code])
}

/** A markdown bullet: "  " + yellow "•" + " " + bold term + trailing plain text. */
function bullet(s: Synth, term: string, rest: string): void {
  s.line([plain("  "), sgr("33", "•"), plain(" "), sgr("1", term, "22"), plain(rest)])
}

// ── Emit / check ─────────────────────────────────────────────────────────────
function metaJson(sc: Scenario): string {
  const meta = {
    harness: HARNESS,
    binary_version: BINARY_VERSION,
    recorded_at: sc.recordedAt,
    cols: COLS,
    rows: ROWS,
    notes: sc.notes,
  }
  // NOTE: no trailing newline — matches the Go tool, NOT the MH recorders.
  return JSON.stringify(meta, null, 2)
}

interface Artifacts {
  bytes: Uint8Array
  meta: Uint8Array
  expected: Uint8Array
}

function generate(sc: Scenario): Artifacts {
  const s = new Synth()
  sc.render(s)
  const { bytes, expected } = s.build()
  const enc = new TextEncoder()
  return { bytes, meta: enc.encode(metaJson(sc)), expected: enc.encode(expected) }
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function main(): void {
  const argv = process.argv.slice(2)
  let outDir: string | undefined
  let check = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--out") outDir = argv[++i]
    else if (a === "--check") check = true
    else throw new Error(`unknown argument: ${a}`)
  }

  const here = dirname(fileURLToPath(import.meta.url))
  const synthRoot = outDir ?? join(here, "..", "synth")
  const fixtureRoot = join(here, "..", "synth")

  let mismatches = 0
  for (const sc of scenarios) {
    const art = generate(sc)
    const files: Array<[string, Uint8Array]> = [
      ["bytes.raw", art.bytes],
      ["meta.json", art.meta],
      ["expected.txt", art.expected],
    ]
    if (check) {
      for (const [name, bytes] of files) {
        const path = join(fixtureRoot, sc.name, name)
        const have = new Uint8Array(readFileSync(path))
        if (eq(have, bytes)) {
          console.log(`  ok   ${sc.name}/${name}`)
        } else {
          console.log(`  DIFF ${sc.name}/${name} (fixture ${have.length}B, generated ${bytes.length}B)`)
          mismatches++
        }
      }
    } else {
      const dir = join(synthRoot, sc.name)
      mkdirSync(dir, { recursive: true })
      for (const [name, bytes] of files) writeFileSync(join(dir, name), bytes)
      console.log(`  wrote ${sc.name} (bytes ${art.bytes.length}, meta ${art.meta.length}, expected ${art.expected.length})`)
    }
  }

  if (check) {
    if (mismatches > 0) {
      console.error(`\n${mismatches} artifact(s) diverged from the checked-in fixtures`)
      process.exit(1)
    }
    console.log("\nall synth artifacts match the checked-in fixtures")
  }
  process.exit(0)
}

main()
