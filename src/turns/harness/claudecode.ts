// Turn-detection adapter for Anthropic's Claude Code CLI.
//
// Detection signals (verified against 2.1.x):
//   - End of an assistant turn: a "✻ <verb> for Ns" thinking-summary line.
//   - User interrupt: a "⎿  Interrupted · What should Claude do instead?" line.
//   - Blocking startup dialogs (folder-trust, bypass acceptance).
//
// Embeds the generic adapter so wrapper-level status events keep flowing.
// Port of pkg/turns/harness/claudecode/{claudecode.go}.

import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../screen/index.ts";
import { ClaudeCodeReader } from "../../transcript/claudecode/claudecode.ts";
import { turnsFromEvents } from "../../transcript/event.ts";
import {
  ClaudeHookProvider,
  ensureSettingsJSONHooks,
  renderHookCommand,
  type HookContext,
  type HookProvider,
  type HookSpec,
  type ManagedHooks,
  type SettingsHookMatcher,
} from "../../hooks/index.ts";
import { GenericAdapter } from "../generic.ts";
import type {
  Adapter,
  Event,
  InputOption,
  InputRequest,
  Turn,
} from "../types.ts";
import {
  Errored,
  InputRequested,
  InputResolved,
  TurnComplete,
} from "../types.ts";

const enc = new TextEncoder();

// thinkingRE matches the end-of-turn thinking-summary line, anchored to its own
// line so it does not mis-fire when the model echoes the marker shape in prose.
// The duration is one or more <number><unit> components (unit ∈ {h,m,s}).
const thinkingRE =
  /^[^\S\r\n]*(✻ \p{Lu}\p{L}+ for \d+[hms](?: \d+[hms])*)[^\S\r\n]*$/gmu;

