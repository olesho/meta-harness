# Adding a harness

Teaching meta-harness a new coding agent means touching several layers — but not all of
them, and not all at once. This guide is the map: what each layer needs, in what order, and
where the existing harnesses serve as templates. Unlike the other guides, most of this is
_editing the library's source_, not consuming its API.

The golden rule: **start generic, then enrich.** Any launchable CLI already runs as
[`generic`](../harnesses.md#the-generic-fallback) — supervised turns driven purely by
[wrapper status](../concepts.md#status). Each capability you add lights up one more feature.
Add them in the order below and you always have a working harness.

---

## 0. Run it as `generic` first

Before writing any code, confirm the CLI drives at all:

```ts
await runOneShot(ctx, {
  harness: "generic",
  binaryPath: "/path/to/newcli",
  prompt: "hello",
});
```

If that returns a reply, the PTY, screen, and status→turn mapping already work. Everything
from here is refinement.

---

## 1. Register it in the catalog & discovery

Add an [`Entry`](../modules/versions.md) to
[`src/versions/versions.json`](../../../src/versions/versions.json):

```jsonc
"newcli": { "package": "@vendor/newcli", "binary": "newcli", "pinned": "", "verified_at": "" }
```

Leave `pinned` empty until you've verified an upstream version. If `newcli --version` prints
a normal semver, the default [`SemverDashVProbe`](../modules/discovery.md#semverdashvprobe)
already covers it — register it next to the others in
[`src/discovery/probes.ts`](../../../src/discovery/probes.ts). Only write a custom
[`Probe`](../modules/discovery.md#probes) if the version output is unusual.

---

## 2. Give the wrapper a pattern set

Add `src/wrapper/internal/harness/newcli.ts` exporting the cost / retry / prompt (and
optionally API-error / session-limit) fingerprints, then wire the name into the resolver in
`src/wrapper/internal/classifier.ts`. Use
[`opencode.ts`](../../../src/wrapper/internal/harness/opencode.ts) (provider-agnostic, minimal)
or [`claude.ts`](../../../src/wrapper/internal/harness/claude.ts) (rich, with API-error and
session-limit matchers) as templates. This is what lets
[`classifyOutput("newcli", …)`](../modules/wrapper.md#classification) recognize the CLI's
rate-limit and error prose.

There are **three** launch knobs, one translator module each, every module named for what
it translates: reasoning effort →
[`src/wrapper/internal/effort.ts`](../../../src/wrapper/internal/effort.ts), model override →
[`src/wrapper/internal/model.ts`](../../../src/wrapper/internal/model.ts), permission mode →
[`src/wrapper/internal/permission.ts`](../../../src/wrapper/internal/permission.ts). Add a
translation to whichever ones the CLI supports.

`permission.ts` is the one whose accepted vocabulary is **per-harness** — the five rungs
(`plan`, `manual`, `ask`, `auto`, `bypass`, least to most permissive) plus whatever native
spellings that CLI takes on top. That is why `isSupportedPermissionMode(harness, mode)` takes
the harness where `isSupportedEffort(effort)` does not; the asymmetry is deliberate, since a
harness-blind predicate could only be the union of every harness's vocabulary. Register the
guard flags alongside the mapping: they suppress injection when the caller already pinned the
axis in `args`.

Each translator is total — a harness with no mapping returns `args` unchanged rather than
erroring **inside the translator**. That is a guarantee about the translator layer only: one
layer up, `validateConfig` still rejects a `Config` that sets `permissionMode` for such a
harness, the same way it rejects `effort`. See
[`wrapper` › Permission mode](../modules/wrapper.md#permission-mode).

---

## 3. Write a turns adapter

The heart of the work. Create `src/turns/harness/newcli.ts` — extending the
[`GenericAdapter`](../modules/turns.md#adapters) is the easy path — and export a `New()`
constructor. Then add its namespace to [`src/turns/index.ts`](../../../src/turns/index.ts) and
a case to [`chat.resolveAdapter`](../modules/chat.md#opening-a-conversation) in
`src/chat/conversation.ts`.

The **required** surface is three methods:

```ts
interface Adapter {
  name(): string; // "newcli"
  onScreen(snap: Snapshot): Event[]; // detect turn events from the screen
  onWrapperStatus(status: Status, reason: string): Event[]; // usually inherited from GenericAdapter
}
```

Then add [optional capabilities](../modules/turns.md#optional-capabilities) as the harness
supports them — each is just a method you define; chat probes for it structurally:

| Add this method                                                     | To get                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `extractSessionID` / `extractSessionIDFromLine` / `locateSessionID` | [Session-id capture](resuming-sessions.md#two-ids) (from screen / raw line / disk). |
| `primeSessionIDKeys`                                                | Keystrokes that surface the id (like Codex's `/status`).                            |
| `initSession`                                                       | Mint the id at launch (like pi's `--session-id`).                                   |
| `resumeArgs` (+ `resumeForksSessionID`, `sessionControlFlags`)      | [Resume](resuming-sessions.md).                                                     |
| `busy`                                                              | Turn-in-progress detection (gates premature completion).                            |
| `extractMessage`                                                    | Clean assistant-reply extraction from the TUI.                                      |
| `quitSequence`                                                      | Graceful [`quit()`](../modules/chat.md#sending--control).                           |
| `readTranscript`                                                    | [Transcript history](reading-history.md) (delegates to step 4).                     |

Study the closest existing adapter: [`pi.ts`](../../../src/turns/harness/pi.ts) for
session-control-heavy harnesses, [`codex.ts`](../../../src/turns/harness/codex.ts) for
screen-scraped session ids and startup interstitials,
[`claudecode.ts`](../../../src/turns/harness/claudecode.ts) for marker-based completion and
message extraction.

---

## 4. Add a transcript reader (optional)

If the harness writes an on-disk session log and you want authoritative
[history](reading-history.md), implement a [`Reader`](../modules/transcript.md#the-reader-interface)
under `src/transcript/newcli/` returning `Event[]`, and export it from
`src/transcript/index.ts`. Wire it into your adapter's `readTranscript`. The main work is
the _locate_ strategy — how a session id maps to a file path (see
[`encodedCWD`](../modules/transcript.md#claudecodereader) /
[`slugForCwd`](../modules/transcript.md#pireader) for the two existing shapes).

---

## 5. Handle readiness (if needed)

If the harness has a composer that must be _ready_ before keystrokes land, add its markers
to [`src/chat/ready.ts`](../../../src/chat/ready.ts) — `requiresPromptReadiness`,
`readyForInput`, and the correct `submitKeyForHarness`. Harnesses that accept input
immediately don't need this.

---

## 6. Record a corpus & test

The turn adapters are tested against **recorded PTY byte streams**, not live processes.
Capture a few scenarios (short reply, multi-turn, tool call, and adversarial
"must-not-fire" cases) into `test/corpus/newcli/<scenario>/` — see
[`test/corpus/README.md`](../../../test/corpus/README.md) for the layout — and add adapter
replay tests under `test/turns/newcli/`. Then run the gate:

```bash
npm test
```

Two suites will also nudge you: [`test/contract.test.ts`](../../../test/contract.test.ts)
fails until you regenerate the public-surface golden for your new exports
(`UPDATE_GOLDEN=1 npm test -- test/contract.test.ts`), and
[`test/exports-guard.test.ts`](../../../test/exports-guard.test.ts) fails if a public barrel
accidentally re-exports something internal.

---

## Checklist

- [ ] Runs as `generic`.
- [ ] `versions.json` entry + discovery probe.
- [ ] Wrapper pattern set wired into the classifier (+ the launch-knob translations the CLI
      supports, one module each in `src/wrapper/internal/`: `effort.ts`, `model.ts`,
      `permission.ts`).
- [ ] Permission-mode translation in `src/wrapper/internal/permission.ts` — the five rungs
      plus the guard flags — if the CLI has a launch-time permission axis. The translator
      no-ops for an unmapped harness; `validateConfig` still rejects one.
- [ ] Turns adapter: required core + the optional capabilities it supports; `New()`
      exported; `resolveAdapter` case added.
- [ ] Transcript reader (if it has a log).
- [ ] Readiness markers (if it has a composer).
- [ ] Corpus + replay tests; `npm test` green; golden regenerated.
- [ ] Once verified against a real upstream version, set `pinned` / `verified_at`.

The [Backend/Adapter seam](../architecture.md#the-backendadapter-seam) is what makes this
incremental: chat depends only on the optional methods you've implemented, so a
half-finished adapter is a fully-working (if less capable) harness.
