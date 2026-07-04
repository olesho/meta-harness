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

Run directly with Bun:

```sh
echo "your prompt" | bun src/cli/run.ts claude -- --some-harness-flag
```

## `bun build --compile` is NOT self-contained here

Evaluated: `bun build --compile ./src/cli/run.ts --outfile meta-harness-run`
produces a single executable that embeds the JS, but it is **not** a standalone
binary for this project. The transitive dependency `node-pty` (via
`src/wrapper/internal/pty.ts`) has two runtime requirements Bun cannot inline:

1. **A `node` interpreter on PATH.** Under Bun, node-pty does not drive the pty
   in-process; it spawns a helper bridge `node ptyHost.mjs` (see
   `src/wrapper/internal/ptyHost.mjs`). That bridge is launched with `node`, so
   the image must ship a Node.js runtime even though the CLI itself runs on Bun.
   (Background: node-pty's native data stream is dead under Bun — see the
   `meta-harness-node-pty-bun-broken` note — hence the out-of-process bridge.)

2. **The native `.node` addon on disk.** node-pty loads its compiled addon
   (`pty.node`) from the filesystem via `require`/`dlopen`. `bun --compile`
   cannot embed a `.node`; the addon must exist as a real file next to the
   materialized `node_modules/node-pty` (matching the image's libc/arch).

### Residual runtime deps the image MUST provide

- the `bun` runtime (or the compiled `meta-harness-run` executable),
- a `node` interpreter on `PATH`,
- `src/wrapper/internal/ptyHost.mjs` materialized on disk,
- the `node-pty` package with its built `pty.node` addon for the image's
  platform/arch,
- the harness binaries themselves (`claude`, `codex`) on `PATH`, or their paths
  supplied via `HARNESS_BINARY` / `HARNESS_BINARY_<NAME>`.

### Recommended image layout

Ship the meta-harness source tree (or `node_modules` install) plus Bun and Node,
and invoke `bun /app/src/cli/run.ts …`. Do not rely on a lone `--compile` output.
If a compiled binary is desired for startup speed, still co-locate `node`,
`ptyHost.mjs`, and the `pty.node` addon alongside it.

## Config knobs (env)

- `HARNESS_WRAPPER_RUN_TIMEOUT` — Go duration (default `15m`) → run deadline.
- `HARNESS_BINARY` / `HARNESS_BINARY_CLAUDE_CODE` / `HARNESS_BINARY_CODEX` —
  override the resolved harness executable path.
- `CLAUDECODE` / `CLAUDE_CODE_*` are stripped from the child harness env
  (env-clean), mirroring the Go `run.go` one-shot.
