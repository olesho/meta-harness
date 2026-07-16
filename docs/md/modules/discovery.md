# `meta-harness/discovery`

Answers one question: *"is harness X's CLI installed on `PATH`, and at what version?"* It
probes installed harnesses (by default, running `X --version` and extracting a semver),
caches the result by binary path + mtime, and never touches the filesystem beyond reading.
It is the single source of truth for harness availability and drift against the
[pinned catalog](versions.md).

It is also the **single source of truth for harness-binary path resolution**: the
[`run` CLI](cli.md) and the wrapper's spawn path both defer to
[`resolvePath`](#resolving-the-binary-path) rather than re-implementing PATH lookups
(the wrapper's old `resolveBinary` helper is deprecated in its favor).

```ts
import {
  lookup, resolvePath, discover, registerProbe, resetCache, defaultProbeTimeoutMs,
  SemverDashVProbe, semverRe, WELL_KNOWN_DIRS,
  type Info, type Probe,
} from "meta-harness/discovery"
```

Importing the module registers default probes as a side effect (the Go `init()` analogue):
`SemverDashVProbe` for `codex`, `claude-code`, `opencode`, and `pi`.

---

## Looking up harnesses

```ts
lookup(name: string): Info
```
Resolve a `name` (a canonical harness key, a registered binary name, or any other binary)
to an [`Info`](#info). A binary simply not on `PATH` is a **normal result**
(`installed: false`), not an error — `lookup` throws only on internal failures (e.g. an
unreadable `versions.json`).

```ts
discover(): Info[]
```
`Info` for every harness declared in [`versions.json`](versions.md). Order is not
guaranteed.

```ts
import { lookup } from "meta-harness/discovery"

const info = lookup("claude-code")
if (!info.installed) console.error(info.installHint)
else if (!info.versionMatchesPin)
  console.warn(`drift: pinned ${info.pinnedVersion}, found ${info.detectedVersion}`)
```

### `Info`

```ts
interface Info {
  name: string               // the lookup name you passed
  harness: string            // canonical key from versions.json ("" if unknown)
  binary: string             // the executable name probed
  path: string               // absolute path on PATH ("" if not installed)
  installed: boolean
  installHint: string        // one-liner shown when not installed
  pinnedVersion: string      // from versions.json ("" if unpinned/unknown)
  detectedVersion: string    // parsed from --version
  versionMatchesPin: boolean // false ONLY on explicit drift (true if either side is empty)
  versionProbeError: string  // why the probe failed, if it did
  npmPackage: string         // from versions.json
}
```

`versionMatchesPin` is deliberately forgiving: it is `false` only when both a pin and a
detected version exist and they differ. An unknown or unpinned version never reads as
"drift".

---

## Resolving the binary path

```ts
resolvePath(name: string, env?: Record<string, string>): string | null

WELL_KNOWN_DIRS: readonly string[]
// ["~/.claude/local/bin", "~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"]
```

`resolvePath` resolves a harness name (or any binary name) to an absolute executable
path, or `null` when nothing is found. It is the resolution SSOT the
[`run` CLI](cli.md) and the wrapper's spawn path use. Resolution order:

0. A **path-bearing `name`** (absolute, or containing `/`) is checked directly.
1. An **env override** — `HARNESS_BINARY_<NAME>` (e.g. `HARNESS_BINARY_CLAUDE_CODE`)
   then `HARNESS_BINARY`. An *absolute* override is verified directly and does **not**
   fall through on a miss; a bare-name override is searched on `PATH` only.
2. The live **`PATH`**.
3. The **`WELL_KNOWN_DIRS`** fallback — common install locations probed even when the
   binary is not on `PATH` (independent of which runtime owns the calling interpreter's
   bin dir).

`lookup` shares the same core but stops at step 2 (no well-known-dirs probing); the
wrapper's older `resolveBinary` (PATH/abs-path only) is `@deprecated` — new code should
call `resolvePath`.

---

## Probes

```ts
interface Probe {
  detect(binPath: string): string   // parse and return the version; throw on failure
}

registerProbe(harness: string, p: Probe): void   // associate a probe with a canonical key; throws if p is nullish
resetCache(): void                                 // clear the version cache (for tests swapping a shim)
defaultProbeTimeoutMs: number                      // 10_000 — bounds a single `<bin> --version`
```

Results are cached per binary path, keyed by mtime: an unchanged binary returns the cached
version without re-probing. The timeout is generous because a cold node-based harness can
spend a second or two just starting up to print `--version`.

### `SemverDashVProbe`

```ts
class SemverDashVProbe implements Probe {}   // runs `<bin> --version`, extracts the first semver
semverRe: RegExp                              // /\d+\.\d+\.\d+(?:[-+][\w.]+)?/
```

The default probe: it runs `<binary> --version`, scans combined stdout+stderr for the
first `X.Y.Z[-pre][+build]` token via `semverRe`, and throws on a nonzero exit, a signal,
or no match. Suitable for all four default harnesses.

To support a harness whose `--version` output needs custom parsing, implement `Probe` and
register it before calling `lookup`/`discover`:

```ts
registerProbe("myharness", { detect: (bin) => /* run bin, return version */ "" })
```

---

## Relationship to `versions`

`discovery` reads the [`versions`](versions.md) catalog to know which harnesses exist,
their canonical binary names, and their pins — then reports the *live* reality (installed?
which version? matches the pin?). `versions` is the static declaration; `discovery` is the
runtime check.
