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
