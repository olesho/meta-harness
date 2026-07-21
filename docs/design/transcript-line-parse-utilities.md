# Transcript line-parse utilities — port status (META-HARNESS-96)

**Status: closed wont-do.** The originally-named port ("port line-parse utilities
`ParseFromBytes`, `StripIDEContextTags`, `ExtractUserContent` — confirm consumer first")
resolves to a no-op: two of the three utilities are already ported and consumed, the third's
behavior already lives inline in both parsers, and the only surface still gated on "confirm a
consumer first" — line/byte-offset file reads — has no consumer that needs it. This note records
that decision so the ticket is not re-opened as pending work.

## Findings

### 1. `ParseFromBytes` and `StripIDEContextTags` are already ported and load-bearing

Both were ported under META-HARNESS-7 (commit `aa9666d`) and are consumed today:

- **`parseFromBytes`** — `src/transcript/parse.ts:23` (header: *"Ported from harness-wrapper's
  parse.go"*). Consumers: `src/transcript/claudecode/parseClaude.ts` (`events`) and
  `src/transcript/usage.ts` (`usageFromClaudeJSONL`).
- **`stripIDEContextTags`** — `src/transcript/stripTags.ts:17` (header: *"Ported from
  harness-wrapper's strip_tags.go"*). Consumers: `parseClaude.ts:76,97`,
  `src/transcript/codex/parseCodex.ts:118`, and the production swallowed-prompt detector
  `tryTranscriptProof` in `src/chat/conversation.ts:1619,1624`.

Both are **internal** helpers — deliberately not re-exported from the public barrel
`src/transcript/index.ts`, which exposes the `Event`/`Turn` model and the `usageFrom*` / `events`
entry points instead. They must not be re-implemented; they remain the single source of their
behavior.

### 2. `ExtractUserContent` behavior lives inline, and both sites already share the tag-strip

There is no standalone `extractUserContent` function, and none is needed. The behavior — pull
user text from a transcript line, strip IDE/system tags, drop empties — is implemented inline in:

- `src/transcript/claudecode/parseClaude.ts` (`userLineEvents`, ~line 65; string and text-block
  branches; stripping at `:76,97`), and
- `src/transcript/codex/parseCodex.ts` (`appendMessageEvents`, ~line 109; stripping at `:118`).

Critically, **both sites already route their tag-stripping through the shared
`stripIDEContextTags`**, so there is no "third tag-stripping path" to unify. What differs between
them is genuinely format-specific structural traversal (Claude walks `message.content` as a
string-or-`text`-block array; Codex iterates `item.content` blocks). A shared helper could
collapse only the trailing `strip-and-drop-empty` step — close to a no-op — so the inline logic
is left as-is. Extract a helper only if a *named* consumer specifically wants a standalone symbol.

### 3. Offset-read primitives are intentionally absent

The Go `ParseFromFileAtLine` / `SliceFromLine` (line/byte-offset file reads) have **no** TS
equivalent by design. The TS side tracks a *turn-count watermark*
(`captureTranscriptWatermark`, `src/chat/conversation.ts:1532`) and re-reads the whole transcript
via the adapter's `readTranscriptTurns` (`conversation.ts:1513`), slicing by array index;
`usage.ts` and the readers consume whole-file `parseFromBytes`. Nothing needs an
incremental/offset reader, so adding one without a caller would be dead surface. Do **not** port
these primitives unless a consumer that requires incremental/offset transcript reads is named,
along with the specific function it needs.

## Why no "byte-identical vs Go" acceptance criterion

There are **zero `.go` files in this repo** and the Go `harness-wrapper` is frozen —
`docs/design/pluggable-environments.md:24` declares it *"frozen as-is and never grows environment
code"* with TypeScript as the consolidation target. A cross-repo "byte-identical output vs Go on a
shared fixture set" gate is therefore untestable in-repo and architecturally backwards for
TS-owned code. Correctness of these utilities is asserted against self-contained TS fixtures.

## Re-opening conditions

Re-open only if a specific TS/external consumer is named **together with** the specific function
it needs, after first checking whether the already-exported `Event`/`Turn` model in
`src/transcript/index.ts` (or `usageFrom*` / `events`) already satisfies it — a UI almost
certainly wants the structured event model, not raw `parseFromBytes`. Promoting an internal helper
to the barrel is a public-surface change, not a port, and must be justified by that consumer's
actual need.
