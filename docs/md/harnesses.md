# Harnesses

meta-harness supports five harnesses at varying depth. A harness is selected by its
short **name** string, which picks the [chat adapter](modules/turns.md), the
[wrapper classifier](modules/wrapper.md), and (where present) the
[transcript reader](modules/transcript.md).

Support is not uniform: some harnesses expose a rich TUI meta-harness can scrape for
session ids and turn boundaries; others are driven purely by their exit status. This page
is the ground truth for "what works with which."

---

## Support matrix

| Harness | name | binary | npm package | pinned¹ | chat adapter² | effort / model | transcript history³ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Claude Code** | `claude-code` | `claude` | `@anthropic-ai/claude-code` | 2.1.201 | ✓ full | ✓ / ✓ | ✓ `ClaudeCodeReader` |
| **Codex** | `codex` | `codex` | `@openai/codex` | 0.142.5 | ✓ full | ✓ / ✓ | ✓ `CodexReader` |
| **pi** | `pi` | `pi` | `@earendil-works/pi-coding-agent` | 0.76.0 | ✓ full | ✗ / ✗ | ✓ `PiReader`⁴ |
| **OpenCode** | `opencode` | `opencode` | `opencode-ai` | *(unpinned)* | ◑ stub | ✗ / ✗ | ✗ store only |
| **Cursor** | `cursor` | — | — | — | ✗ wrapper-only | ✗ / ✗ | ✗ n/a |
| *(fallback)* | `generic` / `""` | any | — | — | ◑ status-only | ✗ / ✗ | ✗ store only |