// resumeRE matches the "claude --resume <uuid>" hint older Claude Code builds
// printed on exit. As of 2.1.201 no such hint is printed (graceful exit emits
// only terminal-mode teardown), so this raw-line capture is a legacy backstop:
// the session id is now pinned at launch via `--session-id` (see initSession).
const resumeRE =
  /claude --resume ([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/;

// interruptMarker is the literal text after the user interrupts a reply.
// Note the NBSP (U+00A0) between the two spaces — matched exactly.
const interruptMarker = "⎿  Interrupted · What should Claude do instead?";

// Blocking-dialog anchors.
const trustAnchor = "Do you trust the files in this folder?";
const trustAnchorAlt = "Is this a project you created or one you trust?";
const bypassAnchor = "Bypass Permissions mode";

// AskUserQuestion dialog anchors (verified live against 2.1.210). The dialog
// renders a tab-strip line ("☐ Color", or "←  ☒ Color  ☐ Size  ✔ Submit  →"
// for multi-question/multi-select), the question text, a numbered option menu,
// and a footer. The footer is the question pane's required anchor; the review
// pane (after the last question) has no such footer and anchors on its own
// confirmation line instead.
const questionFooterAnchor = "Enter to select ·";
const questionReviewAnchor = "Ready to submit your answers?";
const questionSubmitTab = "✔ Submit";
// The UI-injected free-text escape hatch ("Type something." single-select,
// "Type something" checkbox row in multi-select). Selecting it declines the
// structured question and returns control to the composer.
const questionOtherLabel = "Type something";
// The UI-injected "Chat about this" affordance below the option rule.
const questionChatLabel = "Chat about this";

// questionTabRE matches the dialog's tab-strip line: optional "←", then a
// ☐/☒ checkbox glyph starting the first tab entry. Checkbox glyphs also occur
// in rendered to-do lists inside replies, so the tab line alone is never
// treated as a dialog — DetectQuestion additionally requires the footer (or
// the review anchor) below it.
const questionTabRE = /^[^\S\r\n]*(?:←[^\S\r\n]+)?[☐☒][^\S\r\n]/u;
// questionOptionRE matches one option row: optional "❯" highlight, a number,
// then the label ("❯ 1. Red", "  2. [ ] Mushrooms").
const questionOptionRE =
  /^[^\S\r\n]*(?:❯[^\S\r\n]+)?(\d+)\.[^\S\n]+(\S[^\n]*)$/u;
// questionCheckboxRE strips the multi-select checkbox marker off a label.
const questionCheckboxRE = /^\[[^\]]*\][^\S\n]+/u;

// menuRE matches a numbered menu item line, e.g. "❯ 1. Yes, proceed".
const menuRE = /^[^\dA-Za-z\n]*(\d)\.[^\S\n]+(\S[^\n]*)$/gm;

// bulletRE matches the start of a rendered assistant/tool message ("⏺ <text>").
const bulletRE = /^[^\S\r\n]*⏺ (.*)$/u;
// toolResultRE matches a tool-result continuation line ("⎿").
const toolResultRE = /^[^\S\r\n]*⎿/u;
// boxOrRuleRE matches a horizontal rule / box border line.
const boxOrRuleRE = /^[^\S\r\n]*[─━╭╮╰╯│┌┐└┘]/u;

// busyMarker is shown ONLY while a turn is in flight.
const busyMarker = "esc to interrupt";

// workingRE matches Claude Code's in-progress spinner line by its structural
// signature: an ellipsis, a parenthesized elapsed duration, then " · ".
const workingRE = /(?:…|\.\.\.)[^\S\r\n]*\(\d+[hms][^)\r\n]*·/u;

// quitCommand is "/quit" + Claude's enhanced Enter (CSI 13 u).
const quitCommand = enc.encode("/quit\x1b[13u");

// permissionCycleCommand is Shift+Tab as legacy CSI Z (back-tab) — one press
// advances the permission-mode footer by exactly one rung.
//
// CAPTURED LIVE against claude-code 2.1.218 (test/corpus/claude-code/
// permission-mode-cycle), NOT assumed. Claude Code enables the kitty keyboard
// protocol (which is why the submit key above is CSI 13 u and not \r), so the
// kitty encoding "\x1b[9;2u" was probed alongside CSI Z: BOTH advance the ring
// by exactly one rung, so the choice is ours. CSI Z wins because it is the
// legacy back-tab every TUI key parser understands whether or not the kitty
// protocol has been negotiated at that moment — we write raw bytes into a PTY
// rather than acting as a terminal, so the wider-compatibility encoding is
// strictly safer. The alternative stays recorded in the fixture notes.
const permissionCycleCommand = enc.encode("\x1b[Z");

/** Adapter implements turns.Adapter for Claude Code. */
export class ClaudeCodeAdapter extends GenericAdapter implements Adapter {
  /** Overrides ~/.claude/projects for the on-disk transcript reader. */
  projectsRoot = "";

  /**
   * Absolute path to the Node binary the installed hook commands launch under.
   * Empty means "resolve at ensure time" (defaults to process.execPath). Set by
   * tests (or a packaging layer) to pin a specific interpreter.
   */
  nodePath = "";

  /**
   * Absolute path to the committed `dist` directory holding `cli/hooks.js`, the
   * hook entrypoint. Empty means "resolve relative to this module". Set by tests
   * to point at a fixture dist.
   */
  distDir = "";

  private lastFingerprint = "";
  private lastInterruptSeen = false;
  private lastInputID = "";
  private lastInput: InputRequest | null = null;

  override name(): string {
    return "claude-code";
  }

  /**
   * Implements turns.StreamInterleaved. Claude Code drives the interactive TUI
   * exclusively and exposes no interleaved stream-json surface, so it is not
   * Stream-eligible in A1 and does not implement StreamParser.parseStreamLine.
   * The Stream branch is scaffolding lit up by a later interleaving adapter.
   */
  streamInterleaved(): boolean {
    return false;
  }

  override onScreen(snap: Snapshot): Event[] {
    const out: Event[] = [];

    // Interrupt detection — transition not-seen → seen.
    const interruptNow = snap.text.includes(interruptMarker);
    if (interruptNow && !this.lastInterruptSeen) {
      out.push({ kind: Errored, reason: "claude-code: " + interruptMarker });
    }
    this.lastInterruptSeen = interruptNow;

    // Turn-complete detection — newest thinking marker differs from last fired.
    // Gated on Busy(): an intermediate marker (still working) must not complete.
    const matches = [...snap.text.matchAll(thinkingRE)];
    if (matches.length > 0 && !this.busy(snap)) {
      const latest = matches[matches.length - 1][1];
      if (latest !== this.lastFingerprint) {
        this.lastFingerprint = latest;
        out.push({ kind: TurnComplete, reason: "claude-code: " + latest });
      }
    }

    // Blocking interactive prompt — transition on the request ID. A DIFFERENT
    // request replacing the current one (the next question of a multi-question
    // dialog, or its review pane) resolves the old before surfacing the new.
    const req = DetectInput(snap.text);
    if (req) {
      if (req.id !== this.lastInputID) {
        if (this.lastInputID !== "" && this.lastInput) {
          out.push({
            kind: InputResolved,
            reason: "claude-code: input superseded",
            input: this.lastInput,
          });
        }
        this.lastInputID = req.id;
        this.lastInput = req;
        out.push({
          kind: InputRequested,
          reason: "claude-code: " + req.prompt,
          input: req,
        });
      }
    } else if (this.lastInputID !== "") {
      const resolved = this.lastInput ?? {
        id: this.lastInputID,
        kind: "",
        prompt: "",
      };
      this.lastInputID = "";
      this.lastInput = null;
      out.push({
        kind: InputResolved,
        reason: "claude-code: input resolved",
        input: resolved,
      });
    }

    return out;
  }

  /** Implements turns.MessageExtractor. */
  extractMessage(snap: Snapshot): [string, boolean] {
    const lines = snap.text.split("\n");

    // Scope to the most-recently-completed turn: its "✻ … for Ns" footer is the
    // lower bound. The final assistant message is the last "⏺" block above it.
    let limit = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (matchLine(thinkingRE, lines[i])) limit = i;
    }

    let start = -1;
    for (let i = 0; i < limit; i++) {
      if (bulletRE.test(lines[i])) start = i;
    }
    if (start < 0) {
      for (let i = 0; i < lines.length; i++) {
        if (bulletRE.test(lines[i])) start = i;
      }
    }
    if (start < 0) return ["", false];

    const m = bulletRE.exec(lines[start])!;
    const block: string[] = [trimRight(m[1], " ")];

    // Consume indented continuation lines until a boundary.
    for (let i = start + 1; i < lines.length; i++) {
      const ln = lines[i];
      if (bulletRE.test(ln) || toolResultRE.test(ln) || boxOrRuleRE.test(ln)) {
        break;
      }
      if (matchLine(thinkingRE, ln)) break;
      if (trimLeft(ln, " ").startsWith("❯")) break;
      if (ln.trim() === "") {
        // A blank line is a paragraph break within the message, not its end.
        block.push("");
        continue;
      }
      block.push(trimRight(ln, " "));
    }
    // Drop trailing blank lines.
    while (block.length > 1 && block[block.length - 1].trim() === "") {
      block.pop();
    }

    let msg = block[0];
    if (block.length > 1) {
      const tail = dedent(block.slice(1));
      if (tail !== "") msg += "\n" + tail;
    }
    if (msg.trim() === "") return ["", false];
    return [msg, true];
  }

  /** Implements turns.BusyDetector. */
  busy(snap: Snapshot): boolean {
    return snap.text.includes(busyMarker) || workingRE.test(snap.text);
  }

  /**
   * Implements turns.SwallowedPromptDetector. True when a settled screen shows
   * no trace of assistant activity for the in-flight turn: no "⏺" message
   * bullet (extractMessage fails) and either the screen is byte-identical to
   * the one the prompt was submitted on, or it carries no "✻ … for Ns"
   * thinking marker anywhere — i.e. Claude Code never accepted the prompt and
   * merely repainted its ready screen (observed live on 2.1.201).
   */
  promptNotAccepted(snap: Snapshot, sentScreenText: string): boolean {
    const [, ok] = this.extractMessage(snap);
    if (ok) return false;
    if (snap.text === sentScreenText) return true;
    return [...snap.text.matchAll(thinkingRE)].length === 0;
  }

  /** Implements turns.Quitter. */
  quitSequence(): Uint8Array {
    return quitCommand;
  }

  /**
   * Implements turns.PermissionModeCycler — one Shift+Tab press advances the
   * permission-mode ring by exactly one rung.
   *
   * The measured ring is 4 long launched normally (auto → manual → accept edits
   * → plan → auto) and 5 when launched with a bypass-enabling flag, where
   * `bypass permissions` joins it. Deliberately NOT encoded here: no code may
   * depend on either number, so callers terminate by lap detection with a flat
   * backstop. The measurement lives in the fixture notes as corroboration only.
   */
  permissionCycleKeys(): Uint8Array {
    return permissionCycleCommand;
  }

  /** Implements turns.SessionInitializer — `claude --session-id <uuid>`. */
  initSession(): [string[], string] {
    const id = randomUUID();
    return [["--session-id", id], id];
  }

  /** Implements turns.SessionResumer — `claude --resume <uuid>`. */
  resumeArgs(harnessSessionID: string): string[] {
    return ["--resume", harnessSessionID];
  }

  /** Implements turns.SessionControlFlags — flags chat manages, banned from args. */
  sessionControlFlags(): string[] {
    return [
      "--session-id",
      "-r",
      "--resume",
      "-c",
      "--continue",
      "--fork-session",
      "--from-pr",
      "--no-session-persistence",
    ];
  }

  /** Implements turns.RawSessionIDExtractor. */
  extractSessionIDFromLine(line: string): [string, boolean] {
    const m = resumeRE.exec(line);
    if (!m) return ["", false];
    return [m[1], true];
  }

  /** Implements turns.TranscriptReader — reads the on-disk Claude Code log. */
  readTranscript(harnessSessionID: string, workingDir: string): Turn[] {
    const evs = new ClaudeCodeReader(this.projectsRoot).read(
      harnessSessionID,
      workingDir,
    );
    return turnsFromEvents(evs);
  }

  /**
   * Implements turns.HookProviderCapability. Returns a HookProvider that:
   *   - ensureConfig: resolves the Claude static hook spec (from provider-parse)
   *     and installs/rewrites it in settings.json using the config-install
   *     primitives — idempotent and co-tenant-safe under the O_EXCL lock.
   *   - parsePayload: delegates to the Claude provider's payload parser.
   * Only the Claude adapter implements this; codex/opencode/pi/generic omit it.
   */
  hookProvider(): HookProvider {
    const delegate = new ClaudeHookProvider();
    const nodePath = this.nodePath !== "" ? this.nodePath : process.execPath;
    const distDir = this.distDir !== "" ? this.distDir : defaultDistDir();
    return {
      ensureConfig(ctx: HookContext): HookSpec {
        const spec = delegate.ensureConfig(ctx);
        ensureSettingsJSONHooks(
          spec.configPath,
          managedHooksFromSpec(spec, nodePath, distDir),
        );
        return renderedSpec(spec, nodePath, distDir);
      },
      parsePayload(raw, ctx) {
        return delegate.parsePayload(raw, ctx);
      },
    };
  }
}

