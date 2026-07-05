# `meta-harness/discovery`

Answers one question: *"is harness X's CLI installed on `PATH`, and at what version?"* It
probes installed harnesses (by default, running `X --version` and extracting a semver),
caches the result by binary path + mtime, and never touches the filesystem beyond reading.
It is the single source of truth for harness availability and drift against the
[pinned catalog](versions.md).

```ts
import {
  lookup, discover, registerProbe, resetCache, defaultProbeTimeoutMs,
  SemverDashVProbe, semverRe,
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