¹ From [`versions.json`](modules/versions.md); the upstream release each adapter is
verified against. ² Whether [`chat.resolveAdapter`](modules/chat.md#opening-a-conversation) maps the
name — a "full" adapter implements the session/interaction capabilities below. ³ Whether
[`historyWithSource()`](guides/reading-history.md) can serve
[`HistorySourceTranscript`](concepts.md#transcript-vs-store-history). ⁴ `PiReader.read`
returns the lossy `Turn[]` view directly, not `Event[]` like the other two readers.

### Capability detail (chat adapters)

| Capability | Claude Code | Codex | pi | OpenCode | generic |
| --- | :---: | :---: | :---: | :---: | :---: |
| Turn-complete from screen | ✓ marker | ✓ (legacy)⁵ | — | — | — |
| `BusyDetector` | ✓ | — | ✓ | — | — |
| `MessageExtractor` | ✓ | — | — | — | — |
| `Quitter` | ✓ | — | ✓ | — | — |
| session id: from screen (`SessionIDExtractor`) | — | ✓ | — | — | — |
| session id: from raw line (`RawSessionIDExtractor`) | ✓ | ✓ | — | — | — |
| session id: prime (`SessionIDPrimer`) | — | ✓ | — | — | — |
| `SessionInitializer` (mint id at launch) | — | — | ✓ | — | — |
| `SessionResumer` (resume args) | ✓ | ✓ | ✓ | — | — |
| `SessionForkResumer` | no-fork | ✓ (false)⁶ | no-fork | — | — |
| `TranscriptReader` | ✓ | ✓ | ✓ | — | — |
| Startup interstitial auto-dismiss | — | ✓⁷ | — | — | — |
| Input requests detected | ✓ `trust_prompt` · `question` · `question_review` | ✓ `approval_prompt`⁸ | — | — | — |

⁵ Codex ≤ 0.141 emitted a "Token usage:" footer chat could scrape; 0.142+ has no screen
signal, so completion falls back to [status-driven mapping](#the-generic-fallback).
⁶ Codex explicitly reports `resumeForksSessionID() === false` — verified against
codex-cli 0.142.5, resume continues the *same* id. ⁷ Codex's "Update available!",
model-migration, and "Press enter to continue" interstitials are auto-dismissed at
startup unless [`disableCodexAutoDismiss`](modules/chat.md#options) is set.
⁸ Codex's command / apply-patch approval dialogs surface as `approval_prompt`
[input requests](guides/handling-input.md#approval-prompts-approval_prompt); its startup
interstitials (footnote ⁷) are auto-dismissed rather than surfaced.

---

## Claude Code

The most fully-supported harness. Name `claude-code`, binary `claude`.

- **Turn detection.** Completion is detected from the thinking-summary marker
  (`✻ <verb> for Ns`), gated on the busy detector so intermediate markers don't fire
  early; chat then defers to an [idle/marker window](concepts.md#quiescence--idle-completion)
  before finalizing. Interrupts (`⎿ Interrupted · What should Claude do instead?`) map to
  `Errored`.
- **Session id.** Minted by chat at launch: `initSession()` (`SessionInitializer`)
  returns `--session-id <uuid>` and the id itself, so the id is known (and persisted)
  before the child even starts. The raw `claude --resume <uuid>` hint capture
  (`RawSessionIDExtractor`) remains as a legacy backstop for older builds — Claude Code
  2.1.201 no longer prints the hint on exit.
- **Resume.** `--resume <uuid>`; does not fork the id.
- **Session-control flags.** `sessionControlFlags()` lists the flags chat manages
  internally (`--session-id`, `-r`, `--resume`, `-c`, `--continue`, `--fork-session`,
  `--from-pr`, `--no-session-persistence`); chat bans them from your `args`.
- **History.** [`ClaudeCodeReader`](modules/transcript.md#claudecodereader) reads
  `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl` (tool-aware, returns `Event[]`).
- **Interactive prompts.** Folder-trust / "bypass permissions" dialogs are detected as
  `trust_prompt` input requests — the [one-shot loop](modules/oneshot.md) auto-accepts
  them via `AutoAcceptTrust`. The mid-turn `AskUserQuestion` dialog (shapes verified
  live on 2.1.210) is detected as `question` / `question_review` requests — single- and
  multi-question, multi-select, with the UI's free-text ("Type something.", alias
  `other`) and "Chat about this" affordances parsed as options. Selection mechanics are
  encoded in the option `keys`: a bare digit selects (or toggles, for multi-select;
  `submitKeys` = Tab commits), while the two UI affordances need digit+CR. See
  [Guides › Handling input](guides/handling-input.md#clarifying-questions-question--question_review).
- **Wrapper patterns.** Rich: API-error lines (with tree-glyph prefixes), session-limit
  banners (`… resets HH:MM (TZ)` → a `resumeAt` instant), plus cost/retry/prompt
  fingerprints.
- **Effort / model.** `--effort <level>` and `--model <m>`.

---

## Codex

Name `codex`, binary `codex`.

- **Turn detection.** On 0.142+ there is no screen-side completion marker; the turn
  completes via the [status-driven](#the-generic-fallback) path and idle settling. (The
  ≤ 0.141 "Token usage:" footer is still recognized for older builds.)
- **Session id.** Two paths: scraped from the `│ Session: <uuid> │` row of the `/status`
  box (`SessionIDExtractor`, gated on the box header to resist spoofing), and from a
  `codex resume <uuid>` hint (`RawSessionIDExtractor`). chat *primes* the id at startup by
  writing `/status` (`SessionIDPrimer`) — this needs a terminal ≥ ~60 columns.
- **Resume.** `resume <uuid>`; reports `resumeForksSessionID() === false`.
- **History.** [`CodexReader`](modules/transcript.md#codexreader) reads
  `~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl` (returns `Event[]`; `workingDir`
  is ignored — sessions are located by id).
- **Startup interstitials.** "Update available!", the model-migration prompt, and
  "Press enter to continue" are auto-dismissed with safe keystrokes.
- **Interactive prompts.** The command / apply-patch approval dialogs ("Would you like
  to run the following command?" / "Would you like to make the following edits?") are
  detected as `approval_prompt` input requests — numbered options with `proceed`/`deny`
  aliases, so a policy or client can approve or reject. Detection is checked *before*
  the interstitial anchors, so an approval dialog whose body quotes an interstitial
  phrase is never auto-dismissed (auto-approved) by mistake. The [one-shot
  loop](modules/oneshot.md) ships no policy for these — see its caveat. See
  [Guides › Handling input](guides/handling-input.md#approval-prompts-approval_prompt).
- **Wrapper patterns.** API-error phrase hints ("at capacity" → 503, "high demand" →
  500, "usage limit"/"out of credits" → 429, "stream disconnected" → 0) plus
  cost/retry/prompt. No session-limit banner matcher.
- **Effort / model.** `-c model_reasoning_effort="…"` (with `max → xhigh`) and
  `-c model="…"`.

---

## pi

Name `pi`, binary `pi`. Session control is the strong suit; screen scraping is minimal.

- **Session id.** pi is the one harness where chat **mints** the id at launch:
  `initSession()` (`SessionInitializer`) returns `--session-id <uuid>` and the id itself.
- **Resume.** `--session <id>` (`SessionResumer`); does not fork.
- **Session-control flags.** `sessionControlFlags()` lists the flags pi manages
  internally (`--session`, `--session-id`, `--fork`, `-c`, `--continue`, `-r`,
  `--resume`, `--no-session`, `--session-dir`); chat bans them from your `args`.
- **Launch binding.** `bindLaunchEnv(env, workingDir)` is called once at `Open` so the
  adapter can pin where it reads its session log from (honoring
  `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR` / `~/.pi/agent`).
- **History.** [`PiReader`](modules/transcript.md#pireader) reads
  `<config>/sessions/--<cwd-slug>--/<ts>_<uuid>.jsonl` and returns **`Turn[]`** directly.
- **Turn detection.** No screen completion marker; `BusyDetector` recognizes
  `Working…`/`Thinking…`. `Quitter` sends `/quit`.
- **Effort / model.** Not supported.

---

## OpenCode

Name `opencode`, binary `opencode`. A **minimal stub** ahead of a recorded corpus: the
adapter implements none of the optional capabilities, so it behaves like the
[generic fallback](#the-generic-fallback) — turns complete via wrapper status, there is
no session-id capture, no resume, and history is always store-backed. The wrapper still
classifies its output (provider-agnostic cost/retry/prompt patterns). Not yet pinned in
`versions.json`.

---

## Cursor

Name `cursor`. Cursor is recognized **only at the wrapper-classification layer** — it has
a pattern set (cost/retry/prompt, no API-error matcher) so
[`wrapper.run`](modules/wrapper.md) / [`classifyOutput`](modules/wrapper.md) can classify
a Cursor run. It has **no chat adapter** (`chat.resolveAdapter("cursor")` throws
`ErrUnknownHarness`), no transcript reader, and no `versions.json` entry. Use it when you
want classification of a Cursor process, not a `Conversation`.

---

## The generic fallback

Name `generic` (or `""`). The floor every harness stands on: the
[`GenericAdapter`](modules/turns.md) implements no screen scraping and maps
[wrapper `Status`](concepts.md#status) straight to turn events —
`waiting_for_input → TurnComplete`, `blocked_by_cost`/`retry_later`/`api_error →
Blocked`, `failed`/`interrupted`/`idle → Errored`. Any launchable CLI can be driven as
`generic`; you lose session capture, resume, message extraction, and transcript history,
but you still get supervised turns with a normalized status.

---

## Checking availability at runtime

Use [`discovery`](modules/discovery.md) to see what's installed and whether it matches
the pin:

```ts
import { lookup, discover } from "meta-harness/discovery"

lookup("claude-code")
// → { installed: true, path: "/usr/local/bin/claude",
//     pinnedVersion: "2.1.201", detectedVersion: "2.1.201",
//     versionMatchesPin: true, … }

discover()   // Info[] for every harness in versions.json
```

Default version probes are registered for `codex`, `claude-code`, `opencode`, and `pi`.
See [Concepts › Effort & model](concepts.md#effort--model) and the
[versions catalog](modules/versions.md) for how pins bind adapter code to upstream
releases.