/**
 * defaultDistDir resolves the committed `dist` directory relative to this
 * module. Compiled, this file lives at `dist/turns/harness/claudecode.js`, so
 * the `dist` root is two levels up from its directory.
 */
function defaultDistDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * managedHooksFromSpec turns a resolved HookSpec into the ManagedHooks the
 * settings.json editor installs: each hook entry becomes a marker-tagged
 * command (rendered via renderHookCommand) under its event, preserving the
 * entry's tool matcher when present. The marker is what makes a re-ensure
 * rewrite exactly our own block and leave co-tenant blocks intact.
 */
function managedHooksFromSpec(
  spec: HookSpec,
  nodePath: string,
  distDir: string,
): ManagedHooks {
  const managed: ManagedHooks = {};
  for (const entry of spec.events) {
    const command = renderHookCommand({
      nodePath,
      distDir,
      event: entry.event,
    });
    const matcher: SettingsHookMatcher = {
      ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
      hooks: [{ type: "command", command }],
    };
    (managed[entry.event] ??= []).push(matcher);
  }
  return managed;
}

/**
 * renderedSpec returns a copy of the spec whose entry commands are the actual
 * marker-tagged commands installed on disk, so callers see what was written
 * rather than the provider's abstract placeholder commands.
 */
function renderedSpec(
  spec: HookSpec,
  nodePath: string,
  distDir: string,
): HookSpec {
  return {
    ...spec,
    events: spec.events.map((entry) => ({
      ...entry,
      command: renderHookCommand({ nodePath, distDir, event: entry.event }),
    })),
  };
}

