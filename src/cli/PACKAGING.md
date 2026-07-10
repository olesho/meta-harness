# Packaging the `run` CLI (META-HARNESS-12)

`src/cli/run.ts` is the separate-process one-shot mode: a disposable CLI baked
into a container image and `exec`'d once per turn by the orchestrator's OpenShell backend.
This note documents what the image-build ticket (orchestrator side) must materialize.

## What the CLI is

A thin wrapper around the shared one-shot loop (`meta-harness/oneshot`):

- prompt on **stdin** → clean reply on **stdout**
- grammar `run [--effort E] [--model M] <name> -- <harness args...>`
- exit codes matching the orchestrator's `packages/agent/src/harness/headless.ts` parser:
  `0` ok · `1` errored/fatal/stdin-fail · `2` usage/resolve/empty-prompt ·
  `124` deadline (+ the literal stderr line `harness-wrapper run: context
  deadline exceeded`, which fires BOTH of the orchestrator's timeout signals).

Run directly with Node (against the compiled `dist`):

```sh
npm run build
echo "your prompt" | node dist/cli/run.js claude -- --some-harness-flag
```

## The image is NOT a single self-contained binary

The CLI runs on Node from the compiled `dist/cli/run.js`. There is no
`--compile` single-file executable: the transitive dependency `node-pty` (via
`src/wrapper/internal/pty.ts`) has two runtime requirements that cannot be
inlined into one file:

1. **A `node` interpreter on PATH.** node-pty spawns a helper bridge
   `node ptyHost.mjs` (see `src/wrapper/internal/ptyHost.mjs`) rather than
   driving the pty in-process. The bridge is launched with `node`, so the image
   must ship a Node.js runtime. (Historical background: node-pty's native data
   stream was dead under Bun — see the `meta-harness-node-pty-bun-broken` note —
   which is why the out-of-process bridge was introduced. The bridge remains in
   place and is still safe under Node, so the CLI keeps using it.)

2. **The native `.node` addon on disk.** node-pty loads its compiled addon
   (`pty.node`) from the filesystem via `require`/`dlopen`. The addon must exist
   as a real file next to the materialized `node_modules/node-pty` (matching the
   image's libc/arch); it cannot be embedded.

### Residual runtime deps the image MUST provide

- a `node` interpreter on `PATH` (runs both the CLI and the pty bridge),
- the compiled `dist/**` (or the source tree + an install to build it),
- `src/wrapper/internal/ptyHost.mjs` materialized on disk,
- the `node-pty` package with its built `pty.node` addon for the image's
  platform/arch,
- the harness binaries themselves (`claude`, `codex`) on `PATH`, or their paths
  supplied via `HARNESS_BINARY` / `HARNESS_BINARY_<NAME>`.

### Recommended image layout

Ship the built `dist/**` (or the meta-harness source tree plus a `node_modules`
install and `npm run build`) plus a Node.js runtime, and invoke
`node /app/dist/cli/run.js …`. Co-locate `node`, `ptyHost.mjs`, and the
`pty.node` addon so the pty bridge can start.

## Config knobs (env)

- `HARNESS_WRAPPER_RUN_TIMEOUT` — Go duration (default `15m`) → run deadline.
- `HARNESS_BINARY` / `HARNESS_BINARY_CLAUDE_CODE` / `HARNESS_BINARY_CODEX` —
  override the resolved harness executable path.
- `CLAUDECODE` / `CLAUDE_CODE_*` are stripped from the child harness env
  (env-clean), mirroring the Go `run.go` one-shot.

## Downstream consumer pin (Orche) — META-HARNESS-33

The Bun→Node migration (META-HARNESS-30/31/32) is downstream-consumed by the
**Orche** repo, which installs meta-harness as a `github:` dependency and imports
the built `dist/**` over the `exports` map under `node` (e.g.
`import('meta-harness/chat')` from `packages/agent`). Phase 4 of the migration is
bumping Orche's pin from the pre-migration release to the migrated commit.

**Migrated commit** (Bun→Node, `dist/**` rebuilt incl. `dist/cli/run.js`):

- `dev` HEAD `9e61ec6b632987c3e0356055ae5a23e16a8cbb09` (`meta-harness@0.1.3`).
- Supersedes the old pin `8c608b0ff32d0332a2d4714ce4742c715158f8d7`
  (`chore: release v0.1.3`), which is a clean ancestor — a forward bump spanning
  the whole migration, no version change.

**Edits on the Orche side** (repo `olesho/orche`). The pin appears in *two*
workspace manifests — bump both so the whole workspace resolves one meta-harness
install (a split pin would materialize two copies):

```diff
--- a/packages/agent/package.json
+++ b/packages/agent/package.json
-    "meta-harness": "github:olesho/meta-harness#8c608b0ff32d0332a2d4714ce4742c715158f8d7"
+    "meta-harness": "github:olesho/meta-harness#9e61ec6b632987c3e0356055ae5a23e16a8cbb09"
--- a/apps/web/package.json
+++ b/apps/web/package.json
-    "meta-harness": "github:olesho/meta-harness#8c608b0ff32d0332a2d4714ce4742c715158f8d7"
+    "meta-harness": "github:olesho/meta-harness#9e61ec6b632987c3e0356055ae5a23e16a8cbb09"
```

**Lockfile.** Refresh with `npm install` (regenerates `package-lock.json`) — do
**not** hand-edit: the `node_modules/meta-harness` entry carries an `integrity`
sha512 over the packed git tarball that can only be computed by fetching the
commit. `npm install` rewrites all three touchpoints (the two manifest mirrors +
the `node_modules/meta-harness` `resolved`/`integrity`/`version`).

**Precondition.** The `github:` spec resolves from GitHub `olesho/meta-harness`,
so `dev` (`9e61ec6`) must be pushed there before Orche's `npm install` /
`npm ci` can fetch it. Publishing `dev` and pushing to Orche are outside this
ticket's worktree (and this environment has no GitHub fetch), so the `npm
install` regen + the Orche agent-suite run happen once the migration branch is
published.

**Verification done here (against the migrated tree, commit `9e61ec6`).**
`npm run verify:exports` (`scripts/verify-exports.mjs`) imports every public
subpath under plain Node; all 10 load, including the one Orche depends on:

```
OK  meta-harness/chat        37 exports  (./dist/chat/index.js)
...
verify-exports: all 10 public subpath exports load under Node
```

That is the acceptance check `import('meta-harness/chat')` under Node, exercised
against exactly the code Orche's bumped pin will install.
