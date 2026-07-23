# Pluggable Environments

This directory documents the environments layer (`./env` export from meta-harness) — the two-axis model (Provisioner × Containment) for sandboxed agent turns.

## Terminology Disambiguation

The word "env" now means **three different things** in this codebase. This section clarifies which is which.

### 1. The ENVIRONMENTS layer (this directory, `./env`)

**What it is:** A two-axis plugin system for sandboxed execution: **Provisioners** (WHERE does the machine come from) and **Containments** (WHAT may the agent touch).

**Key APIs:**

- `Provisioner` — creates a `Workspace` (exec + file-transfer transport)
- `Containment` — decorates a Workspace with policy boundaries (OpenShell, etc.)
- `compose(inner, layer)` — combines them
- `runStructuredTurn(ws, config)` — host-side driver for one structured turn over any Workspace

**When you see it:** In consumer code that picks a provisioner and containment (orche, loomcli), or when authoring a new provisioner/containment backend.

**File:** Exported as `./env` from the main package.

---

### 2. Harness environment hygiene (`src/chat/env.ts`)

**What it is:** Claude nesting markers and env-var stripping logic that keeps a harness's **nested invocation** clean.

**Key concept:** When a harness invokes Claude-in-guest, we strip `CLAUDE_*` / `CODEX_*` env vars to avoid the guest seeing the host's Claude context. The canonical predicate is `isClaudeNestingEnvKey` (line 15).

**When you see it:** In harness initialization code that sets up a nested Claude session.

**File:** `src/chat/env.ts:15` exports `isClaudeNestingEnvKey`.

---

### 3. Environment cleanup (`src/oneshot/oneshot.ts:91`)

**What it is:** A helper function `cleanEnv` that removes sensitive and nesting env vars before spawning a harness.

**Key concept:** Part of the one-shot execution setup; related to harness env hygiene but a distinct operation.

**When you see it:** In oneshot harness startup.

**File:** `src/oneshot/oneshot.ts:91`.

---

## The Canonical Nesting Predicate

Both `isLeakedClaudeEnv` (in `src/oneshot/oneshot.ts:82`) and `isClaudeNestingEnvKey` (in `src/chat/env.ts:15`) implement **identical logic**: they check if an env var name is a Claude/Codex marker that should not cross a nesting boundary.

**The standard:** `isClaudeNestingEnvKey` is the canonical definition. Code that needs to detect nesting markers should import and use this, not reimplement the check.

**Future cleanup:** These two functions are equivalent duplicates today. Consolidating them — perhaps by making `isLeakedClaudeEnv` call `isClaudeNestingEnvKey` — is optional but desirable to avoid drift if the list changes.

---

## The Two-Axis Model

```
                Provisioner (WHERE the machine comes from)
                local | daytona | future: e2b, k8s, ssh
                            ↓ create()
                        Workspace  ──────────────┐
                            ↓                    │ compose(inner, layer)
                Containment (WHAT the agent may touch)
                none | openshell | future
                            ↓
                    composed Workspace  →  runStructuredTurn  →  meta-harness-structured-run (in-guest)
```

A **Provisioner** answers: where does the compute come from? (local host, Daytona cloud, Kubernetes, etc.)

A **Containment** answers: what isolation/policy boundary does the agent run within? (no isolation, OpenShell sandboxing, etc.)

The two are **orthogonal**: you can pair any provisioner with any containment. "OpenShell inside Daytona" is composition, not a fourth backend.

## Lifecycle Contract

The core `env()` factory orchestrates acquisition and teardown in strict order:

```
1. provisioner.preflight()           — host-side capability check, zero resources
2. provisioner.create()              → Workspace (resources acquired from here onward)
3. containment.preflight(workspace)  — runtime capability check, via workspace.exec
4. compose(workspace, layer)         → composed Workspace
   (a containment with the optional acquire(ctx, ws, policy) hook creates its
   resources HERE — e.g. `openshell sandbox create`, via workspace.exec — and
   returns a layer closed over them; env() prefers acquire over layer(policy))
5. injector.redactions() registered  — secrets marked for log redaction
6. injector.apply(composed)          — credentials written to the composed boundary
7. [turns run]
8. destroy: injector.cleanup → containment teardown → inner destroy
```

### Ordering guarantees

- **Redactions before apply** (step 5 → 6): A half-completed credential apply can never emit an unredacted secret into logs.
- **Apply against composed workspace**: Credentials land _inside_ the containment boundary (e.g., inside the OpenShell sandbox), not on the raw provisioned machine where other processes could read them.
- **Strict reverse-acquisition teardown** (step 8): Cleanup happens in reverse order (injector → containment → provisioner), errors aggregated, never short-circuited.

### Failure semantics

- Any failure in steps 2–6 unwinds all acquired layers in reverse order.
- `retention: "keep-on-failure"` applies to _run outcomes_, not setup failures. Setup failures always destroy (though a debug flag exists for rare investigation).
- Retention is evaluated only at step 8, on turn outcomes.