/** Constructs a Claude Code adapter. */
export function New(): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter();
}

/**
 * DetectInput recognizes a blocking interactive dialog in the rendered screen
 * text and returns the structured request, or null when none is present.
 * Startup dialogs (trust/bypass) win over question dialogs; the two cannot
 * render simultaneously.
 */
export function DetectInput(text: string): InputRequest | null {
  let prompt: string;
  if (text.includes(trustAnchor)) prompt = trustAnchor;
  else if (text.includes(trustAnchorAlt)) prompt = trustAnchorAlt;
  else if (text.includes(bypassAnchor)) prompt = bypassAnchor;
  else return DetectQuestion(text);

  const opts = parseMenuOptions(text);
  if (opts.length === 0) return null; // anchor visible but menu not rendered yet
  const req: InputRequest = {
    id: "",
    kind: "trust_prompt",
    prompt,
    options: opts,
  };
  req.id = inputID(req);
  return req;
}

/**
 * DetectQuestion recognizes the AskUserQuestion dialog Claude Code renders
 * when the model asks the user a clarifying question mid-turn (verified live
 * against 2.1.210). Two panes exist:
 *
 *   - a QUESTION pane (kind "question"): tab-strip line, question text,
 *     numbered options, "Enter to select ·…" footer. Digit keys select an
 *     option directly (single-select) or toggle its checkbox (multi-select).
 *   - a REVIEW pane (kind "question_review"): after the last question of a
 *     multi-question or multi-select dialog — an answers summary plus a
 *     "Ready to submit your answers?" Submit/Cancel menu, no select footer.
 *
 * Returns null when neither pane is fully rendered. While either pane is up
 * the harness is idle-but-not-ready: no busy marker, no end-of-turn marker,
 * no empty composer — without this detection the turn would hang silently.
 */
