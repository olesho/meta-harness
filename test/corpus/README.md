# Corpus

`test/corpus/` holds several **distinct** corpus types. Do not assume one schema
covers the tree — each subtree documents its own:

| Corpus | Path | What it freezes | Consumer |
| --- | --- | --- | --- |
| **PTY bake-off** | `<harness>/<scenario>/` | recorded PTY byte streams (`bytes.raw` + `meta.json` [+ `expected.txt`]) | emulator bake-off / adapter replay / drift pipeline |
| **Wire** | [`wire/`](./wire/) | cross-language gateway-DTO / StructuredTurnResult / exit-code goldens | `test/wire_corpus.test.ts` |

> The **wire** corpus (and, when it lands here, an **auth** corpus alongside it)
> is an **OFFLINE** golden check — vendored fixtures compared to the pure
> converters. It is DISTINCT from `test/conformance.test.ts`, the gated *live*
> suite that drives real installed binaries. See [`wire/README.md`](./wire/README.md).

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
> records `multi-turn`, `tool-call`, `interrupted-mid-reply`; `codex` records
> `multi-turn`, `tool-call` (interrupt excluded — no generic BusyDetector /
> interrupt seam yet); `pi` is **deferred** (pinned, so rebake iterates it, but it
> has no scripted scenario corpus and no interrupt-confirmation anchor — it is
> skipped with a logged line). The Go command above is the interim reference for
> the recorder's argument shape.

### Hand-recorded scenarios (outside `SCENARIOS`)

Some scenarios cannot be driven by the scripted recorder and are captured by
hand, then checked in. They live in the same `<harness>/<scenario>/` layout and
are inert to `rebake` (which only iterates `SCENARIOS`) and to `screenbench`
(which skips any dir with no `expected.txt`).

| Scenario | Why it is hand-recorded |
| --- | --- |
| `claude-code/model-picker` | needs the `/model` picker open |
| `claude-code/permission-mode-{manual,accept-edits,plan,bypass}` | needs Shift+Tab keystrokes; `src/cli/screenbench-record.ts` has no scripted-keystroke seam (same gap that excludes codex interrupt) |

The permission-mode set gives `src/chat/permission.ts` corpus coverage for the
four rungs the `auto` recordings cannot reach. Each `meta.json` records the live
binary version, the keystrokes used, and the **hex codepoints of the footer's
glyph run**, so a future VS16 (`U+FE0F`) change in claude's rendering lands as a
fixture diff rather than a silent `unknown`. Promoting them to `SCENARIOS` is
gated on `screenbench-record` growing a `--keys` path.

> When hand-recording, cut `bytes.raw` **before** the harness's teardown: a
> stream that ends with the alt-screen restore (`ESC[?1049l`) replays into a
> blank screen.

## Privacy

Recordings may contain whatever you typed and whatever the model said. Treat scenarios as **public**
before checking them in — strip secrets, paths, internal info.
