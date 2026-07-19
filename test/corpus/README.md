# Bake-off corpus

Recorded PTY byte streams: the substrate for the [emulator bake-off](../../docs/md/internal/decisions/adr-001-vt100.md)
and the input to the Layer-2 adapter replay tests and the drift pipeline.

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

## Privacy

Recordings may contain whatever you typed and whatever the model said. Treat scenarios as **public**
before checking them in — strip secrets, paths, internal info.
