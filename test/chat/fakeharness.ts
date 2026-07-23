// The scriptable fake harness — the TS port of internal/fakeharness (Go). A test
// builds a Script with the fluent Builder, marshals it to JSON, and points the
// runnable (fakeharness.mjs) at it via the FAKEHARNESS_SCRIPT env var. The
// runnable is spawned by chat.Open over a REAL pty, so replaying a script drives
// the genuine screen emulator, turn watcher, and idle-completion timers end to
// end — the timing-sensitive completion path unit tests calling maybeIdleComplete
// directly cannot reach.

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Open,
  type Conversation,
  type Options,
  type PermissionRung,
  type Turn,
} from "../../src/chat/index.ts";
import {
  EventTurn,
  RoleAssistant,
  TurnStateComplete,
  TurnStateErrored,
} from "../../src/chat/index.ts";
import { newMemStore } from "../../src/chat/index.ts";
import { Context } from "../../src/internal/async/index.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Env var the runnable reads the script-file path from. */
export const EnvVar = "FAKEHARNESS_SCRIPT";

/** Env var the runnable dumps its launch argv (argv.slice(2)) to, as JSON. */
export const ArgvOutVar = "FAKEHARNESS_ARGV_OUT";

/** Absolute path to the executable fake-harness runnable (node shebang). */
export const fakeHarnessBin: string = join(here, "fakeharness.mjs");

// Belt-and-suspenders: ensure the executable bit survives a fresh checkout.
try {
  chmodSync(fakeHarnessBin, 0o755);
} catch {
  /* best effort */
}

/**
 * SubmitCSI13u — the bytes chat.Send writes to submit a turn for claude-code and
 * codex: CSI 13 u, unmodified Enter in the kitty keyboard protocol those TUIs
 * enable. Scenarios wait for it via AwaitSubmit, pinning the submit contract.
 */
export const SubmitCSI13u = "\x1b[13u";

/** SubmitCR — the byte chat.Send writes to submit a turn for pi: a bare CR. */
export const SubmitCR = "\r";

/**
 * PermissionsCommandText — the literal command setCodexPermissionPreset
 * (META-HARNESS-103) types to open codex's /permissions dialog, submitted with
 * SubmitCSI13u exactly like any other codex send (writeMessageAndSubmit,
 * src/chat/conversation.ts:1829) — that CSI 13 u is what actually opens the
 * dialog live, per the probed byte pin (META-HARNESS-122 probe-backout-keys
 * stdin.log: "open-type-bare-esc /permissions" / "open-submit-bare-esc
 * \x1b[13u"). AwaitPermissionsOpen matches the two as one accumulated burst.
 */
export const PermissionsCommandText = "/permissions";

/**
 * BackoutESC — the bytes dialogBackoutKeys() (META-HARNESS-103) writes to
 * dismiss the /permissions dialog without committing a preset: a bare ESC,
 * single byte 0x1b. Probed live against codex-cli 0.144.5 (META-HARNESS-122
 * probe-backout-keys): CSI 27 u ('\x1b[27u') dismissed equally well in the same
 * session, but bare ESC is the simpler encoding and the one a human hitting the
 * physical Esc key sends, so it is the one pinned here.
 */
export const BackoutESC = "\x1b";

/**
 * ComposerClearCtrlU — the bytes composerClearKeys() (META-HARNESS-103) writes
 * to empty a composer that still holds literal, unsubmitted text: Ctrl-U,
 * single byte 0x15. Probed live against codex-cli 0.144.5 (META-HARNESS-122
 * probe-composer-clear-keys) alongside Ctrl-A+Ctrl-K and a backspace run — all
 * three cleared the composer back to the idle-placeholder baseline, but Ctrl-U
 * is the shortest: one write regardless of how much text is in the composer,
 * unlike the backspace run whose write count must scale with the text's length.
 */
export const ComposerClearCtrlU = "\x15";