export function DetectQuestion(text: string): InputRequest | null {
  const lines = text.split("\n");

  // The tab-strip line is the dialog's top edge; the dialog sits below any
  // reply content, so the LAST match wins. Checkbox glyphs also appear in
  // rendered to-do lists, so the tab line alone is never sufficient.
  let tabIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (questionTabRE.test(lines[i])) tabIdx = i;
  }
  if (tabIdx < 0) return null;
  const tabLine = lines[tabIdx];

  // Review pane: Submit tab + confirmation anchor below the tab line.
  if (tabLine.includes(questionSubmitTab)) {
    let anchorIdx = -1;
    for (let i = tabIdx + 1; i < lines.length; i++) {
      if (lines[i].includes(questionReviewAnchor)) anchorIdx = i;
    }
    if (anchorIdx >= 0) {
      const parsed = parseQuestionRegion(lines, anchorIdx + 1, lines.length);
      if (parsed.options.length === 0) return null; // menu not rendered yet
      const body = lines
        .slice(tabIdx + 1, anchorIdx + 1)
        .map((ln) => ln.trim())
        .filter((ln) => ln !== "" && !boxOrRuleRE.test(ln))
        .join("\n");
      const req: InputRequest = {
        id: "",
        kind: "question_review",
        prompt: body,
        options: parsed.options.map((o) => ({
          id: o.id,
          alias: reviewAlias(o.label),
          label: o.label,
          // Digit selects on this widget; the trailing CR is a no-op backstop
          // for a build where the digit only moves the highlight. After the
          // review pane the dialog is gone, so a stray CR cannot mis-select.
          keys: enc.encode(o.id + "\r"),
          ...(o.description !== "" ? { description: o.description } : {}),
        })),
      };
      req.id = inputID(req);
      return req;
    }
    // No review anchor: an unanswered question pane also carries the Submit
    // tab (multi-question / multi-select) — fall through to the question path.
  }

  // Question pane: footer required below the tab line.
  let footerIdx = -1;
  for (let i = tabIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith(questionFooterAnchor)) footerIdx = i;
  }
  if (footerIdx < 0) return null;

  const parsed = parseQuestionRegion(lines, tabIdx + 1, footerIdx);
  if (parsed.options.length === 0 || parsed.preamble === "") return null;

  const multiSelect = parsed.multiSelect;
  const req: InputRequest = {
    id: "",
    kind: "question",
    prompt: parsed.preamble,
    options: parsed.options.map((o) => {
      const other =
        o.label === questionOtherLabel || o.label === questionOtherLabel + ".";
      const chat = o.label === questionChatLabel;
      let keys: string;
      if (multiSelect) {
        keys = o.id; // digit toggles the checkbox row
      } else if (other || chat) {
        // UI affordances: the digit only moves the highlight onto them, so a
        // CR is required to select. Both close the whole dialog, so the CR
        // can never leak into a subsequent question pane.
        keys = o.id + "\r";
      } else {
        // Digit selects directly. NO trailing CR: in a multi-question dialog
        // selection advances to the next question, where a stray CR would
        // select that question's highlighted option.
        keys = o.id;
      }
      return {
        id: o.id,
        alias: other ? "other" : chat ? "" : aliasForLabel(o.label),
        label: o.label,
        keys: enc.encode(keys),
        ...(o.description !== "" ? { description: o.description } : {}),
      };
    }),
  };
  const header = questionHeader(tabLine);
  if (header !== "") req.header = header;
  if (multiSelect) {
    req.multiSelect = true;
    req.submitKeys = enc.encode("\t"); // Tab jumps to the review pane
  }
  req.id = inputID(req);
  return req;
}

