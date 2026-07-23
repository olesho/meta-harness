# Pluggable Environments for meta-harness

**Status:** Draft for review · 2026-07-08 · rev. 2026-07-10 (post consistency review against meta-harness v0.1.5, orche@dev, loomcli `feat/meta-harness-node-leaf`)
**Scope:** design only — no implementation, no `package.json` changes, no new exports yet.
**Related:** orche `packages/agent/src/sandbox/` (README, ORCHE-64/81) · loomcli `docs/design/meta-harness-sandbox-runner.md` (branch `feat/meta-harness-node-leaf`) · this repo's `src/cli/PACKAGING.md`.

---

## 1. Context and motivation

Two orchestrators consume meta-harness today, and both have independently converged on the same execution pattern for sandboxed agents:

|                       | orche (shipping)                                                                                                                        | loomcli (spec'd, Part C/D)                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Sandbox tech          | NVIDIA OpenShell (containment on a host you own)                                                                                        | Daytona (elastic remote compute)                                                   |
| Harness placement     | baked into the sandbox image, exec'd in-guest                                                                                           | same (planned; today host-driven via Flue)                                         |
| Turn protocol         | `harness-wrapper run` exec'd in-guest; whole-stdout reply + exit 0/non-zero/124 today — structured-run JSON is the adoption target (§7) | one JSON line from `meta-harness-structured-run`, last-stdout-line parsed (spec'd) |
| Transcript            | read in-guest, shipped back in the JSON line                                                                                            | same                                                                               |
| Credentials           | never in guest env (egress proxy injects the real key)                                                                                  | never in guest env (file-provisioned scoped token, spec'd)                         |
| Repo in / results out | host clone → `sandbox upload`; git bundle → CAS ref update                                                                              | in-guest clone; `git diff --binary` patch artifact / PR                            |

Loomcli's spec explicitly cites orche's `sandbox/materialize.ts` as its model. The duplication is scheduled, not hypothetical: the moment loomcli implements its Part C/D, orche's ~790-line `openshell.ts` machinery gets re-written against Daytona, and the structured-runner protocol contract will live in three repos.

**Decision:** consolidate the environment layer into meta-harness. TypeScript is the forced choice — Daytona has no Go SDK (its SDKs are TS/Python; even loomcli's Go orchestrator wrote its Daytona integration in TS), and both consumers already sit on the TS artifact at exactly the seam where environments plug in. The legacy Go `harness-wrapper` is frozen as-is and never grows environment code.

**Design requirement:** the two sandbox technologies solve different problems and must be swappable _independently_:

- **Daytona** answers _"where does the machine come from"_ — provisioning, elasticity, placement.
- **OpenShell** answers _"what may the agent touch on it"_ — kernel-level isolation, declarative policy, egress control.

Hence the model below is two orthogonal axes, not a flat backend list. "Swap Daytona for E2B" and "swap OpenShell for another containment runtime" are each one-implementation changes; "OpenShell inside a Daytona machine" is composition, not a fourth backend.

### Goals

1. Any orchestrator gets sandboxed agent turns by picking a provisioner × a containment, without owning either integration.
2. Provisioners and containments are independently pluggable behind stable interfaces with a conformance suite.
3. One home for the structured-turn protocol (producer + consumer + golden schema).
4. One normative guest image contract.
5. One credential-delivery contract with lifecycle-safe sequencing, redaction, and leak probing.

### Non-goals

- Workspace/publish semantics (orche's bundle/CAS vs loomcli's patch/PR) — these stay in orchestrators (§12).
- Task claiming, scheduling, retention _policy_ decisions, credential _minting_.
- Interactive (`Conversation`) sessions over remote environments — one-shot structured turns first (§14, open questions).

---

## 2. The two-axis model

```
             Provisioner (WHERE the machine comes from)
             local | daytona | future: e2b, k8s, ssh
                         │  create()
                         ▼
                     Workspace  ──────────────┐
                         │                    │ compose(inner, layer)
             Containment (WHAT the agent may touch)
             none | openshell | future
                         │
                         ▼
                 composed Workspace  →  turn client → meta-harness-structured-run (in-guest)
```

- A **Provisioner** yields a `Workspace`: an exec + file-transfer transport onto a machine.
- A **Containment** is a _decorator over the full `Workspace` contract_ — not just `exec`. It contributes a `ContainmentLayer` of primitives; the core owns the composition (§5).
- The primary API makes the axis choice explicit:

```ts
const environment = env({
  provision: daytona(cfg),
  contain: openshell({ tier: "untrusted" }),
});
```

Presets (`localEnv()`, `daytonaEnv(cfg)`, `openshellLocal(tier)`) are convenience sugar over the explicit selectors — documented as such, never the primary API — so callers cannot silently lock in policy by preset. This mirrors orche's `openshell({tier})` helper ergonomics (`sandbox/index.ts:140`) while keeping the axes visible.

**External compute (BYO VMs).** Daytona provides its own managed cloud compute by default — the SDK talks to Daytona's hosted control plane and sandboxes land in their shared regions (loomcli today: `new Daytona({apiKey})`, no `apiUrl`/image/snapshot; `target` overridable via `DAYTONA_TARGET`). Machines you own enter the model two ways, and neither is a new axis:

1. _Through Daytona_ — BYOC "custom regions": customer-managed runner nodes deployed on your Kubernetes via Daytona's `daytona-region` Helm chart (region proxy, snapshot manager, registration job), control plane stays Daytona-managed over a reverse tunnel, and the SDK selects the region via `target`. Config-only for the `daytona` provisioner — zero new code here. Caveats: invite-only/experimental as of Jan 2026; wants Kubernetes, not raw VMs; the OSS full-self-host route is unmaintained since June 2026.
2. _Outside Daytona_ — a new `Provisioner` (`ssh` for raw VMs, `k8s` for clusters, per the axis diagram above): implement the six-method `Workspace` contract over ssh/scp, pass the Tier-2 conformance suite, and containment composes on top unchanged. The §8 image contract becomes a VM provisioning script.

---

## 3. Core interfaces

Repo idiom applies: Go-style `Context` from `src/internal/async` for cancellation/deadlines, throwing methods as the non-nil-error analogue, structural capability probing (patterns per `src/chat/deps.ts`).

```ts
interface Provisioner {
  name(): string;
  /** Host-side checks only, zero resources acquired: CLI/API key present, image
   *  resolvable. Pattern: orche openshell.ts:649 preflight; loomcli daytona
   *  repo-URL/API-key validation. */
  preflight(ctx: Context): Promise<void>;
  create(ctx: Context, spec: WorkspaceSpec): Promise<Workspace>;
}

interface Workspace {
  /** env crosses via opts.env; transports without an env flag (openshell 0.0.53
   *  exec has no --env) cross it as an in-guest `env K=V` argv prefix. */
  exec(ctx: Context, argv: string[], opts?: ExecOpts): Promise<ExecResult>;
  upload(ctx: Context, hostPath: string, guestPath: string): Promise<void>;
  download(ctx: Context, guestPath: string, hostPath: string): Promise<void>;
  /** Path conventions; orche precedent: repo=/sandbox/repo, home=/sandbox/.home
   *  (home pinned inside the workspace so harness JSONL is retrievable). */
  guestPath(kind: "repo" | "home" | "tmp"): string;
  /** Loopback rewrite for guest-reachable host URLs (host.docker.internal /
   *  host.containers.internal — orche openshell.ts:226). */
  hostAlias(hostUrl: string): string;
  /** Honors spec.retention; see lifecycle rules (§4) for when retention applies. */
  destroy(ctx: Context, outcome?: Outcome): Promise<void>;
}

interface Containment {
  name(): string;
  /** Runtime capability checks ONLY (CLI present, gateway Connected, provider
   *  registered), executed where containment runs — i.e. via the inner
   *  workspace's exec. Operator provisioning (e.g. `openshell provider create`
   *  with the real key) is explicitly OUT of preflight: one-time,
   *  credential-bearing, operator/orchestrator-owned. */
  preflight(ctx: Context, ws: Workspace): Promise<void>;
  /** Primitives consumed by the core compose() combinator (§5). Containments
   *  never hand-roll the Workspace decorator. */
  layer(policy: PolicySpec): ContainmentLayer;
  /** OPTIONAL: acquire containment resources (e.g. `openshell sandbox create`)
   *  and return a layer closed over them. env() prefers acquire over layer at
   *  lifecycle step 4 (§4); commands run via the inner workspace's exec
   *  (containment runs where inner runs, §5.1). Must best-effort delete its own
   *  half-created resources before rethrowing. NOTE (v1 scoping): preflight's
   *  gateway/provider check runs host-side via the injectable CliRunner while
   *  acquire runs via ws.exec — identical for a local inner, but a REMOTE
   *  provisioner would need preflight revisited (host-side check could
   *  false-positive for a differently-configured remote host). */
  acquire?(
    ctx: Context,
    ws: Workspace,
    policy: PolicySpec,
  ): Promise<ContainmentLayer>;
}

interface ContainmentLayer {
  execWrap(argv: string[], opts: ExecOpts): [string[], ExecOpts]; // e.g. prefix `openshell sandbox exec -n … --no-tty --workdir … -- env K=V …`
  crossUpload(stagingPath: string, guestPath: string): string[]; // argv run via inner exec, e.g. `openshell sandbox upload …`
  crossDownload(guestPath: string, stagingPath: string): string[];
  pathMap(kind: "repo" | "home" | "tmp"): string; // containment paths shadow inner paths
  teardown(): string[]; // argv via inner exec, e.g. `openshell sandbox delete <name>`
}

// core-owned:
function compose(inner: Workspace, layer: ContainmentLayer): Workspace;
```

`WorkspaceSpec`: image ref, labels, retention (`retention?: "always" | "keep-on-failure"` — ABSENT ⇒ destroy on both success and failure, the common case), auto-stop/auto-delete intervals (Daytona), and a **deterministic name** for crash recovery (orche `sandboxName` pattern, `openshell.ts:133` — a crashed run's leftover can be found and deleted before recreate).

`PolicySpec`: trust tier + filesystem/network policy inputs. The OpenShell policy generator is a straight port of orche `policy.ts` (filesystem read-only sets per tier, `run_as_user: sandbox`, landlock, per-binary network egress, the no-git-network-endpoint invariant).

### Shipped implementations

| Axis        | Impl        | Transport                                                                                                                                                                                                                             | Source ported                                                                                            |
| ----------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Provisioner | `local`     | `node:child_process` + fs copy (degenerate: host == guest)                                                                                                                                                                            | current behavior                                                                                         |
| Provisioner | `daytona`   | Daytona SDK — `client.create()`, `sandbox.process.executeCommand`, `sandbox.fs.*`, `sandbox.delete()`. loomcli imports `@daytona/sdk` (flue-bundled); the public npm package is `@daytonaio/sdk` — confirm which to declare before P4 | loomcli `daytona-task-runner.ts` (`DaytonaSandboxApi`, create/teardown, lines 122–147, 373–435, 300–308) |
| Containment | `none`      | identity                                                                                                                                                                                                                              | —                                                                                                        |
| Containment | `openshell` | `openshell` CLI via injectable `CliRunner` (no SDK exists)                                                                                                                                                                            | orche `openshell.ts` bottom half + `policy.ts`                                                           |

---

## 4. Lifecycle & failure semantics (core-owned)

The core `env()` factory drives the canonical acquisition order. Implementations never sequence this themselves.

```
1. provisioner.preflight            host-side, zero resources
2. provisioner.create      → inner Workspace                    ── resources exist from here
3. containment.preflight(inner)     runtime capability checks, via inner exec
4. compose(inner, layer)   → composed Workspace
   (optional Containment.acquire creates containment resources here — preferred
   over layer(policy) when present; acquire failure unwinds the inner)
5. injector.redactions() registered, THEN injector.apply(composedWs)
6. turns run (turn client, §7)
7. destroy: injector.cleanup → containment teardown → inner destroy
```

Ordering rules that are part of the contract, not implementation detail:

- **Redactions before apply** (step 5): a half-completed `apply()` can never emit an unredacted secret into logs.
- **Apply against the composed workspace**: a file-injected token must land _inside_ the containment boundary. Applying against the inner workspace would strand the credential on the provisioned machine — outside the agent's sandbox, readable by anything else on that machine, and invisible to the agent that needs it.
- **Strict reverse-acquisition teardown** (step 7): injector cleanup (idempotent, runs even after a half-failed apply) → containment teardown → inner destroy.

Failure rules:

- **Any failure in steps 2–5 unwinds all acquired layers in reverse order** — best-effort, errors aggregated, never short-circuited on the first teardown error.
- `retention: keep-on-failure` does **not** apply to setup failures. It exists to debug failed _runs_; a preflight or apply failure leaves nothing of debugging value inside the sandbox. Setup failures always destroy (an explicit debug-keep flag exists for rare investigation).
- Retention is evaluated only at step 7, on run outcomes.
- **Crash-between-stages** (host process dies): deterministic names + labels make any interrupted stage's resource identifiable; `sweep()` (§10, Tier 4) reaps orphans; Daytona's `autoStopInterval`/`autoDeleteInterval` (loomcli defaults: autoStop **15 min**, autoDelete **0 = disabled** — the vendor-side backstop is stop-only unless configured) limits billing exposure.

---

## 5. Composition

### 5.1 The operation-mapping table

`compose(inner, layer)` returns a `Workspace` in which **every** operation is defined in terms of inner-workspace operations. For openshell:

| Outer op                | Implementation via inner                                                                                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exec(argv, opts)`      | `layer.execWrap` → `openshell sandbox exec -n <name> --no-tty --workdir <path> -- env K=V… <argv>`, run via **inner exec**                                                   |
| `upload(host, guest)`   | inner `upload` to a **staging path** on the inner machine, then `layer.crossUpload` (`openshell sandbox upload --no-git-ignore …`) via inner exec across the policy boundary |
| `download(guest, host)` | symmetric: `layer.crossDownload` via inner exec to staging, then inner `download`                                                                                            |
| `guestPath(kind)`       | `layer.pathMap` — containment paths (`/sandbox/repo`, `/sandbox/.home`) **shadow** inner paths; inner paths become staging-only                                              |
| `hostAlias(url)`        | folds across **both** hops: true host → provisioned machine → contained sandbox                                                                                              |
| `destroy(outcome)`      | `layer.teardown()` via inner exec (`openshell sandbox delete` + bridge cleanup) **then** inner `destroy`; per-layer partial-failure handling per §4                          |
| `preflight`             | containment checks run via inner exec (they must run where containment runs)                                                                                                 |

Upload/download crossing as distinct verbs is not hypothetical — orche's implementation uses `openshell sandbox upload` (`openshell.ts:431-434`) and `sandbox download` (`openshell.ts:510`) precisely because exec cannot move files across the policy boundary.

### 5.2 Mechanics live in the core

Containments supply the `ContainmentLayer` primitives; the single core-owned `compose()` implements path-translation chaining, alias folding, staging management, and destroy ordering. Written once, tested once (§10 Tier 5): a new containment backend cannot get teardown ordering or staging cleanup subtly wrong, and pairwise implementation testing collapses into "test the combinator + test each layer's primitives".

"OpenShell inside a Daytona machine" then falls out of the table with zero new code — provided the openshell CLI and gateway are present in the Daytona image (an image-contract requirement, §8).

### 5.3 Trust locus under composition

The inner machine is the **containment host**: the OpenShell gateway, CLI, and operator-provisioned provider — which holds the _real_ model key for proxy injection — live wherever containment runs.

- Local provisioner → containment host is the true host. This is orche today.
- Daytona provisioner → the real key sits inside the Daytona machine: outside the agent's OpenShell boundary (the agent still cannot read it), but inside the vendor's infrastructure, and an agent that escapes the containment layer lands where the key lives.

This is a deliberate, documented trade-off, not an accident of the design. Mitigation guidance: use scoped, short-lived provider keys when composing on remote infrastructure; reserve long-lived operator keys for local containment hosts.

---

## 6. Credential contract

Not a closed enum baked into the core — that would freeze today's three mechanisms into the abstraction. The core exposes lifecycle **hooks**; delivery is an open interface:

```ts
interface CredentialInjector {
  /** Capabilities the target must advertise (e.g. "egress-proxy"); checked at
   *  compose time, so a mismatch fails before any resource is acquired. */
  requires(): Capability[];
  apply(ctx: Context, ws: Workspace): Promise<void>;
  /** Secrets registered for log redaction — registered BEFORE apply begins (§4). */
  redactions(): string[];
  /** Bound to destroy; idempotent; runs even on failure paths / half-failed apply. */
  cleanup(ctx: Context, ws: Workspace): Promise<void>;
}
```

Shipped implementations (implementations, not the abstraction):

- **proxy** — requires the `egress-proxy` capability that only openshell containment advertises. The operator provisions the provider once (`openshell provider create --name anthropic …`); the egress proxy injects the real key on the model host; the guest holds a placeholder. (orche `openshell.ts:694` inside `preflight()`, `README.md:100-109`; the provider _name_ is `anthropic`, its openshell _type_ is `claude-code`.)
- **file** — a short-lived scoped token written in-guest as a file (e.g. codex `~/.codex/auth.json` shaped `{ tokens: { access_token, refresh_token } }`), registered for redaction, removed on cleanup. Generalizes loomcli's Part C/D credential contract. Required for provisioners with no egress-policy control (Daytona) when the real CLI runs in-guest.
- **host** — nothing crosses; model calls happen host-side (loomcli's current host-driven Daytona mode).

Redaction, cleanup, and the leak probe stay core hooks because they are workspace-lifecycle concerns an orchestrator cannot retrofit from outside the abstraction.

**Leak probe as a shared utility.** One canonical sensitive-env-name list, one probe implementation (run in-guest, count sensitive names, fail the run on nonzero). Today that list is duplicated between loomcli `internal/driver/env.go:82` (`trustedLocalProviderCredentials`) and `daytona-task-runner.ts:1056` with a comment demanding manual sync — and the predicted drift has **already happened**: `CLAUDE_CODE_OAUTH_TOKEN` is in the Go list but absent from the TS probe. This design kills that class of drift.

---

## 7. Turn client (the consolidation payoff)

Host-side driver of one structured turn over any `Workspace`:

```ts
runStructuredTurn(ctx: Context, ws: Workspace, cfg: TurnConfig): Promise<StructuredTurnResult>
```

1. Write the prompt to a temp file; `ws.upload` it (prompt is **never** argv or shell-interpolated — the `--prompt-file` transport from `structured-runner.ts`).
2. `ws.exec` `meta-harness-structured-run --prompt-file <path> [--effort E] [--model M] [--permission-mode P] [--sandbox-defaults] <name> -- <harness args…>` with injection-safe argv construction (loomcli Part C's `argvToShell` discipline: strict single-quoting, unit-testable). `--sandbox-defaults` opts into the sandbox defaults (`IS_SANDBOX=1` for all harnesses, `--dangerously-skip-permissions` for claude-code only); without it, argv and env are forwarded verbatim. `--permission-mode` and `--sandbox-defaults` compose rather than conflict — when `--permission-mode` is also set it wins for argv (no `--dangerously-skip-permissions` emitted), while the `IS_SANDBOX=1` half still applies, unconditionally and independently of the resolved mode.
3. Parse the **last stdout line** as the structured result: `{ status, reply, harnessSessionID, transcript_entries, usage?, reason?, transcript_error?, permission_mode?, working_dir }` (`usage?` is additive telemetry, emitted since `structured-runner.ts:302` — it belongs in the frozen golden). `permission_mode?` is the rung the runner **launched** the harness at, computed from the composed argv plus the requested mode: a canonical rung (`plan` | `manual` | `ask` | `auto` | `bypass`), `"override"` when argv pins a posture no single token names, a claude-native off-ladder spelling passed through verbatim (`dontAsk`), or **absent** when nothing was requested and nothing injected. It is descriptive telemetry for audit and drift detection — **not** an authorization signal, not a readback of the live mode, and not round-trippable back into argv.
4. Optional transcript retrieval to a host path (orche's `retrieve()` pattern: download the guest `~/.claude/projects/<encodedCwd>/` JSONL so host-side readers resolve it).

**Protocol ownership.** The result schema and exit codes move to a shared protocol module imported by both the producer (`src/cli/structured-runner.ts`) and this client, with a golden-schema test. Frozen as the cross-repo contract — but note neither consumer parses the JSON _today_: orche's `packages/agent/src/harness/headless.ts` consumes the whole stdout as the reply text and only distinguishes exit 0 / non-zero / 124-or-`DeadlineLine` (`reply()` :377–399, `isWrapperDeadline` :409 — no last-line JSON, no exit-2 handling), and loomcli's in-guest parsing is Part C/D, spec'd not shipped. The freeze defines what consumers adopt; migrating orche from whole-stdout onto the structured schema is part of the P2/P3 consumer work, not a drop-in parser swap:

| Exit  | Meaning                                                                                      |
| ----- | -------------------------------------------------------------------------------------------- |
| `0`   | completed                                                                                    |
| `1`   | errored / startup failure / fatal                                                            |
| `2`   | usage: bad args, unknown harness, missing/empty prompt                                       |
| `124` | deadline — plus the **literal stderr line** `harness-wrapper run: context deadline exceeded` |

(Constants: `ExitOK/ExitError/ExitUsage/ExitDeadline`, `DeadlineLine` — `src/cli/structured-runner.ts:42-48`.)

---

## 8. Guest image contract

Consolidates orche's `sandbox/image/Dockerfile` and loomcli's Part D into one normative layout. Base reference: `src/cli/PACKAGING.md`.

Required in any guest image:

- `/opt/meta-harness/dist/**` — the built tree, pinned at a commit (loomcli's `META_HARNESS_COMMIT` pattern); `meta-harness-structured-run` resolvable on PATH (e.g. `/usr/local/bin/meta-harness-structured-run` → `node /opt/meta-harness/dist/cli/structured-runner.js`).
- `node-pty` built for the **guest** OS/arch/libc (a host-copied addon is invalid), co-located `ptyHost.mjs`, and `META_HARNESS_PTY_HOST=/opt/meta-harness/dist/wrapper/internal/ptyHost.mjs` in the image env (the env var's source of truth is `src/wrapper/internal/pty.ts:44` — PACKAGING.md doesn't document it).
- A `node` interpreter on PATH (§9: Node is the only guest runtime).
- Harness binaries (`claude`, `codex`, …) on PATH or via `HARNESS_BINARY_<NAME>`.
- Docker `LABEL`s advertising binary paths (orche `image/Dockerfile:56-60` convention) — consumed by OpenShell policy generation (per-binary egress rules need real paths).
- For composition targets: the `openshell` CLI + a configured gateway/provider (§5.3).
- An image smoke check: the PTY self-test (loomcli's `verifyStagedNodePTY` pattern) runs at build time so a broken addon fails the build, not the first turn.

Deliverables when implemented: a reference Dockerfile layer or install script owned by this repo, so consumers stop hand-maintaining parallel image recipes.

---

## 9. Runtime strategy: Node.js everywhere (decided)

The whole stack standardizes on Node.js.

- **The constraint that forced the issue:** node-pty's data stream is dead under Bun, and `bun build --compile` cannot embed the native `pty.node` addon (`src/cli/PACKAGING.md`, `src/wrapper/internal/pty.ts`) — every deployment already requires Node for the `ptyHost.mjs` bridge. Bun can never be the sole runtime here. Deno rejected: a third engine no consumer uses, unproven node-pty support, and a permission model that duplicates what OpenShell/Daytona enforce at a stronger boundary.
- **The env layer targets Node APIs directly** (`node:child_process`, `node:fs`, `node:stream`). Orche has already swapped its `Bun.spawnSync` CLI transport for Node `spawnSync` via `@orche/node-compat`, behind the injectable `OpenShellCli` seam (`openshell.ts:88-97`) — the port keeps that seam and calls `node:child_process` directly. **Decoupling:** largely moot in practice — orche's host side already runs Node (npm + vitest + tsx; production cutover tracked as ORCHE-100 Phase 4) — but the principle stands: shipping the env layer never blocks on, and is never blocked by, any remaining runtime migration.
- **Guest runtime: Node only.** `meta-harness-structured-run` (Node, consumes `dist/`) is _the_ guest entrypoint. `run.ts` is already a Node CLI (`#!/usr/bin/env node`, shipped as the `meta-harness-run` bin) — the dual bun+node image requirement is historical. Residual cleanup: stale "Bun-only" comments in `structured-runner.ts:7,46` and the bun+node guest Dockerfile in orche's image.
- **Consumer migration (separate track, own timeline):** orche@dev already pins meta-harness v0.1.5 and, running under Node, resolves the package through the `import` condition to `dist/**`; the bun-first conditional `exports` map stays only until no consumer runs under Bun (ORCHE-100 Phase 4), then gets removed. loomcli's TS leaf is already Node (flue `--target node`). Env-layer delivery (§13 P1–P5) does not depend on this track.
- **Dev/test: done.** meta-harness migrated to Node/vitest at v0.1.5 (commits `8d6cffa`, `8ec3479`; `bunfig.toml` retired) — the runner is vitest, not `node --test`.

---

## 10. Testing strategy

Five tiers; the pluggability claim is only as strong as Tier 2.

### Tier 1 — unit, hermetic (every PR)

All transports injectable, following patterns both consumers already proved:

- **env-openshell:** injectable `CliRunner` (orche's `OpenShellCli` pattern, `openshell.ts:88`) with scripted responses. Assert exact argv for create/exec/upload/download/delete; env crossing as the in-guest `env K=V` prefix (0.0.53 exec has no `--env`); host-alias rewrite; **policy YAML golden tests** — new work, not a port: orche's `sandbox-policy.test.ts` is `toContain`-assertion-based, no golden fixtures exist; cover filesystem tiers, landlock, per-binary egress, the no-git-network-endpoint invariant.
- **env-daytona:** injectable SDK (loomcli's `DAYTONA_SDK_IMPORT` override, `daytona-task-runner.ts:311`) with a fake client. Assert create labels / autoStop / autoDelete defaults, fs/process call mapping, destroy-in-`finally`, `keep-on-failure` retention.
- **Turn client:** fake `Workspace`. Injection-safe argv against hostile prompts (quotes, newlines, leading dashes — loomcli's `argvToShell` cases); last-JSON-line parsing (noise before it, multiple JSON lines, non-JSON tail, truncated output); exit-code mapping including 124 + `DeadlineLine`.
- **Credential contract:** file delivery writes → redaction registration → removal on destroy; **one canonical sensitive-env list** with a test asserting the leak-probe implementation uses exactly it.

### Tier 2 — conformance suite (the pluggability guarantee)

One shared spec every `Provisioner`/`Containment` implementation must pass, parameterized over implementations — this is what makes "swap Daytona for X" safe. Pins:

- exec exit-code/stdout/stderr fidelity;
- binary-safe upload/download round-trip (including a `.git` directory and executable bits);
- `guestPath` conventions; destroy idempotency (double-destroy, destroy-after-crash); retention semantics; preflight failure modes;
- the **setup-failure unwind matrix**: inject a failure at each acquisition stage (create / containment preflight / compose / injector apply) and assert every previously acquired layer is destroyed in reverse order, errors aggregated, redactions active from before apply.

Runs against `local` always; against Tier-1 fakes for daytona/openshell on every PR; against real backends in Tier 4.

### Tier 3 — in-guest e2e without cloud (every PR where docker/podman is available)

A test-only **container Workspace** (plain `docker run`/`exec`/`cp` transport) plus the existing `fakeharness` gives the full round-trip hermetically: build a minimal guest image (Node + dist + guest-arch node-pty + ptyHost + fakeharness as the "CLI"), drive `runStructuredTurn` through the env layer, assert reply + transcript + session id come back. This exercises exactly what unit tests cannot — a real PTY in-guest, addon/arch match, image layout — with no API keys. The PTY self-test runs as the image smoke check.

### Tier 4 — live gated (nightly / opt-in; never default CI)

Gating à la loomcli: `META_HARNESS_ENV_LIVE=daytona` + `DAYTONA_API_KEY`; `=openshell` + a Connected gateway. Real create → conformance suite → fakeharness turn → destroy. **Leak-and-billing safeguards are part of the suite:** deterministic names + labels; aggressive `autoStopInterval`/`autoDeleteInterval` in tests; and a tested `sweep()` (orche crash-recovery pattern) that reaps leaked test sandboxes so a red run cannot bill indefinitely.

### Tier 5 — security & cross-repo regression

- Leak probe e2e: plant a sensitive env var host-side, assert the run fails with the leak error (Tier 3 container variant; Tier 4 live variant).
- Proxy mode: guest env holds only the placeholder key. File mode: credential file gone after destroy.
- **Protocol freeze:** structured-runner JSON schema golden shared by producer and turn client; exit codes 0/1/2/124 + the literal `DeadlineLine` asserted — the contract orche `headless.ts` and loomcli's parser will adopt (neither parses the JSON today, §7).
- **Composition:** the core `compose()` combinator is tested **once** against fake layers for the full mapping table (§5.1) — path-translation chaining, alias folding across hops, outer-then-inner destroy with neither layer leaked on partial failure. Each containment's primitives are then unit-tested in isolation (openshell primitives against the scripted `CliRunner`). Pairwise live composition (openshell-in-daytona) is an optional P5 variant.

---

## 11. Packaging

- New subpath exports: `./env` (interfaces + `local` + turn client + presets), `./env-daytona` (the Daytona SDK as an optional peer dependency — public npm name is `@daytonaio/sdk`; loomcli's `@daytona/sdk` import is a flue-bundled alias, verify at P4), `./env-openshell` (CLI shell-out; no SDK dependency). Consumers that never touch Daytona pay nothing for its SDK.
- Golden-surface discipline: the env layer gets its own exported-surface golden alongside `test/testdata/ts_surface.golden`; `exports-guard` extended so no barrel leaks `src/internal/**`.

---

## 12. Boundaries — what stays in orchestrators

- **Publish semantics.** Orche: in-guest git bundle → host-side validation → CAS ref update. Loomcli: `git diff --binary` patch artifact / GitHub PR. Different trust models, both legitimate; forcing agreement would turn this library into an orchestrator framework. If they converge later, orche's three-contract `ActiveSandbox` (materialize/execute/complete) is the candidate to migrate down _on top of_ this layer.
- **Task claiming, scheduling, ticket↔sandbox mapping, heartbeats, stale-run sweeping** (loomcli `StaleTaskSweeper` etc.).
- **Retention policy decisions** (the env layer implements the mechanism; the orchestrator decides the policy).
- **Credential minting** — which keys exist, their scope and lifetime. The env layer standardizes _delivery_ (§6), never acquisition.

---

## 13. Migration phases

| Phase | Deliverable                                                                                                            | Unblocks                                                                         |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P1    | `./env` core: interfaces, lifecycle engine (§4), `compose()`, `local` provisioner, Tier-1/2 tests                      | everything below                                                                 |
| P2    | Turn client + shared protocol module (extracted from `structured-runner.ts`) + protocol goldens                        | consumers replacing hand-rolled parsers                                          |
| P3    | `./env-openshell`: port bottom half of orche `openshell.ts` (~790 LOC) + `policy.ts`; orche migrates as first consumer | deletes orche's bespoke transport                                                |
| P4    | `./env-daytona`: port loomcli `DaytonaSandboxApi` + create/teardown; file-credential injector                          | loomcli Part C/D lands as a consumer of this layer instead of a reimplementation |
| P5    | Composition hardening (openshell-in-daytona live variant), guest-image reference layer, docs                           | remote + contained tier                                                          |

Sequencing note: loomcli only benefits once its TS leaf is the execution path (`LOOM_DAEMON_LEAF=ts`, default-off — `tsruntime.go:33`) — the default in-process Go invoker never sees this layer, and loomcli `main` carries none of the meta-harness leaf code (it all lives on `feat/meta-harness-node-leaf`).

---

## 14. Open questions

1. **Streaming exec.** One-shot turns need only buffered exec + exit code. Interactive `Conversation` over a remote environment would need a streaming byte transport into the host-side `Screen` — deliberately out of scope; revisit if a consumer needs remote interactive sessions.
2. **`Backend` in `src/chat/deps.ts`.** `Open` currently bypasses its own `Backend` seam (hardcodes `wrapperStart`). An env-backed `Backend` implementation is the natural follow-on if question 1 is ever answered "yes"; wiring `Open` to accept an injected `Backend` is worth doing for testability regardless.
3. **Daytona snapshot/fork.** Daytona supports snapshot/restore and forking; nothing in `Workspace` models it. Expose as an optional capability (`Snapshottable`) only when a consumer has a concrete use (e.g. warm pools, retry-from-snapshot).
4. **Warm pools.** Both consumers do one-sandbox-per-run today. Pooling changes lifecycle invariants (deterministic names, sweep semantics) — out of scope until someone needs it.

---

## Appendix: provenance map

| Design element                                                                         | Source generalized                                                                                                                                                                                   |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-axis split (placement × containment)                                               | loomcli `internal/driver/task_scheduling.go:208-219` (`flue-daytona` profile: `RunnerPlacement`=flue, `SandboxPlacement`=daytona; type `domain.TaskRunPlacement`, `internal/domain/platform.go:541`) |
| `Sandbox`/`ActiveSandbox` seam shape                                                   | orche `packages/agent/src/sandbox/index.ts`                                                                                                                                                          |
| OpenShell transport, upload/download verbs, host-alias, deterministic names, retention | orche `packages/agent/src/sandbox/openshell.ts`                                                                                                                                                      |
| Policy generation                                                                      | orche `packages/agent/src/sandbox/policy.ts`                                                                                                                                                         |
| Daytona create/teardown, SDK injection, autoStop/autoDelete, leak probe                | loomcli-mh-v5 `internal/workflows/builtin/daytona-task-runner.ts`                                                                                                                                    |
| File-based credential contract, prompt-file transport, injection-safe argv             | loomcli-mh-v5 `docs/design/meta-harness-sandbox-runner.md` (Parts C/D)                                                                                                                               |
| Structured-turn protocol + exit codes                                                  | this repo `src/cli/structured-runner.ts`                                                                                                                                                             |
| Guest runtime constraints (node-pty/Bun, ptyHost, addon-on-disk)                       | this repo `src/cli/PACKAGING.md`, `src/wrapper/internal/pty.ts`                                                                                                                                      |
| Image LABEL convention                                                                 | orche `packages/agent/src/sandbox/image/Dockerfile:56-60`                                                                                                                                            |