## Provisioner Contract

A Provisioner implements:

```ts
interface Provisioner {
  name(): string;
  preflight(ctx: Context): Promise<void>; // host-side checks only
  create(ctx: Context, spec: WorkspaceSpec): Promise<Workspace>;
}
```

### Shipped implementations

| Name      | Transport                      | Source             |
| --------- | ------------------------------ | ------------------ |
| `local`   | `node:child_process` + fs copy | this repo (core)   |
| `daytona` | Daytona SDK                    | `src/env-daytona/` |

The Daytona backend also ships **`sweep()`** (`src/env-daytona/sweep.ts`), the Tier-4
orphan reaper: it lists the account's sandboxes (draining the SDK's auto-paginating
iterator, so orphans past a page boundary are never missed) and deletes every one
matching **all** of the given labels, returning a `SweepResult` (`swept` / `kept` /
`failed`). Empty labels **throw** — an unscoped sweep would delete every sandbox in the
account — and `dryRun: true` reports the match set without deleting. The live e2e test's
`afterAll` uses it so a crashed run doesn't leak billed resources; it also works
standalone for ops.

### How to add a provisioner

1. Implement the `Provisioner` interface.
2. Have `create()` return a `Workspace` implementing exec, upload, download, guestPath, hostAlias, destroy.
3. Ensure exec() fidelity: exit codes, stdout/stderr round-trip, binary-safe.
4. Pass the Tier-2 conformance suite (in `test/env/conformance.ts`).
5. Add a test file like `test/env/<name>.test.ts` that instantiates the suite with your provisioner.

Example: `test/env/conformance.test.ts` runs the suite against `local + none`; the gated
live runs instantiate the same suite against real backends
(`test/env/daytona_live.test.ts`, `test/env/openshell-live.test.ts`).

A `ConformanceTarget` may set `filterStderr` to strip backend-inherent stderr noise
before the exec-fidelity assertions (e.g. the openshell guest image's node emits an
UNDICI proxy warning on every run); it is identity when omitted, so `local + none` stays
strict.

## Containment Contract

A Containment implements:

```ts
interface Containment {
  name(): string;
  preflight(ctx: Context, ws: Workspace): Promise<void>; // runtime checks, via ws.exec
  layer(policy: PolicySpec): ContainmentLayer;
}

interface ContainmentLayer {
  execWrap(argv: string[], opts: ExecOpts): [string[], ExecOpts]; // wrap argv for sandboxed exec
  crossUpload(stagingPath: string, guestPath: string): string[]; // shell argv to move file across boundary
  crossDownload(guestPath: string, stagingPath: string): string[]; // shell argv to move file out
  pathMap(kind: "repo" | "home" | "tmp"): string; // containment-specific paths
  teardown(): string[]; // shell argv to clean up sandbox
}
```

### Shipped implementations

| Name        | Type                            | Source               |
| ----------- | ------------------------------- | -------------------- |
| `none`      | identity (no boundary)          | `src/env/none.ts`    |
| `openshell` | kernel-level isolation + policy | `src/env-openshell/` |

### How to add a containment

1. Implement the `Containment` interface.
2. Your `layer()` method returns a `ContainmentLayer` with five primitives.
3. The core `compose()` combinator (in `src/env/compose.ts`) handles path translation, alias folding, staging cleanup, and destroy ordering — you implement only the primitives.
4. Pass the Tier-2 conformance suite against a fake provisioner.
5. Test composition with the mapping table (§5.1 in `docs/design/pluggable-environments.md`): the combinator proves correct once; your primitives only need unit tests.

## OpenShell Policy Generation

The `./env-openshell` subpath exports a pure policy generator alongside the containment:

```ts
generatePolicy(scopes: PolicyScopes): string   // OpenShell policy YAML; no I/O

interface PolicyScopes {
  tier: string          // "untrusted" | "semi-trusted" | "trusted-internal"
  modelHost: string     // model-API egress lane
  modelPort?: number    // default 443
  fleetHost: string     // fleet-db egress lane
  fleetPort: number
  harnessPath: string   // guest path of the harness binary (bound to the fleet lane)
  scrapeEndpoints?: ScrapeEndpoint[]   // OPTIONAL extra egress targets
}

interface ScrapeEndpoint {
  host: string
  port?: number        // default 443
  binaries: string[]   // absolute guest paths allowed to reach `host`
}
```

The **tier** picks the read-only filesystem set and the enforcement mode
(`untrusted` / `semi-trusted` enforce; `trusted-internal` observes). The generated
policy always carries two egress lanes — `model` and `fleet` — each binding its
endpoint to the specific guest binaries allowed to use it; git-hub traffic is
bundle-out, with **no** network endpoint.

### Optional scrape-egress lanes (`scrapeEndpoints`)