/**
 * PermissionCycleCSI — the bytes the wrapper writes to advance the
 * permission-mode ring by exactly one rung: ESC [ Z, legacy back-tab
 * (Shift+Tab). Scenarios wait for it via AwaitPermissionCycle, pinning the
 * cycle contract the way SubmitCSI13u pins the submit contract.
 *
 * ONE constant, not one per harness, because the two adapters that implement
 * turns.PermissionModeCycler pin the SAME sequence: `permissionCycleCommand` in
 * src/turns/harness/claudecode.ts and in src/turns/harness/codex.ts are both
 * `enc.encode("\x1b[Z")`. That is not a coincidence to be papered over — it is
 * the recorded outcome of META-HARNESS-114's live probe (test/corpus/
 * claude-code/permission-mode-cycle and test/corpus/codex/
 * permission-mode-cycle, claude-code 2.1.218 / codex-cli 0.144.5). Both TUIs
 * enable the kitty keyboard protocol, so the kitty spelling "\x1b[9;2u" was
 * probed alongside CSI Z and BOTH advance the ring by exactly one rung on both
 * harnesses; each adapter pins CSI Z because legacy back-tab is understood
 * whether or not the kitty protocol has been negotiated at that moment. Should
 * a future capture split the two, split this into one constant per harness
 * rather than widening the regex.
 */
export const PermissionCycleCSI = "\x1b[Z";

/**
 * ClaudeModeFooters — the permission-mode footer line claude-code paints for
 * each rung of the ladder, as captured live on 2.1.218 (the `footer_line` field
 * of each test/corpus/claude-code/permission-mode-* meta.json, corroborated by
 * `footer_per_screen` in the permission-mode-cycle recording).
 *
 * Two properties consuming tests depend on, both load-bearing:
 *
 *   1. `manual` is the ONLY rung WITHOUT the "(shift+tab to cycle)" suffix. A
 *      painter that appended that suffix uniformly would make the parser tests
 *      lie — src/chat/permission.ts matches the structural "<words> on"
 *      fragment precisely so the suffix-less default is not invisible to it.
 *   2. EVERY rung paints a line. There is no marker-absent rung on claude, so a
 *      painter set that omitted the default would encode a fiction.
 *
 * The " · ← for agents" tail is the spelling src/chat/permission.ts records
 * from 2.1.217; the 2.1.218 capture environment did not paint it (see the
 * `spelling_note` on every META-HARNESS-109 fixture). It is inert either way —
 * the parser's fragment stops at the trailing " on" and never runs to
 * end-of-line — so it is painted here to match the wider (and documented) of
 * the two real spellings.
 */
export const ClaudeModeFooters: Readonly<Record<PermissionRung, string>> = {
  auto: "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  manual: "⏸ manual mode on · ← for agents",
  acceptEdits: "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  plan: "⏸ plan mode on (shift+tab to cycle) · ← for agents",
  bypass: "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
};

/**
 * ClaudeDefaultRung — the rung a fresh claude-code session launches on, and so
 * the footer PermissionFooter paints when a scenario does not name one.
 *
 * `manual` per src/chat/permission.ts ("it is claude's current DEFAULT"). The
 * META-HARNESS-114 probe recording launched into `auto` — an environment
 * difference (a settings.json / flag default), not a contradiction — which is
 * exactly why scenarios name their starting rung explicitly rather than relying
 * on the harness's own default.
 */
export const ClaudeDefaultRung: PermissionRung = "manual";

/**
 * CodexStatusBanner — the `/status` box header the codex session-id scrape
 * gates on (statusBoxHeaderRE, src/turns/harness/codex.ts:~87). It establishes
 * harness identity, so CodexStatus paints it verbatim inside the box; without
 * it neither extractSessionID nor the collaboration-row parse engages.
 */
export const CodexStatusBanner = ">_ OpenAI Codex (v0.144.5)";

const promptPlaceholder = "{{prompt}}";

/** PromptRef returns the placeholder a scenario embeds to have the captured prompt substituted. */
export function PromptRef(): string {
  return promptPlaceholder;
}

export interface Frame {
  delay_ms: number;
  screen: string;
  echo?: boolean;
  no_clear?: boolean;
}
export interface WaitInput {
  until_regex: string;
  capture?: boolean;
  label?: string;
}
export interface Exit {
  code: number;
}
export type Hold = Record<string, never>;

export interface Step {
  frame?: Frame;
  wait_input?: WaitInput;
  hold?: Hold;
  exit?: Exit;
}

export interface Script {
  harness: string;
  session_id?: string;
  steps: Step[];
}

const defaultSessionID = "11111111-2222-3333-4444-555555555555";

