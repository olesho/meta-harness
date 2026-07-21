# Wire conformance corpus

Shared cross-language **golden** fixtures for the three frozen wire surfaces the
meta-harness TS port hand-duplicates against Go's `harness-chatd` / `turnproto`:

1. **Gateway wire DTOs** — `src/gateway/dto.ts` (`turnDTO`, `sessionDTO`,
   `inputRequestDTO`, `screenResponse`, `turnResultDTO`, `parseAnswerRequest`)
   ↔ Go `cmd/harness-chatd/types.go`.
2. **StructuredTurnResult** — `src/turnproto/protocol.ts` ↔ Go `pkg/turnproto`.
3. **CLI exit codes + `DeadlineLine`** — the literals pinned in both
   `src/turnproto/protocol.ts` and Go `pkg/turnproto/protocol.go`.

The consumer on this side is `test/wire_corpus.test.ts`.

> **This is an OFFLINE golden check, distinct from `test/conformance.test.ts`.**
> `conformance.test.ts` is the gated *live* suite (`CONFORMANCE=1`, real
> installed binaries, version-drift assertions). The wire corpus never launches
> a harness — it runs the pure converters/parsers against vendored fixtures.
> "The wire corpus" ≠ "the conformance suite."

## Provenance & sync

These files are **vendored byte-identically** from the canonical side
(harness-wrapper, HARNESS-WRAPPER-47), the same way `test/corpus/auth` is
vendored. Do not hand-edit fixtures here; re-mirror from the canonical repo:

```sh
scripts/sync-corpus.sh wire --check      # CI: fail if we have drifted from canonical
scripts/sync-corpus.sh wire --to DIR     # write our vendored copy into DIR
```

**Repo-to-repo divergence is NOT caught by either repo's CI in isolation** —
each repo only checks its own `MANIFEST.sha256` internally (identical known
limitation to the auth corpus). It is caught by the sync script's
`--check`/`--to` discipline: run `--check` in both repos' CI and re-mirror via
`--to` whenever the canonical side changes.

## Layout

```
test/corpus/wire/
  README.md              this file (NOT frozen by the manifest)
  MANIFEST.sha256        sha256 of every fixture file (drift guard)
  constants.json         exit codes + DeadlineLine (surface: "constants")
  dto/<name>/            serialize surfaces (turn/session/inputRequest/screen/turnResult)
    meta.json              { surface, description, scope, input }
    golden.json            the canonical Go-produced wire JSON
  answer/<name>/         parseAnswerRequest (deserialize) surface
    meta.json              { surface: "answerRequest", ..., input: <wire body> }
    golden.json            the expected MH InputAnswer (camelCase)
  structured/<name>/     StructuredTurnResult round-trip surface
    meta.json              { surface: "structuredResult", ..., input: <sample> }
    golden.json            { keys: [...] }  the exact frozen key set
```

## Fixture-input (`meta.json`) schema

`meta.json` describes one fixture in a **language-neutral** way so both repos'
consumers can build equivalent native inputs:

- `surface` — one of `turn`, `session`, `inputRequest`, `screen`, `turnResult`,
  `answerRequest`, `structuredResult`.
- `description` — human summary of what the fixture exercises.
- `scope` — `"shared"` (both languages) or `"mh-superset"` (MH-only field the Go
  consumer skips explicitly rather than fighting the superset contract at
  `src/gateway/dto.ts:16-21`).
- `input` — the native-ish field values, per surface:
  - **turn**: `Turn` fields. `startedAt`/`completedAt` are ISO-8601 strings; a
    `null` `completedAt` is the "not yet complete" sentinel MH maps to
    `new Date(0)`. `retryAfter` is a **millisecond number** (Go encodes it as a
    `time.Duration`).
  - **session**: `Session` fields; `createdAt` is an ISO-8601 string.
  - **inputRequest** / **screen**: the `InputRequest` / `Snapshot` value directly.
  - **turnResult**: `{ turn, session, history[], historySource,
    processStoppedAfterTurn }`. `TurnResult` also carries a **non-serializable**
    `conversation?: Conversation` (`src/harness/internal/runTurn.ts:145-147`)
    that `turnResultDTO` intentionally ignores — do **not** describe it in
    `input`.
  - **answerRequest**: the wire `answerRequest` body (`option_id`, `option_ids`,
    `text`).
  - **structuredResult**: a full `StructuredTurnResult` sample object.

### Timestamp rule — whole-millisecond (whole-second recommended)

Byte-identical JSON from both serializers is not achievable, so DTO goldens use
**one canonical producer (Go)** and **semantic comparison** on the consuming
side — never string equality. Timestamps are the sharp edge: Go's `encoding/json`
marshals `time.Time` as RFC3339**Nano** (`2026-01-01T00:00:05Z`) while
`Date.toISOString()` always emits `2026-01-01T00:00:05.000Z`. The TS comparator
treats the declared timestamp keys — `started_at`, `completed_at` (TurnDTO),
`created_at` (SessionDTO) — as **instants** (`Date.parse` both sides, at every
nesting depth) and deep-equals everything else, while still asserting exact key
sets so a timestamp key's *presence* stays frozen.

Because JS `Date` is millisecond-precision, canonical fixture instants **MUST be
whole-millisecond** (whole-second is recommended, as in `00:00:05Z`). This is the
condition under which the canonical side needs no special timestamp marshaling.

## Omission & edge contract

Fixtures exercise both presence and absence for every optional field (the
key-set assertion is what catches omission drift), plus the deserialize-direction
asymmetries: empty `option_ids[]` drops (guard is `length > 0`), empty
`option_id` drops (falsy), but empty `text` is **kept** (`!== undefined`). A body
carrying both `option_id` and `option_ids` yields an `InputAnswer` with **both**
`optionID` and `optionIDs` — the DTO layer passes both through; "non-empty
`option_ids` wins" is a downstream `src/chat/conversation.ts` contract and is
deliberately **not** encoded here.

The `constants` fixture freezes exit-code **values** only — no test requires Go to
*emit* `ExitUsage` (Go carries `2` for protocol fidelity, with no emit path).