Each `ScrapeEndpoint` emits its **own** lane (`scrape_0`, `scrape_1`, …) so every host
is bound to exactly its own binaries — a shared lane would let any listed binary reach
any listed host. Lanes are emitted as **bare `{host, port}` endpoints** (a plain CONNECT
tunnel), which is the shape that actually works: a `tls: terminate` lane makes the
in-guest proxy 403 the browser/curl CONNECT (field-tested, openshell 0.0.53). The knob
is additive: absent or empty `scrapeEndpoints` emits no scrape lane and leaves the
generated policy byte-for-byte unchanged, so existing consumers are unaffected.

> **Guest-image prerequisite:** egress also requires the guest image to ship a statable
> `/init.krun` (the proxy's ancestor-integrity check stats the libkrun PID-1 init);
> without it every lane is denied regardless of this policy.

## Credential Injectors

Credentials are delivered via a pluggable `CredentialInjector` interface:

```ts
interface CredentialInjector {
  requires(): Capability[]; // capabilities the workspace must advertise
  apply(ctx: Context, ws: Workspace): Promise<void>;
  redactions(): string[]; // secrets for log redaction (registered BEFORE apply)
  cleanup(ctx: Context, ws: Workspace): Promise<void>; // idempotent, runs even on failure
}
```

### Shipped implementations

| Name    | Mechanism                                          | Use case                                                       |
| ------- | -------------------------------------------------- | -------------------------------------------------------------- |
| `proxy` | Provider-provisioned egress proxy injects real key | OpenShell containment with egress policy                       |
| `file`  | Token written to a file in the sandbox             | Remote provisioners (Daytona) where the real CLI runs in-guest |
| `host`  | Credentials never cross; calls happen host-side    | Host-driven mode (loomcli's legacy Daytona mode)               |

### Credential leak probe

One canonical list of **sensitive env names** (`CREDENTIAL_SENSITIVE_ENV_NAMES` in `src/env-daytona/leak-probe.ts`) is the source of truth. An in-guest leak-probe binary counts how many are set; if nonzero, the run fails.

The probe is:

- Generated once (`credentialLeakProbe()` returns a shell command)
- Run in-guest via `exec()` to detect leaks
- Unit-tested for consistency across language implementations (Go, TS)

**Example:** Test setup might set `ANTHROPIC_API_KEY` in the host env; the guest must _not_ see it. The probe detects and fails the turn if it does.

## Turn Client

The host-side driver for a single structured turn:

```ts
runStructuredTurn(ctx: Context, ws: Workspace, cfg: TurnConfig): Promise<StructuredTurnResult>
```

1. Writes the prompt to a temp file (never argv or shell-interpolated).
2. Calls `ws.exec()` with `meta-harness-structured-run --prompt-file <path> … [--sandbox-defaults] <harness> -- <args>` (`--sandbox-defaults` opts into `IS_SANDBOX=1` + the claude-code permission bypass; off by default — argv/env forwarded verbatim). When `--permission-mode` is also set it wins for argv; the `IS_SANDBOX=1` half still applies, unconditionally and independently of the resolved mode.
3. Parses the last stdout line as JSON (the structured result). Its optional `permission_mode` reports the rung the guest runner **launched** the harness at — telemetry only, never an authorization signal, and never a readback of the live mode. When the runner emits no JSON at all, the result derived here from exit code + stderr leaves the key **absent**: no turn ran, so there is no launch rung, and the host never synthesises one from its own `cfg.permissionMode`.
4. Optionally retrieves the on-disk transcript to a host path.

**Protocol:** Frozen schema shared between producer (`src/cli/structured-runner.ts`) and this client — five required keys plus four optionals (`usage`, `reason`, `transcript_error`, `permission_mode`), each absent rather than empty when unset. Exit codes: 0 = completed, 1 = errored, 2 = usage, 124 = deadline.

## Testing Tiers

| Tier | Coverage                                 | Run                                                                                   | Where                                                              |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1    | Unit, hermetic                           | Every PR                                                                              | `test/env/`                                                        |
| 2    | Conformance suite                        | Every PR (against fakes)                                                              | `test/env/conformance.ts`                                          |
| 3    | In-guest e2e, no cloud                   | Every PR (with docker/podman)                                                         | `test/env/container.test.ts`                                       |
| 4    | Live (Daytona, OpenShell)                | Nightly / opt-in (`META_HARNESS_ENV_LIVE=<backend>`, e.g. `=openshell` or `=daytona`) | `test/env/openshell-live.test.ts`, `test/env/daytona_live.test.ts` |
| 5    | Protocol freeze, composition, leak-probe | Mix of tiers 1–4                                                                      | `test/env/`                                                        |

## References

- **Design spec:** `docs/design/pluggable-environments.md` (full model, migration phases, open questions)
- **Conformance suite:** `test/env/conformance.ts` (the pluggability guarantee)
- **Guest image contract:** `guest-image.Dockerfile` (reference layout and requirements)
- **Structured-turn protocol:** `src/turnproto/` (frozen schema, exit codes, DeadlineLine)