// Escape a literal string into a JS-regex-safe pattern (the JS analogue of Go's
// regexp.QuoteMeta). The ESC byte in SubmitCSI13u stays literal and matches the
// raw control byte in the accumulated latin1 view.
function quoteMeta(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ccHeader = "Claude Code";
const ccPrompt = "❯ ";
const ccBusy = "  ⏵⏵ esc to interrupt";
const ccSpinner = "✶ Cerebrating… (3s · ↓ 1.2k tokens)";
const codexPrompt = "› ";
const piStatus =
  "↑1.2k ↓32 $0.000 0.9%/131k (auto)                      gpt-oss-120b • medium";
const piRule = "────────────────────────────────────────";
const piSpinner = " ⠧ Working...";

/**
 * Builder assembles a Script with harness-appropriate screen frames. The
 * semantic methods stamp the exact glyphs the corresponding adapter keys off of,
 * kept in one place so a future TUI drift updates fixtures and patterns together.
 */
export class Builder {
  private s: Script;

  constructor(harness: string) {
    this.s = { harness, session_id: defaultSessionID, steps: [] };
  }

  /** Overrides the session UUID emitted in the resume hint. */
  Session(id: string): this {
    this.s.session_id = id;
    return this;
  }

  /** Returns the assembled Script. */
  Build(): Script {
    return this.s;
  }

  get harness(): string {
    return this.s.harness;
  }

  private frame(delayMs: number, screen: string, echo: boolean): this {
    this.s.steps.push({ frame: { delay_ms: delayMs, screen, echo } });
    return this;
  }

  private waitInput(re: string, capture: boolean, label: string): this {
    this.s.steps.push({ wait_input: { until_regex: re, capture, label } });
    return this;
  }

  /** Appends a step that terminates the fake with the given code. */
  Exit(code: number): this {
    this.s.steps.push({ exit: { code } });
    return this;
  }

  /** Blocks until the wrapper submits a turn (CSI 13u) and captures the prompt. */
  AwaitSubmit(): this {
    return this.waitInput(quoteMeta(SubmitCSI13u), true, "submit");
  }

  /** Blocks until the wrapper selects a menu row (a digit followed by CR). */
  AwaitMenuChoice(): this {
    return this.waitInput("[0-9]\\r", false, "menu-choice");
  }

  /** Blocks until the wrapper submits a turn with a bare CR (pi's submit key). */
  AwaitSubmitCR(): this {
    return this.waitInput(quoteMeta(SubmitCR), true, "submit-cr");
  }

  /** Blocks until the wrapper writes a bare digit (question-option select). */
  AwaitDigit(): this {
    return this.waitInput("[0-9]", false, "digit");
  }

  /**
   * Blocks until the wrapper writes the permission-mode cycle key (Shift+Tab).
   *
   * `capture: false` — unlike AwaitSubmit, the cycle key carries no prompt text
   * ahead of it, so there is nothing to substitute into a later echo frame.
   * Nothing is needed on the .mjs side: waitInput compiles until_regex straight
   * into readUntil (fakeharness.mjs:25-41), which matches over a latin1 view, so
   * the literal ESC byte in PermissionCycleCSI matches the raw control byte the
   * wrapper writes exactly as SubmitCSI13u's already does.
   */
  AwaitPermissionCycle(): this {
    return this.waitInput(
      quoteMeta(PermissionCycleCSI),
      false,
      "permission-cycle",
    );
  }

  /**
   * Blocks until the wrapper writes the /permissions open burst: the literal
   * command text (PermissionsCommandText) followed by the CSI 13u submit key
   * (SubmitCSI13u) — the same two byte groups writeMessageAndSubmit emits for
   * any codex send. Matched as ONE accumulated pattern rather than two chained
   * waitInput calls: readUntil (fakeharness.mjs) matches over the growing
   * accumulated stdin buffer regardless of how many separate PTY writes make it
   * up, so this fires the same whether the driver bursts both in one write or
   * splits them with an echo wait in between (conversation.ts's split for
   * prompt-readiness harnesses).
   */
  AwaitPermissionsOpen(): this {
    return this.waitInput(
      quoteMeta(PermissionsCommandText + SubmitCSI13u),
      false,
      "permissions-open",
    );
  }

  /**
   * Blocks until the wrapper writes the /permissions backout key: a bare ESC
   * (BackoutESC).
   *
   * CRITICAL: this must NOT also match CSI 13u ('\x1b[13u', SubmitCSI13u) or
   * CSI 27u ('\x1b[27u') — both are byte-for-byte prefixed by the exact same
   * 0x1b BackoutESC is, so a naive /\x1b/ matcher would fire on the first byte
   * of either and make every backout assertion pass on a submit it was supposed
   * to be distinguishing from (probed and documented live, META-HARNESS-122
   * probe-backout-keys meta.json's "NON-OVERLAP NOTE"). The fix: require the
   * 0x1b NOT be immediately followed by '[' — true for a solitary ESC, false
   * for either CSI encoding.
   */
  AwaitBackout(): this {
    return this.waitInput("\x1b(?!\\[)", false, "backout");
  }

  /** Blocks until the wrapper writes the composer-clear key (ComposerClearCtrlU). */
  AwaitComposerClear(): this {
    return this.waitInput(
      quoteMeta(ComposerClearCtrlU),
      false,
      "composer-clear",
    );
  }

  private ccScreen(...lines: string[]): string {
    return lines.join("\n") + "\n";
  }

  private resumeHint(): string {
    if (this.s.harness === "codex")
      return "  codex resume " + this.s.session_id;
    return "  claude --resume " + this.s.session_id;
  }

  /** Paints the startup composer: ready for input, not busy. MUST be first. */
  Idle(): this {
    if (this.s.harness === "codex") {
      return this.frame(
        0,
        this.ccScreen("Codex", "", "› ", "", this.resumeHint()),
        false,
      );
    }
    return this.frame(
      0,
      this.ccScreen(ccHeader, "", ccPrompt, "", this.resumeHint()),
      false,
    );
  }

  /** Paints an in-flight frame: spinner + "esc to interrupt" footer (Busy). */
  Working(delayMs: number, status: string): this {
    const spinner = ccSpinner.replace("Cerebrating", status);
    return this.frame(
      delayMs,
      this.ccScreen(ccHeader, "", spinner, "", ccPrompt, ccBusy),
      false,
    );
  }

  /** Paints an intermediate end-of-turn summary while STILL busy (must defer). */
  Marker(delayMs: number, verb: string, dur: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        ccHeader,
        "",
        "✻ " + verb + " for " + dur,
        ccSpinner,
        "",
        ccPrompt,
        ccBusy,
      ),
      false,
    );
  }

  /** Paints the danger frame: footer + spinner absent for one redraw (Busy false). */
  Flicker(delayMs: number, note: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        ccHeader,
        "",
        "⏺ " + note,
        "  running Explore sub-agent",
        "",
        ccPrompt,
      ),
      false,
    );
  }

  /** The exact trigger for the 3eda8a8 bug: a marker on a flickered-off frame. */
  MarkerFlicker(
    delayMs: number,
    verb: string,
    dur: string,
    note: string,
  ): this {
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
    );
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
    );
  }

  /** Paints a settled, ready, non-busy frame with a reply bullet but NO marker. */
  SettleIdle(delayMs: number, body: string): this {
    return this.frame(
      delayMs,
      this.ccScreen(ccHeader, "", "⏺ " + body, "", ccPrompt, this.resumeHint()),
      true,
    );
  }

  // --- claude-code permission-mode vocabulary (2.1.218 capture) ---

  /**
   * Paints a settled, ready claude composer carrying the permission-mode footer
   * for `rung` — one frame per rung of the ladder, so a scenario can answer each
   * Shift+Tab press with the screen the real TUI would repaint.
   *
   * The footer goes LAST, below the resume hint: it is the bottom-most line on a
   * real screen and src/chat/permission.ts takes the LAST match, so painting it
   * anywhere else would let scrollback outrank it. Otherwise this is Idle()'s
   * shape — ready composer, no busy marker — because cycling the ring does not
   * take the session out of the ready state.
   */
  PermissionFooter(delayMs: number, rung: PermissionRung): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        ccHeader,
        "",
        ccPrompt,
        "",
        this.resumeHint(),
        ClaudeModeFooters[rung],
      ),
      false,
    );
  }

  /**
   * Paints claude's Bypass Permissions acceptance dialog — the blocking screen
   * `bypassAnchor` (src/turns/harness/claudecode.ts) detects as
   * `kind: "trust_prompt"` and `claudeBypassAnchor` (src/chat/ready.ts:17)
   * treats as not-ready-for-input.
   *
   * Parked MID-RING by a scenario, this proves a cycle loop re-checks for a
   * pending input request between presses instead of reporting a stall: the
   * screen is idle and non-busy, but no rung footer is painted and the composer
   * "❯" is consumed by the menu rows, so a loop that only watched the footer
   * would sit here until its backstop fired.
   */
  BypassPrompt(delayMs: number): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        " ▐▛███▜▌   " + ccHeader + " v2.1.218",
        "",
        "╭────────────────────────────────────────╮",
        "│ Bypass Permissions mode                │",
        "│                                        │",
        "│ In Bypass Permissions mode, Claude     │",
        "│ Code will not ask for your approval    │",
        "│ before running potentially dangerous   │",
        "│ commands.                              │",
        "│                                        │",
        "│ ❯ 1. No, exit                          │",
        "│   2. Yes, I accept                     │",
        "╰────────────────────────────────────────╯",
      ),
      false,
    );
  }

  // --- claude-code AskUserQuestion vocabulary (shapes verified on 2.1.210) ---

  private static readonly qRule = "─".repeat(120);

  /**
   * Paints an AskUserQuestion QUESTION pane: tab strip, question text, numbered
   * options (+ the UI's "Type something." / "Chat about this" affordances), and
   * the select footer. Idle-but-not-ready: no busy footer, no marker, no empty
   * composer — the exact silent-hang shape the question detection must catch.
   * `options` entries are [label, description?].
   */
  Question(
    delayMs: number,
    tabStrip: string,
    question: string,
    options: string[][],
  ): this {
    const lines = [
      ccHeader,
      "",
      "⏺ I'll ask you the question now.",
      Builder.qRule,
      tabStrip,
      "",
      question,
      "",
    ];
    options.forEach(([label, desc], i) => {
      lines.push(`${i === 0 ? "❯" : " "} ${i + 1}. ${label}`);
      if (desc) lines.push(`     ${desc}`);
    });
    const n = options.length;
    lines.push(`  ${n + 1}. Type something.`);
    lines.push(Builder.qRule);
    lines.push(`  ${n + 2}. Chat about this`);
    lines.push("");
    lines.push("Enter to select · ↑/↓ to navigate · Esc to cancel");
    return this.frame(delayMs, this.ccScreen(...lines), false);
  }

  /** Paints the REVIEW pane shown after the last question of a multi-question dialog. */
  QuestionReview(
    delayMs: number,
    tabStrip: string,
    answers: [string, string][],
  ): this {
    const lines = [
      ccHeader,
      "",
      Builder.qRule,
      tabStrip,
      "",
      "Review your answers",
      "",
    ];
    for (const [q, a] of answers) {
      lines.push(` ● ${q}`);
      lines.push(`   → ${a}`);
    }
    lines.push(
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
    );
    return this.frame(delayMs, this.ccScreen(...lines), false);
  }

  /** Paints the answered-questions tool block with the turn back in flight. */
  QuestionAnswered(delayMs: number, answers: [string, string][]): this {
    const lines = [ccHeader, "", "⏺ User answered Claude's questions:"];
    answers.forEach(([q, a], i) => {
      lines.push(`${i === 0 ? "  ⎿ " : "    "} · ${q} → ${a}`);
    });
    lines.push("", ccSpinner, "", ccPrompt, ccBusy);
    return this.frame(delayMs, this.ccScreen(...lines), false);
  }

  // --- codex vocabulary ---

  /** Paints an in-flight codex frame: status, no prompt, no Token-usage footer. */
  CodexWorking(delayMs: number, status: string): this {
    return this.frame(
      delayMs,
      this.ccScreen("Codex", "", "• " + status + "…", ""),
      false,
    );
  }

  /**
   * Paints the codex swallowed-submit frame: the captured prompt still sitting
   * in the composer ("› <prompt>"), screen otherwise settled — the live 0.142.5
   * shape after a text+Enter burst is consumed as a paste (META-HARNESS-21).
   */
  CodexSwallowed(delayMs: number): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        "Codex",
        "",
        "› " + promptPlaceholder,
        "",
        this.resumeHint(),
      ),
      true, // echo: substitute the captured prompt into the composer row
    );
  }

  /**
   * codexStatusInner — the character width INSIDE the `/status` box borders.
   *
   * The scrape is row-anchored: statusSessionRE and codexCollaborationRowRE both
   * require the closing "│" on the SAME physical line, so a wrapped row fails to
   * match and the reading falls to "unknown". 93 + the two borders = 95 columns,
   * comfortably above CODEX_STATUS_MIN_COLS (60, src/turns/harness/codex.ts:99)
   * and matching the live 0.144.5 box in test/corpus/codex/permission-mode-cycle
   * (recorded at 120x40 — the width openFake defaults to).
   */
  private static readonly codexStatusInner = 93;

  private codexStatusRow(text: string): string {
    const inner = Builder.codexStatusInner;
    return "│" + text.padEnd(inner, " ").slice(0, inner) + "│";
  }

  /**
   * Paints a codex `/status` box reporting the given collaboration mode.
   *
   * TWO frames exist (Default and Plan), not one, because the consuming loop
   * probes `/status`, presses Shift+Tab once, and probes again: the confirm path
   * has to be deterministic in BOTH directions of the measured 2-cycle
   * (Default ⇄ Plan), so a scenario answers each probe with the box the real TUI
   * would repaint. Rows and label column are the live 0.144.5 shape; the
   * `Session:` row carries this script's session id so the box also satisfies
   * the existing session-id scrape, and the banner row is CodexStatusBanner —
   * the harness-identity gate that scrape keys off.
   *
   * `permissions` defaults to the original hardcoded "Workspace (Ask for
   * approval)" row so every existing call site is unaffected; a
   * setCodexPermissionPreset scenario (META-HARNESS-103) that needs to
   * confirm a preset commit passes the row THAT preset writes instead (see
   * codexPresetExpectedRaw, src/chat/conversation.ts) — the Permissions row
   * moves independently of the Collaboration row this method already varies.
   */
  CodexStatus(
    delayMs: number,
    collaboration: "Default" | "Plan",
    permissions = "Workspace (Ask for approval)",
  ): this {
    const rule = "─".repeat(Builder.codexStatusInner);
    const statusLine = "  gpt-5.6-sol medium · ~/proj";
    return this.frame(
      delayMs,
      this.ccScreen(
        "/status",
        "",
        "╭" + rule + "╮",
        this.codexStatusRow("  " + CodexStatusBanner),
        this.codexStatusRow(""),
        this.codexStatusRow(
          "  Model:                gpt-5.6-sol (reasoning medium, summaries auto)",
        ),
        this.codexStatusRow("  Directory:            ~/proj"),
        this.codexStatusRow("  Permissions:          " + permissions),
        this.codexStatusRow("  Agents.md:            AGENTS.md"),
        this.codexStatusRow("  Collaboration mode:   " + collaboration),
        this.codexStatusRow("  Session:              " + this.s.session_id),
        this.codexStatusRow(""),
        "╰" + rule + "╯",
        "",
        codexPrompt,
        "",
        this.resumeHint(),
        // The composer status line carries a "Plan mode" marker on the right
        // while the Plan rung is live — the second surface the 2-cycle shows up
        // on, painted so a scenario can assert either one.
        collaboration === "Plan"
          ? statusLine.padEnd(60, " ") + "Plan mode"
          : statusLine,
      ),
      false,
    );
  }

  /** Paints the end-of-turn codex frame with a fresh Token-usage footer. */
  CodexReply(delayMs: number, body: string): this {
    const n = this.s.steps.length + 1;
    const tokenUsage = `Token usage: total=${1000 * n} input=${800 * n} (+ 0 cached) output=${200 * n}`;
    return this.frame(
      delayMs,
      this.ccScreen(
        "Codex",
        "",
        body,
        "",
        tokenUsage,
        "",
        codexPrompt,
        this.resumeHint(),
      ),
      true,
    );
  }

  /**
   * codexPermissionsRows — the "Update Model Permissions" menu body for each
   * paintable `current` selection, captured VERBATIM from the live 0.144.5
   * corpus recordings (test/corpus/codex/permissions-dialog for `1`,
   * test/corpus/codex/permissions-approve-current for `2`) so the painted
   * screen is exactly what detectPermissions (src/turns/harness/codex.ts:504)
   * parses off the real dialog — not a paraphrase of it.
   *
   * Reused verbatim rather than computed: the double-space column gutter
   * cleanLabel (codex.ts:604) splits on shifts with the widest rendered label
   * (the "(current)" suffix lengthens whichever row carries it), which is why
   * the gutter position and the second column's word-wrap differ between the
   * two states below — a generative approach would have to reimplement that
   * layout to stay faithful, so the recorded rows are pinned as data instead.
   */
  private static readonly codexPermissionsRows: Readonly<
    Record<1 | 2, readonly string[]>
  > = {
    1: [
      "› 1. Ask for approval (current)  Codex can read and edit files in the current workspace, and run commands. Approval is",
      "                                 required to access the internet or edit other files.",
      "  2. Approve for me              Only ask for actions detected as potentially unsafe.",
      "  3. Full Access                 Codex can edit files outside this workspace and access the internet without asking",
      "                                 for approval. Exercise caution when using.",
    ],
    2: [
      "  1. Ask for approval          Codex can read and edit files in the current workspace, and run commands. Approval is",
      "                               required to access the internet or edit other files.",
      "› 2. Approve for me (current)  Only ask for actions detected as potentially unsafe.",
      "  3. Full Access               Codex can edit files outside this workspace and access the internet without asking for",
      "                               approval. Exercise caution when using.",
    ],
  };

  /**
   * Paints codex's "Update Model Permissions" dialog (opened by /permissions),
   * with `current` selecting which preset row carries the live "›" highlight
   * AND the "(current)" suffix — both fixture states from the corpus are
   * paintable this way: `1` is test/corpus/codex/permissions-dialog (a fresh
   * config, "Ask for approval" in effect); `2` is
   * test/corpus/codex/permissions-approve-current (the already-current state a
   * scenario needs to exercise the "target preset already current" backout
   * path). The header is the anchor detectPermissions keys on
   * (permissionsAnchor, codex.ts:384); the footer is NOT — it is assembled
   * upstream from template fragments codex-side and is painted only for visual
   * fidelity.
   */
  CodexPermissionsDialog(delayMs: number, current: 1 | 2): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        "  Update Model Permissions",
        "",
        ...Builder.codexPermissionsRows[current],
        "",
        "  Press enter to confirm or esc to go back",
      ),
      false,
    );
  }

  /**
   * Paints codex's "Update Model Permissions" dialog as it renders with the
   * `guardian_approval` feature flag off: "Approve for me" is gone, replaced by
   * a "Read Only" / "Default" / "Custom permissions" ladder (the row set
   * ErrPermissionPresetUnavailable's rows list names, test/chat/
   * codex_permissions_errors.test.ts). No live corpus recording backs this
   * shape (the flag was on for every META-HARNESS-122 probe session), so the
   * rows are hand-written rather than reused verbatim — unlike
   * CodexPermissionsDialog, still following the same double-space gutter
   * convention detectPermissions/cleanLabel depend on. "Read Only" is painted
   * highlighted+current (a fresh install's default rung), matching how both
   * corpus states above put the highlight on the in-effect preset.
   */
  CodexPermissionsDialogFlagOff(delayMs: number): this {
    return this.frame(
      delayMs,
      this.ccScreen(
        "  Update Model Permissions",
        "",
        "› 1. Read Only (current)  Codex can read files but cannot edit them or run commands.",
        "  2. Default               Codex can read and edit files in the current workspace, and run commands.",
        "  3. Custom permissions    Configure a custom permission profile.",
        "",
        "  Press enter to confirm or esc to go back",
      ),
      false,
    );
  }

  /**
   * Paints a "›"-prefixed composer row still carrying `text`, unsubmitted — the
   * live 0.142.5 paste-swallow shape (writeMessageAndSubmit's docstring,
   * src/chat/conversation.ts:1815-1827): a text+Enter burst consumed as a paste
   * renders the Enter as a newline and leaves the prompt sitting in the
   * composer instead of opening the dialog. composerRowRE (codex.ts:396)
   * captures everything after the "›" glyph on the last such row, so a
   * non-empty `text` here is exactly what makes that capture non-empty — the
   * signal the swallowed-write detection has to key on, and the reason
   * codexPromptRE (ready.ts:58) is not enough by itself: it matches this row
   * just as happily as the idle "› " one, which is why readyForInput reports
   * this screen ready even though the write was never actually submitted.
   */
  CodexDirtyComposer(delayMs: number, text: string): this {
    return this.frame(
      delayMs,
      this.ccScreen("Codex", "", "› " + text, "", this.resumeHint()),
      false,
    );
  }

  // --- pi vocabulary ---

  private frameLines(...lines: string[]): string {
    return lines.join("\n") + "\n";
  }

  /** Paints pi's idle composer: context-usage status up, no spinner. MUST be first. */
  PiIdle(): this {
    return this.frame(
      0,
      this.frameLines(piRule, "", piRule, "~/proj (main)", piStatus),
      false,
    );
  }

  /** Paints an in-flight pi frame: the "Working..." spinner makes pi.Busy true. */
  PiWorking(delayMs: number): this {
    return this.frame(
      delayMs,
      this.frameLines(piSpinner, "", piRule, "", piRule, piStatus),
      false,
    );
  }

  /** Paints the settled end-of-turn pi frame: reply body + idle status, no spinner. */
  PiReply(delayMs: number, body: string): this {
    return this.frame(
      delayMs,
      this.frameLines(body, "", piRule, "", piRule, "~/proj (main)", piStatus),
      true,
    );
  }

  // --- raw output & lifecycle ---

  /** Emits text verbatim (trailing newline, no clear/home) for the line classifier. */
  Raw(delayMs: number, text: string): this {
    this.s.steps.push({
      frame: {
        delay_ms: delayMs,
        screen: text + "\n",
        echo: true,
        no_clear: true,
      },
    });
    return this;
  }

  /** Holds at the prompt after the timeline until the wrapper terminates it. */
  StayAliveUntilStopped(): this {
    this.s.steps.push({ hold: {} });
    return this;
  }
}