interface ParsedQuestionRegion {
  /** Non-blank lines before the first option row (the question text). */
  preamble: string;
  options: { id: string; label: string; description: string }[];
  /** True when any option row carried a "[ ]"/"[✔]" checkbox marker. */
  multiSelect: boolean;
}

/** Parses the dialog region [from, to): question text, options, descriptions. */
function parseQuestionRegion(
  lines: string[],
  from: number,
  to: number,
): ParsedQuestionRegion {
  const preamble: string[] = [];
  const options: { id: string; label: string; description: string }[] = [];
  let multiSelect = false;
  const seen = new Set<string>();

  for (let i = from; i < to && i < lines.length; i++) {
    const ln = lines[i];
    const trimmed = ln.trim();
    if (trimmed === "" || boxOrRuleRE.test(ln)) continue;
    // The multi-select widget renders its commit row as a bare "Submit" line
    // below the last option — widget chrome, not an option description.
    if (trimmed === "Submit") continue;

    const m = questionOptionRE.exec(ln);
    if (m) {
      const num = m[1];
      let label = cleanLabel(m[2]);
      if (questionCheckboxRE.test(label)) {
        multiSelect = true;
        label = label.replace(questionCheckboxRE, "").trim();
      }
      if (num === "0" || seen.has(num) || label === "") continue;
      seen.add(num);
      options.push({ id: num, label, description: "" });
      continue;
    }
    if (options.length === 0) {
      preamble.push(trimmed);
    } else {
      const cur = options[options.length - 1];
      cur.description =
        cur.description === "" ? trimmed : cur.description + " " + trimmed;
    }
  }
  return { preamble: preamble.join("\n"), options, multiSelect };
}

