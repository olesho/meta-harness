# `meta-harness/versions`

The pinned/known-good harness version catalog, backed by an embedded
[`versions.json`](../../../src/versions/versions.json). It ties each harness adapter's code —
its screen regexes, classifier patterns, transcript-schema assumptions — to a specific
upstream release that adapter is *verified against*. The data is read at module load (the
TS analogue of Go's `//go:embed`), so lookups work from any working directory.

```ts
import {
  all, pinned, readFrom, type Entry,
  errEmptyPackage, errEmptyBinary, errVerifiedAtWithoutPinned, errParse, errRead,
} from "meta-harness/versions"
```

---

## The catalog

```jsonc
{
  "codex":       { "package": "@openai/codex",                 "binary": "codex",    "pinned": "0.142.5", "verified_at": "2026-07-05" },
  "claude-code": { "package": "@anthropic-ai/claude-code",     "binary": "claude",   "pinned": "2.1.201", "verified_at": "2026-07-05" },
  "opencode":    { "package": "opencode-ai",                   "binary": "opencode", "pinned": "",        "verified_at": "" },
  "pi":          { "package": "@earendil-works/pi-coding-agent","binary": "pi",       "pinned": "0.76.0",  "verified_at": "2026-06-27" }
}
```

```ts
interface Entry {
  package: string      // npm package name (required)
  binary: string       // on-PATH executable the package installs (required)
  pinned: string       // verified upstream version; "" = not yet verified
  verifiedAt: string   // YYYY-MM-DD the pin was confirmed; "" when pinned is ""
}
```

**`pinned` vs `verifiedAt`.** `pinned` is the upstream version the adapter is known to work
against; an empty pin means "not yet verified" (adapters may ship provisionally).
`verifiedAt` documents *when* the pin was confirmed and is only valid alongside a non-empty
`pinned`. OpenCode is intentionally unpinned; Cursor has no entry (it is
[wrapper-classification only](../harnesses.md#cursor)).

---

## API

```ts
all(): Map<string, Entry>
```
Every entry, keyed by harness name.

```ts
pinned(harness: string): [string, boolean]
```
The pinned version as `[version, true]`, or `["", false]` if the harness is absent or its
pin is empty. Never throws (internal parse failures return `["", false]`).

```ts
readFrom(path: string): Map<string, Entry>
```
Read a `versions.json` from an explicit path (for tests and tooling operating on a
different catalog — e.g. a corpus-rebake pipeline). Validates each entry and **throws**
wrapped [sentinels](#validation--errors) on problems.

```ts
import { pinned } from "meta-harness/versions"
const [v, ok] = pinned("codex")   // ["0.142.5", true]
```

---

## Validation & errors

`readFrom` enforces the catalog's invariants; each failure wraps a sentinel you can match
with `isSentinel`:

| Sentinel | Raised when |
| --- | --- |
| `errEmptyPackage` | An entry has an empty `package`. |
| `errEmptyBinary` | An entry has an empty `binary`. |
| `errVerifiedAtWithoutPinned` | An entry has `verified_at` but an empty `pinned`. |
| `errParse` | JSON parse failure or an invalid top-level shape. |
| `errRead` | The file could not be read. |

`package` and `binary` are required for every entry; `pinned`/`verifiedAt` are optional,
except that `verifiedAt` implies `pinned`.

---

## Relationship to `discovery`

`versions` is the static declaration of *what should be*; [`discovery`](discovery.md) does
the runtime check of *what is* — resolving each `Entry`'s `binary` on `PATH`, probing its
`--version`, and comparing against `pinned` to flag drift.