/** New starts a Builder for the named harness with the default session ID. */
export function New(harness: string): Builder {
  return new Builder(harness);
}

// Shrunk completion windows so PTY-driven tests run in ~1s instead of ~10s. The
// invariant under test (a flicker must not complete; only a settled prompt may)
// holds at any scale, as long as fixture frame delays stay below markerGap.
export const testIdleGap = 500;
export const testMarkerGap = 120;
// The fake never echoes typed text into a frame, so every echo-gated send waits
// the full bound before writing the submit key. Keep it small — and strictly
// below testIdleGap, or the idle watcher could complete a turn pre-submit.
export const testEchoBound = 120;

/**
 * openFake spawns the fake harness driving the given script and returns an open
 * Conversation. The script is delivered via a temp file referenced by the
 * FAKEHARNESS_SCRIPT env var; env is the full environment so the child keeps
 * PATH/TERM (and can resolve the node shebang).
 */
/**
 * fakeLaunchEnv writes the script to a temp file and returns the env array a
 * fake-harness launch needs (script path + optional argv-dump path), so callers
 * that drive Open/Reopen directly (e.g. resume tests) can supply their own Store.
 */
export function fakeLaunchEnv(script: Script, argvOut?: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "fakeharness-script-"));
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify(script), { mode: 0o600 });
  return [
    ...Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`),
    `${EnvVar}=${scriptPath}`,
    ...(argvOut ? [`${ArgvOutVar}=${argvOut}`] : []),
  ];
}

export async function openFake(
  script: Script,
  overrides: Partial<Options> & { argvOut?: string } = {},
): Promise<Conversation> {
  const { argvOut, ...optOverrides } = overrides;
  const env = fakeLaunchEnv(script, argvOut);

  return Open(undefined, {
    harness: script.harness,
    binaryPath: fakeHarnessBin,
    env,
    store: newMemStore(),
    cols: 120,
    rows: 40,
    idleGap: testIdleGap,
    markerGap: testMarkerGap,
    echoBound: testEchoBound,
    ...optOverrides,
  });
}

/**
 * sendOneTurn acquires control, sends text, and releases control after the send
 * returns (the in-flight turn continues independently).
 */
export async function sendOneTurn(
  conv: Conversation,
  text: string,
): Promise<void> {
  const ctx = Context.background();
  const release = await conv.acquireControl(ctx);
  try {
    await conv.send(ctx, text);
  } finally {
    release();
  }
}

/**
 * waitForTerminalTurn drains conversation events until an assistant turn reaches
 * a terminal state (complete or errored), or the timeout fires.
 */
export async function waitForTerminalTurn(
  conv: Conversation,
  timeoutMs: number,
): Promise<Turn> {
  const bus = conv.events();
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => {
      reject(
        new Error(
          `timed out after ${timeoutMs}ms waiting for a terminal assistant turn`,
        ),
      );
    }, timeoutMs),
  );
  for (;;) {
    const next = (async () => {
      const { value, ok } = await bus.receive();
      if (!ok) throw new Error("event channel closed before a terminal turn");
      return value!;
    })();
    const ev = await Promise.race([next, deadline]);
    if (
      ev.type === EventTurn &&
      ev.turn?.role === RoleAssistant &&
      (ev.turn.state === TurnStateComplete ||
        ev.turn.state === TurnStateErrored)
    ) {
      return ev.turn;
    }
  }
}
