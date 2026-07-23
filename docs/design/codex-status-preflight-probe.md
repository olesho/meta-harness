# codex `/status` pre-flight probe — the `Permissions:` row is present (META-HARNESS-155)

**Status:** settled · 2026-07-23 · probed live against the installed binary, recorded here so it is
not re-derived. **This is the write-back text for META-HARNESS-99, META-HARNESS-102 and
META-HARNESS-131.** Each of §3, §4 and §5 is addressed to one of them.
**Scope:** whether codex's `/status` box actually carries a `Permissions:` row, what the full row
set is, and what a live conformance assertion may and may not anchor on. **This ticket deliberately
does not touch `test/conformance.test.ts`** — a sibling subtask owns that file; this note is the
input it needs so it does not have to re-probe.
**Related:** META-HARNESS-99 (epic) · META-HARNESS-102 (value→rung mapping) · META-HARNESS-131
(gated live conformance, parent) · `docs/design/codex-status-ground-truth.md` (META-HARNESS-110, the
frozen table) · `test/corpus/codex/status-box/` (this probe's fixture) ·
`src/chat/permission.ts` · `src/chat/conversation.ts` (`primeSessionID`,
`captureModeFromScreen`) · `src/wrapper/internal/permissionrungs.ts` (`codexPairRung`).

---

## 1. What was probed, and how

**codex-cli 0.144.5, macOS, 120x40, 2026-07-23.** Three launches, driven through the **production
seam** — `chat.Open` (`src/chat/conversation.ts`), whose `primeSessionID` writes
`CodexAdapter.primeSessionIDKeys()` (literally `/status` + CSI 13u,
`src/turns/harness/codex.ts`) **before `Open` returns**, gated on
`cols >= CODEX_STATUS_MIN_COLS`. The probe is therefore a `conv.screenSnapshot()` read immediately
after `Open`, then `close()`. No prompt was sent; no tmux; no new driver.

`CODEX_HOME` was **isolated** per launch: a fresh `mkdtemp` dir with **only** `~/.codex/auth.json`
copied in — never `config.toml`, so the reading reflects the launch flags rather than the
developer's own approval settings. This is the same discipline the META-HARNESS-110 recordings
record in their `meta.json`. `HOME` isolation was not attempted (a fresh `HOME` lands on the
onboarding wall). All three isolated launches were stable; no fallback to the real `CODEX_HOME` was
needed.

**`/permissions` was never opened and no preset was ever selected** — selecting one writes
`~/.codex/config.toml` globally. Reading `/status` is safe; selecting is not.

## 2. The finding

**The epic's premise is refuted. `Permissions:` IS a `/status` row label on 0.144.5.**

The row labels actually rendered, top to bottom:

| # | label                 | value in this probe (flagless)                            |
| - | --------------------- | --------------------------------------------------------- |
| 1 | `Model:`              | `gpt-5.6-sol (reasoning low, summaries auto)`              |
| 2 | `Directory:`          | the cwd (**not stable — never anchor on it**)              |
| 3 | `Permissions:`        | **`Workspace (Ask for approval)`**                         |
| 4 | `Agents.md:`          | `<none>`                                                   |
| 5 | `Account:`            | the login (redacted in the fixture)                        |
| 6 | `Collaboration mode:` | **`Default`**                                              |
| 7 | `Session:`            | the session UUID                                           |
| 8 | `Weekly limit:`       | a usage meter — **or** `Limits:` (**not stable**, see §6)  |

Per launch:

| launch                              | `Permissions:` row | rendered value                 | parsed rung   |
| ----------------------------------- | ------------------ | ------------------------------ | ------------- |
| _(no permission flags)_             | **present**        | `Workspace (Ask for approval)` | `acceptEdits` |
| `-s workspace-write -a on-request`  | **present**        | `Workspace (Ask for approval)` | `acceptEdits` |
| `-s read-only -a never`             | **present**        | `Read Only (never)`            | `plan`        |

The first two are byte-identical because `-s workspace-write -a on-request` **is** codex's default
posture — that pair alone proves nothing about whether the row tracks the launch. The third launch
was added for exactly that reason and settles it: **the row does track launch posture.**

`primeSessionID` recorded outcome **`captured`** on all three launches (read via the same structural
escape `test/chat/codex_prime_sessionid.test.ts` uses).

**Where the epic's row-label run came from.** The strings scanned out of the native binary
(`Model provider · Account · Thread name · Session · Forked from · Collaboration mode · Token usage ·
Context window`) do exist in `@openai/codex-darwin-arm64`, but they are **not this box's labels**. A
static string scan cannot tell which run a given screen assembles; only a live render can. The
row set in the table above is what 0.144.5 renders.

## 3. Write-back for META-HARNESS-99 — the ground-truth table

The epic's row `Permissions: Workspace (Ask for approval)` is **correct and confirmed**, not stale,
not feature-flagged, and not conditional on a non-default profile. It renders on a **flagless**
launch, which is the strongest form of the claim.

The epic's ground-truth table should read as the eight-row set in §2 above, with `Directory:` and
the trailing limits row flagged as unstable (§6). The frozen `Permissions:` value→rung mapping is
unchanged and lives in `docs/design/codex-status-ground-truth.md` §2; this probe adds one row to
it — the flagless launch — now recorded in that file.

## 4. Write-back for META-HARNESS-102 — the value→rung mapping table

**The `Permissions:` row that META-HARNESS-102's mapping table is built on is present. Nothing in
that table needs to be withdrawn.** The three values this probe observed
(`Workspace (Ask for approval)`, `Read Only (never)`) already appear in it and parsed to the
expected rungs (`acceptEdits`, `plan`) through `parsePermissionMode` in `src/chat/permission.ts`.

**Fixture ownership.** `test/corpus/codex/status-box/` — the corpus's first *flagless* `/status`
capture — is owned by **META-HARNESS-155**, not META-HARNESS-102. The parent ticket's text was
ambiguous about which subtask owed it; ownership is assigned here and recorded in the fixture's
`meta.json` notes.

## 5. Write-back for META-HARNESS-131 — what the live assertion may anchor on

The sibling subtask writing the `/status` conformance assertion can act on this without re-probing.

**Anchor on the `Permissions:` value.** It is present, it is stable across runs, and it tracks the
launch posture. `Collaboration mode:` is a valid second anchor **only** when read off a settled
frame (see the latch caveat below).

**Do NOT anchor on:** `Directory:` (cwd-dependent), the trailing limits row (`Weekly limit:` vs
`Limits: refresh requested; run /status again shortly.` — both observed on the same day), `Model:`
(model name and reasoning effort drift), or `Account:` (per-operator).

**Latch caveat — do not assert `collaboration` off a freshly-opened `Conversation`.** All three
launches came back from `conv.permissionMode()` with `collaboration: "unknown"` even though the box
on screen read `Collaboration mode: Default`. That is not a rendering fact:
`Conversation.captureModeFromScreen` latches the cached reading on the **first** frame whose
`Permissions:` row parses, and the box paints top-down, so the `Collaboration mode:` row two rows
below has not landed yet. Replaying the completed frame in `test/corpus/codex/status-box/bytes.raw`
parses `collaboration: "default"` correctly. So: a **replay** assertion may check `collaboration`; a
**live** assertion taken right after `Open` must not, unless it first re-reads a settled frame.

**Coverage, stated plainly.** The task brief asked for a coverage-gap statement conditional on the
`Permissions:` row being absent. **It is not absent, so that gap does not exist** — `Collaboration
mode:` is not the only surviving anchor, and the forward `(sandbox, approval) → rung` map
(`codexPairRung`, `src/wrapper/internal/permissionrungs.ts`) **can** be covered live. But the
coverage is only real if the assertion earns it:

> A live `/status` check that launches only at the default posture proves **nothing** about the
> forward map — flagless and `-s workspace-write -a on-request` render the identical string, so such
> a check passes even if the map is wired backwards. To exercise the bijection the assertion must
> drive at least one **non-default** posture (e.g. `-s read-only -a never` → `Read Only (never)` →
> `plan`, which this probe already confirmed). Anything less inherits the same false sense of
> coverage the `--help` checks give: they only prove the values still appear in `--help`.

## 6. Two rows that are not stable

The last row is `Weekly limit: [████…] N% left (resets …)` once codex has limits data, but
`Limits: refresh requested; run /status again shortly.` on a cold session. Both were observed on
2026-07-23 minutes apart, on the same binary. `Directory:` is cwd-dependent by construction.

Two prose lines (`Visit https://chatgpt.com/codex/settings/usage …`) sit **inside** the box above
the rows. They are indented by **one** space after the opening bar where every real row is indented
by **two** — which is why the `│`-anchored row regexes in `src/chat/permission.ts` do not trip on
them. Worth preserving if those regexes are ever loosened.

## 7. Widths

Measured from the rendered 120x40 screen of the flagless capture. Intrinsic width is
`26 + <rendered value width>`: opening `│` + 2 spaces + the 19-col label column (set by the widest
label, `Collaboration mode:`) + 3 spaces + value + closing `│`. Box outer width is the widest
intrinsic + 1.

| row                   | intrinsic cols |
| --------------------- | -------------- |
| `Weekly limit:`       | 83             |
| `Model:`              | 69             |
| `Session:`            | **62**         |
| `Directory:`          | 61             |
| `Permissions:`        | 54             |
| `Account:`            | 49             |
| `Collaboration mode:` | 33             |
| `Agents.md:`          | 32             |

Rendered box width: **84 cols** (narrower than the META-HARNESS-110 recordings' 95 only because the
temp cwd is shorter).

`Session:` needs **62** cols here too, again above `CODEX_STATUS_MIN_COLS = 60`. This probe changes
nothing about that follow-up; it is a second independent measurement of the same number, recorded in
`codex-status-ground-truth.md` §7.

## 8. Artifacts

`test/corpus/codex/status-box/` — `bytes.raw` (raw PTY stream, 120x40, live 0.144.5) +
`meta.json` (full prose record, row labels, values, widths, redaction, ownership). Recorded with
`test/corpus/tools/record-pty.ts` in probe mode (`--prompt /status --submit csi13u`), which has no
trust-dialog answering seam of its own, so a minimal `config.toml` holding **only** a
`trust_level = "trusted"` entry for the throwaway cwd was written into the **isolated** `CODEX_HOME`
to reach a ready composer. It carries no approval or sandbox keys, so the capture still reflects
codex's own defaults. The live `Account:` login is replaced byte-for-byte
(16 chars in, 16 chars out); that is the only edit to `bytes.raw`.
