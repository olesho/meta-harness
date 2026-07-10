// Core environment-layer interfaces (design §3, §6).
//
// The two orthogonal axes — a `Provisioner` (WHERE the machine comes from) and a
// `Containment` (WHAT the agent may touch) — meet at the `Workspace` contract: an
// exec + file-transfer transport onto a machine. A `Containment` decorates the
// FULL Workspace contract by contributing a `ContainmentLayer` of primitives; the
// core-owned `compose()` (see ./compose.ts) does the actual decoration so no
// containment ever hand-rolls a Workspace wrapper.
//
// Repo idiom: Go-style `Context` for cancellation/deadlines (imported type-only
// via the sanctioned public seam), throwing methods as the non-nil-error
// analogue, structural capability probing for optional layer primitives.

import type { Context } from "../async/index.ts"

/** How a run's resources are retained at destroy time (design §4).
 *
 *  ABSENT (the common case) ⇒ destroy on BOTH success and failure. Mirrors
 *  orche's `sandboxRetention?: 'destroy' | 'keep-on-failure'` (`?? 'destroy'`). */
export type Retention = "always" | "keep-on-failure"

/** The result of a run, driving retention and teardown decisions.
 *
 *  `setup-failure` is distinct because a preflight/apply failure leaves nothing
 *  of debugging value inside the sandbox — it ALWAYS destroys, ignoring
 *  `retention` (design §4). Debug-keep for setup failures is out of scope. */
export type Outcome = "success" | "failure" | "setup-failure"

/** A capability a credential injector's target must advertise (e.g.
 *  "egress-proxy"). Open string, not a closed enum (design §6). */
export type Capability = string

export interface ExecOpts {
  /** Environment overlaid on the guest process. Transports without an env flag
   *  cross it as an in-guest `env K=V` argv prefix (design §3). */
  env?: Record<string, string>
  /** Working directory for the guest process; defaults to the repo path. */
  cwd?: string
  /** Data written to the process's stdin, then closed. */
  stdin?: string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Inputs for creating a Workspace. Carries a deterministic name for crash
 *  recovery (orche `sandboxName` pattern) so a crashed run's leftover can be
 *  found and deleted before recreate. */
export interface WorkspaceSpec {
  /** Image / snapshot reference the machine boots from. */
  image: string
  /** A DETERMINISTIC name (crash recovery): identifies an interrupted stage's
   *  resource across a host-process death. */
  name: string
  /** Labels stamped on the resource for sweep/identification. */
  labels?: Record<string, string>
  /** Daytona auto-stop interval, minutes (0 disables). Vendor-side billing
   *  backstop; ignored by provisioners without one. */
  autoStopInterval?: number
  /** Daytona auto-delete interval, minutes (0 disables). */
  autoDeleteInterval?: number
  /** Retention policy. ABSENT ⇒ destroy on both success and failure. */
  retention?: Retention
}

/** Trust tier + filesystem/network policy inputs handed to a containment's
 *  layer generator. `none` ignores it entirely. */
export interface PolicySpec {
  tier?: string
  [k: string]: unknown
}

export interface Provisioner {
  name(): string
  /** Host-side checks only, zero resources acquired: CLI/API key present, image
   *  resolvable (design §3). */
  preflight(ctx: Context): Promise<void>
  create(ctx: Context, spec: WorkspaceSpec): Promise<Workspace>
}

export interface Workspace {
  /** env crosses via opts.env; transports without an env flag cross it as an
   *  in-guest `env K=V` argv prefix. */
  exec(ctx: Context, argv: string[], opts?: ExecOpts): Promise<ExecResult>
  upload(ctx: Context, hostPath: string, guestPath: string): Promise<void>
  download(ctx: Context, guestPath: string, hostPath: string): Promise<void>
  /** Path conventions; orche precedent: repo=/sandbox/repo, home=/sandbox/.home. */
  guestPath(kind: "repo" | "home" | "tmp"): string
  /** Loopback rewrite for guest-reachable host URLs. */
  hostAlias(hostUrl: string): string
  /** Honors spec.retention; see lifecycle rules (§4) for when retention applies. */
  destroy(ctx: Context, outcome?: Outcome): Promise<void>
}

export interface Containment {
  name(): string
  /** Runtime capability checks ONLY, executed via the inner workspace's exec —
   *  i.e. where containment runs. Operator provisioning is out of preflight. */
  preflight(ctx: Context, ws: Workspace): Promise<void>
  /** Primitives consumed by the core compose() combinator (§5). Containments
   *  never hand-roll the Workspace decorator. */
  layer(policy: PolicySpec): ContainmentLayer
  /** OPTIONAL (structurally probed): acquire containment resources (e.g.
   *  `openshell sandbox create`) and return a layer CLOSED OVER them. env()
   *  prefers acquire over layer at lifecycle step 4 — "containment resources
   *  exist from here". Runs its commands via the inner workspace's exec
   *  (containment runs where inner runs, §5.1). Must best-effort delete its own
   *  half-created resources before rethrowing so a failed acquire never leaks. */
  acquire?(ctx: Context, ws: Workspace, policy: PolicySpec): Promise<ContainmentLayer>
}

export interface ContainmentLayer {
  /** Wrap an exec, e.g. prefix `openshell sandbox exec -n … -- env K=V …`. An
   *  IDENTITY layer returns [argv, opts] unchanged. */
  execWrap(argv: string[], opts: ExecOpts): [string[], ExecOpts]
  /** Argv (run via inner exec) that moves a staged file across the policy
   *  boundary to guestPath. Return [] to signal NO boundary — compose uploads
   *  straight to guestPath via the inner workspace. */
  crossUpload(stagingPath: string, guestPath: string): string[]
  /** Symmetric download crossing. [] ⇒ no boundary. */
  crossDownload(guestPath: string, stagingPath: string): string[]
  /** Containment paths shadow inner paths. Return "" to defer to the inner
   *  path (identity containment). */
  pathMap(kind: "repo" | "home" | "tmp"): string
  /** Argv (run via inner exec) tearing the containment down, e.g. `openshell
   *  sandbox delete <name>`. [] ⇒ nothing to tear down. */
  teardown(): string[]
  /** OPTIONAL (structurally probed): the containment's own host-URL rewrite,
   *  folded on top of the inner's for a two-hop alias (design §5.1). */
  aliasMap?(hostUrl: string): string
}

export interface CredentialInjector {
  /** Capabilities the target must advertise; checked before any resource is
   *  acquired (design §6). */
  requires(): Capability[]
  apply(ctx: Context, ws: Workspace): Promise<void>
  /** Secrets registered for log redaction — registered BEFORE apply begins (§4). */
  redactions(): string[]
  /** Bound to destroy; idempotent; runs even on failure paths / half-failed
   *  apply. */
  cleanup(ctx: Context, ws: Workspace): Promise<void>
}

/** Sink for secret strings to scrub from logs. The core registers every
 *  injector's redactions() here BEFORE any apply() (design §4). */
export interface Redactor {
  register(secret: string): void
}

/** Selectors + optional policy/credential wiring handed to the core env()
 *  factory. */
export interface EnvConfig {
  provision: Provisioner
  contain: Containment
  spec: WorkspaceSpec
  policy?: PolicySpec
  injectors?: CredentialInjector[]
  /** Where injector redactions are registered. Defaults to a no-op sink. */
  redactor?: Redactor
}

/** The acquired environment handed back by env(): the composed workspace plus a
 *  retention-honoring, reverse-order destroy. */
export interface Environment {
  workspace: Workspace
  destroy(ctx: Context, outcome?: Outcome): Promise<void>
}