// questionTabEntryRE captures one "☐ <label>" tab entry; labels end at the
// next glyph or a multi-space gap.
const questionTabEntryRE =
  /([☐☒])[^\S\r\n]+([^☐☒✔←→\s](?:[^☐☒✔←→]*[^☐☒✔←→\s])?)/gu;

/** The active question's tab label: the first unanswered (☐) entry. */
function questionHeader(tabLine: string): string {
  let first = "";
  for (const m of tabLine.matchAll(questionTabEntryRE)) {
    const label = m[2].trim();
    if (first === "") first = label;
    if (m[1] === "☐") return label;
  }
  return first;
}

function reviewAlias(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("submit")) return "proceed";
  return aliasForLabel(label);
}

function parseMenuOptions(text: string): InputOption[] {
  const opts: InputOption[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(menuRE)) {
    const num = m[1];
    const label = cleanLabel(m[2]);
    if (num === "0" || seen.has(num) || label === "") continue;
    seen.add(num);
    opts.push({
      id: num,
      alias: aliasForLabel(label),
      label,
      keys: enc.encode(num + "\r"),
    });
  }
  return opts;
}

function cleanLabel(s: string): string {
  const i = s.indexOf("  ");
  if (i >= 0) s = s.slice(0, i);
  return s.trim();
}

function aliasForLabel(label: string): string {
  const l = label.toLowerCase();
  if (containsAny(l, "proceed", "accept", "trust", "yes", "continue")) {
    return "proceed";
  }
  if (
    containsAny(
      l,
      "exit",
      "deny",
      "reject",
      "cancel",
      "no,",
      "no ",
      "don't",
      "do not",
    )
  ) {
    return "deny";
  }
  return "";
}

function containsAny(s: string, ...subs: string[]): boolean {
  return subs.some((sub) => s.includes(sub));
}

function inputID(req: InputRequest): string {
  const parts = [
    req.kind,
    req.prompt,
    ...(req.options ?? []).map((o) => o.label),
  ];
  const sum = createHash("sha256").update(parts.join("\0")).digest();
  return sum.subarray(0, 8).toString("hex");
}

function dedent(lines: string[]): string {
  let minIndent = -1;
  for (const ln of lines) {
    if (ln.trim() === "") continue;
    const n = ln.length - trimLeft(ln, " ").length;
    if (minIndent < 0 || n < minIndent) minIndent = n;
  }
  if (minIndent <= 0) return trimRight(lines.join("\n"), "\n");
  const out = lines.map((ln) =>
    ln.length >= minIndent ? ln.slice(minIndent) : trimLeft(ln, " "),
  );
  return trimRight(out.join("\n"), "\n");
}

// matchLine tests a single line against a /g regex without leaking lastIndex.
function matchLine(re: RegExp, line: string): boolean {
  re.lastIndex = 0;
  const ok = re.test(line);
  re.lastIndex = 0;
  return ok;
}

function trimRight(s: string, cut: string): string {
  let end = s.length;
  while (end > 0 && cut.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

function trimLeft(s: string, cut: string): string {
  let start = 0;
  while (start < s.length && cut.includes(s[start])) start++;
  return s.slice(start);
}
