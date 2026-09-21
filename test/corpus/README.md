# Corpus

`test/corpus/` holds several **distinct** corpus types. Do not assume one schema
covers the tree — each subtree documents its own:

| Corpus | Path | What it freezes | Consumer |
| --- | --- | --- | --- |
| **PTY bake-off** | `<harness>/<scenario>/` | recorded PTY byte streams (`bytes.raw` + `meta.json` [+ `expected.txt`]) | emulator bake-off / adapter replay / drift pipeline |
| **Wire** | [`wire/`](./wire/) | cross-language gateway-DTO / StructuredTurnResult / exit-code goldens | `test/wire_corpus.test.ts` |
| **Permission mode** | [`permission-mode/`](./permission-mode/) | captured footer / `/status` screens paired with the posture a parser must read off them (`bytes.raw` + `meta.json` + `screen.txt`) | `test/permission_mode_corpus.test.ts` |

> The **wire** and **permission-mode** corpora (and, when it lands here, an
> **auth** corpus alongside them) are **OFFLINE** golden checks — vendored
> fixtures compared to the pure converters/parsers. They are DISTINCT from
> `test/conformance.test.ts`, the gated *live* suite that drives real installed
> binaries. See [`wire/README.md`](./wire/README.md).

> **`permission-mode/` is VENDORED, and this repo is not its canonical side.**
> The screens are captured in **harness-wrapper** and mirrored here
> byte-identically by that repo's
> `scripts/sync-permission-mode-corpus.sh --to <this repo>`. The two repos are
> *in sync* iff their committed `permission-mode/MANIFEST.sha256` are
> **byte-equal**, so never hand-edit a file under `permission-mode/` and never
> regenerate its manifest from this side — change it in harness-wrapper and
> re-mirror, or the invariant breaks in both repos at once.
>
> Its manifest follows the **third** convention in the family (see
> `scripts/sync-conformance.sh`'s header, which enumerates all three): every
> file under the corpus root except `MANIFEST.sha256` is hashed, so unlike the
> wire corpus **`README.md` IS hashed**.

The rest of this file documents the **PTY bake-off** corpus.

> 📖 Full story — canonical scenarios, adversarial recordings, recording workflow, privacy — is in the
> **[Corpus docs](../../docs/md/internal/testing/corpus.md)**.

## Layout

```
test/corpus/
  <harness>/<scenario>/
    bytes.raw          required  raw PTY byte stream captured from the harness
    meta.json          required  harness, recorded_at, terminal dims, binary version
    expected.txt       optional  ground-truth final assistant text (fidelity metrics)
    transcript.jsonl   optional  copy of the harness's own session log, for reference
```

`<harness>/adversarial/<scenario>/` holds negative recordings that must NOT fire the marker.

## Interactive recording

```sh
go run ./internal/screenbench/cmd/screenbench-record \
    --harness codex \
    --bin "$(which codex)" \
    --out test/corpus/codex/short-reply \
    --cols 120 --rows 40 \
    --binary-version "$(codex --version)" \
    --notes "single-turn short reply"
```

Scripted refreshes go through `make rebake-corpus` — see
[Versions & Drift](../../docs/md/internal/versions-drift.md).

> **TS migration (META-HARNESS-67).** In this repo, rebake is expressed as the
> `npm run rebake-corpus` script (`scripts/rebake-corpus.mjs`) rather than a
> Makefile target. It reads an ALTERNATE corpus manifest via `readFrom(path)`
> (env `META_HARNESS_REBAKE_MANIFEST`, else `./versions.rebake.json`) and drives
> the TypeScript screenbench recorder `meta-harness-screenbench-record`. That
> recorder is delivered by META-HARNESS-82 (which supersedes and implements A5 /
> META-HARNESS-51): `src/cli/screenbench-record.ts` → `dist/cli/screenbench-record.js`,
> registered as a `bin`. Build the tree so the bin is materialized, then
> `npm run rebake-corpus` records and exits **0** (exit **3** is now only a
> defensive "recorder unexpectedly absent" guard).
>
> Scenario coverage is **per-harness** (`SCENARIOS` in the script): `claude-code`
> records `multi-turn`, `tool-call`, `interrupted-mid-reply`, `trust-dialog`;
> `codex` records `multi-turn`, `tool-call` (interrupt excluded — no generic
> BusyDetector / interrupt seam yet); `pi` is **deferred** (pinned, so rebake
> iterates it, but it has no scripted scenario corpus and no
> interrupt-confirmation anchor — it is skipped with a logged line). The Go
> command above is the interim reference for the recorder's argument shape.

### Untrusted-workdir scenarios

`claude-code/trust-dialog` is the only cell whose terminal state is a **blocking
dialog** rather than a completed turn: the recorder settles on claude's
folder-trust dialog, captures it **unanswered**, and kills the harness. Three
consequences worth knowing before re-recording it:

- **It needs a directory claude has not been trusted in.** Trust is persisted per
  absolute path (`~/.claude.json` → `projects[<path>].hasTrustDialogAccepted`),
  so the recorder mints a fresh temp directory each run and skips the
  trust-accepting warmup pass. Passing `--cwd`/`--workdir` opts out of that
  guarantee; the recorder refuses outright if the directory it is handed is
  already trusted, since the dialog would never fire.
- **Any given directory is single-shot.** A second recording into the same path
  captures a ready composer, not the dialog. Never reuse one.
- **Use a profile that is already logged in.** A *fresh* claude config directory
  paints the first-run onboarding wizard instead of the trust dialog, and
  `readyForInput` correctly refuses that shape — so `CLAUDE_CONFIG_DIR`-style HOME
  isolation is not a substitute. Log in first, then record.

`meta.json` for this cell carries `workdir` (the captured frame renders the
absolute path verbatim on its "Accessing workspace:" line, so a reader can tell
the path is a recorder artifact rather than a transcription error) and
`keystrokes: "none (dialog captured unanswered)"`.

### Dialog scenarios: catalog status vs. rebake status

`src/cli/screenbench-record.ts`'s catalog can now **drive** nine claude-code
cells whose terminal state is a dialog or a permission-mode footer, using the
scripted-step vocabulary (`await-input`, `answer`, `keys`, `cycle`, `dump`,
`settle`, `launchArgs`) that PUPPET-306 delivered:

| Scenario | Script | In rebake's `SCENARIOS`? |
| --- | --- | --- |
| `question-single` | prompt, `await-input` kind `question` | no — fixture unlanded + not recordable here |
| `question-multi` | prompt, `await-input`, `dump expected-untoggled.txt`, `keys '1'`, `settle` | no — same |
| `question-review` | prompt, `await-input`, `keys '1'`, `await-input`, `keys '1'`, `await-input` kind `question_review` | no — same |
| `permission-mode-manual` | `cycle` ×1 | no — see the 2.1.252 readiness finding |
| `permission-mode-accept-edits` | `cycle` ×2 | no — same |
| `permission-mode-plan` | `cycle` ×3 | no — same |
| `permission-mode-cycle` | `cycle` ×6 (dumps `screen-press-01..06.txt`) | no — same |
| `permission-mode-cycle-bypass` | `--dangerously-skip-permissions`, `cycle` ×7 | no — same |
| `permission-mode-bypass` | `--permission-mode bypassPermissions`, `await-text`, `settle` | no — same |

**What the catalog can drive and what `rebake` regenerates are different sets,
on purpose.** A hand-captured `meta.json` holds prose evidence a re-record
destroys — the measured ring lengths, both probed Shift+Tab encodings, the
`not_measured` list — and that evidence cost a paid live session. So a cell
joins `SCENARIOS` only **per scenario, after** it has been driven end-to-end
against the real binary and its output shown to replay identically to the
fixture it would replace. None has cleared that bar yet; the reasons are below,
and each cell's `notes` repeats its own.

Migration rule for the first deliberate re-record of any hand-captured dir: move
its irreplaceable prose (`notes`, `findings`, `not_measured`, `measured_ring_*`)
into a sibling `notes.hand-capture.md` **in a separate commit, before** the
re-record. The recorder never touches files it does not own, so that file
survives every future rebake.

#### Live-validation findings (claude 2.1.252, 2026-09-01)

Recording live was attempted for `permission-mode-manual`, the cheapest cell
(pure keystrokes, no model turn, no tokens). It does not work on this build, for
two independent reasons:

1. **The empty composer is no longer bare.** 2.1.252 paints a placeholder
   suggestion in it — `❯ Try "refactor <filepath>"` — so `claudeComposerRE` in
   `src/chat/ready.ts` (a `❯` alone on its line) does not match and
   `readyForInput` reports **not ready**. Every claude-code cell is gated on
   that predicate, so this blocks the three legacy cells too, not just the new
   ones. Fixing it means changing the chat layer's readiness gate, which is a
   separate decision with a much wider blast radius than the corpus.
2. **The recorder's cleaned env leaves claude logged out.** `cleanedEnv()`
   strips `CLAUDECODE` and `CLAUDE_CODE_*` (deliberately — a recording must not
   inherit the driving agent's session), and on this machine those carry the
   credentials, so the spawned harness paints `Not logged in · Run /login`. No
   model turn means no `AskUserQuestion` pane, so the three `question-*` cells
   are not elicitable here at all, independent of finding 1.

A third finding was fixed rather than recorded: **`cycle` now waits for a ready
composer before its first press**, exactly as `prompt` does. Without that gate
the first Shift+Tab was written at t≈0, before the TUI had put the tty into raw
mode, so the escape sequence was echoed as literal text (`^[[Z`) into whatever
was on screen — and the run still exited **0**, leaving a plausible-looking
garbage fixture. The gate is also what makes an untrusted `--cwd` fail by name
instead of cycling into a modal. `test/cli/screenbench-record.dialog.test.ts`
covers it.

#### Recording against a pre-trusted directory

The `question-*` and `permission-mode-*` cells are recorded in a directory
claude has **already** been trusted in — the opposite of `trust-dialog` below.
Trust is persisted per absolute path, so grant it once, interactively, and reuse
the directory:

```sh
mkdir -p ~/.cache/meta-harness-trusted && git -C ~/.cache/meta-harness-trusted init -q
# then, once, in that directory: run claude and answer "Yes, I trust this folder".
# (Writing projects[<path>].hasTrustDialogAccepted into ~/.claude.json by hand is
# NOT sufficient on 2.1.252 — measured; the dialog still paints.)

npm run build
node dist/cli/screenbench-record.js \
  --harness claude-code --bin "$(which claude)" \
  --scenario question-single --out /tmp/qs \
  --cwd ~/.cache/meta-harness-trusted --no-warmup \
  --cols 120 --rows 40 --binary-version "$(claude --version | cut -d' ' -f1)"
```

`--no-warmup` skips the trust-accepting warmup pass, which is pure overhead in a
directory that is already trusted. Then diff the produced `expected.txt` against
the checked-in fixture: differences in wording or model text are expected;
differences in **structure** (option rows, footer anchors, tab strip) are a
**finding** — record them, and re-run `vitest run test/turns/claude-code` and
`test/chat/permission.test.ts` against the new bytes before replacing any
fixture. `--attempts <n>` retries a scenario the model declined to ask; nothing
beyond that is warranted, because a scenario that will not elicit the pane is a
finding to record, not a frame to fabricate.

### Hand-recorded scenarios (outside `SCENARIOS`)

Some scenarios are captured by hand and checked in. They live in the same
`<harness>/<scenario>/` layout and are inert to `rebake` (which only iterates
`SCENARIOS`) and to `screenbench` (which skips any dir with no `expected.txt`).

| Scenario | Why it is hand-recorded |
| --- | --- |
| `claude-code/model-picker` | needs the `/model` picker open; no catalog entry drives it |
| `claude-code/permission-mode-*` | a catalog entry now EXISTS for each (table above), but none has been validated live, so the checked-in bytes remain the hand-captures |
| `claude-code/question-*` | same — catalog entries exist; the fixtures come from the PUPPET-301 hand-capture |

> Not to be confused with the **vendored** `permission-mode/` corpus in the
> table at the top of this file: these four are locally hand-recorded PTY
> scenarios in the `<harness>/<scenario>/` layout, while `permission-mode/` is a
> mirrored screen corpus this repo does not own. The vendored tree is where the
> `dontAsk` footer (`⏵⏵ don't ask on`, claude 2.1.217) is pinned; there is no
> local `permission-mode-dont-ask` recording.

The permission-mode set gives `src/chat/permission.ts` corpus coverage for the
four rungs the `auto` recordings cannot reach. Each `meta.json` records the live
binary version, the keystrokes used, and the **hex codepoints of the footer's
glyph run**, so a future VS16 (`U+FE0F`) change in claude's rendering lands as a
fixture diff rather than a silent `unknown`.

The gate this file used to name — "promoting them to `SCENARIOS` is gated on
`screenbench-record` growing a `--keys` path" — **has been delivered**
(`--keys`, `cycle`, `answer`, `--launch-arg`, `--stop-on-input`). What remains
is not a missing seam but a missing live validation, per the two findings above.

> When hand-recording, cut `bytes.raw` **before** the harness's teardown: a
> stream that ends with the alt-screen restore (`ESC[?1049l`) replays into a
> blank screen.

## Privacy

Recordings may contain whatever you typed and whatever the model said. Treat scenarios as **public**
before checking them in — strip secrets, paths, internal info.
