# `meta-harness-run` (the `run` CLI)

The separate-process one-shot mode: a thin, disposable CLI that reads a prompt on
**stdin**, drives exactly one harness turn via the [one-shot loop](oneshot.md), and writes
the clean reply to **stdout**. It exists to be baked into a container image and `exec`'d
once per turn by an orchestrator — its exit codes and a fixed stderr line are the contract
that orchestrator parses.

Source: [`src/cli/run.ts`](../../../src/cli/run.ts). It runs on **Node** from the
compiled [`dist/cli/run.js`](../../../dist/cli/run.js) (declared as the package `bin`
`meta-harness-run`).

---

## Usage

```
run [--effort E] [--model M] <name> -- <harness args…>
```

```bash
echo "Summarize README.md in one sentence." | node dist/cli/run.js claude -- --some-flag
```

- **stdin** → the prompt; **stdout** → the clean reply (trailing newline ensured).
- Flags (`--effort`, `--model`) sit **before** `<name>`.
- `<name>` is a short alias: `claude` → `claude-code`, `codex` → `codex`. Anything else is
  a usage error.
- Everything after `--` is forwarded verbatim to the harness.
- `--help` / `-h` prints help and exits `0`.

---

## Exit codes

The codes match the orchestrator's headless parser exactly:

| Code | Meaning | stderr |
| --- | --- | --- |
| `0` | Turn completed; reply on stdout. | — |
| `1` | Turn errored / fatal / stdin read failure. | `run: <message>` |
| `2` | Usage error: bad args, unknown harness, or empty prompt. | `run: <message>` |
| `124` | Deadline: the run's context deadline fired. | `harness-wrapper run: context deadline exceeded` |

The literal line **`harness-wrapper run: context deadline exceeded`** on exit `124` is an
anchor the orchestrator matches to detect a timeout — it is intentionally the Go wrapper's
wording, and it satisfies both of the orchestrator's timeout signals.

---

## Configuration (environment)

| Variable | Default | Effect |
| --- | --- | --- |
| `HARNESS_WRAPPER_RUN_TIMEOUT` | `15m` | Run deadline, as a Go duration (`15m`, `90s`, `1h30m`). Invalid → default. |
| `HARNESS_BINARY_<NAME>` | — | Override the binary for a specific harness, e.g. `HARNESS_BINARY_CLAUDE_CODE`. Takes precedence over `HARNESS_BINARY`. |
| `HARNESS_BINARY` | — | Override the resolved harness binary path (absolute or a PATH name). |
| `CLAUDECODE`, `CLAUDE_CODE_*` | — | Stripped from the child harness env (via [`cleanEnv`](oneshot.md#environment-helpers)) so a nested run is clean. |

Binary resolution defers to the [discovery SSOT
`resolvePath()`](discovery.md#resolving-the-binary-path). Order: a path-bearing name is
checked directly → `HARNESS_BINARY_<HARNESS>` → `HARNESS_BINARY` (an *absolute* env
override is verified directly and does **not** fall through on a miss; a bare-name
override is searched on `PATH` only) → the live `PATH` → the well-known install
directories (`WELL_KNOWN_DIRS`: `~/.claude/local/bin`, `~/.local/bin`,
`/opt/homebrew/bin`, `/usr/local/bin`).

---

## What it does

1. Parse args; `--help` → print + exit `0`; a grammar error → stderr + exit `2`.
2. Resolve the short name to a harness (`resolveHarnessName`); unknown → exit `2`.
3. Read the whole prompt from stdin; read failure → exit `1`; empty → exit `2`.
4. Resolve the binary and parse the timeout, then build a
   `Context.withDeadline(background, timeoutMs)`.
5. Call [`runOneShot`](oneshot.md#runoneshot) with the cleaned env.
6. Map the result: success → stdout + `0`; `DeadlineError` → the deadline line + `124`;
   `EmptyPromptError` → `2`; `TurnErroredError` / anything else → stderr + `1`.

---

## Packaging

This is where the [PTY bridge](../architecture.md#the-pty-bridge) constraint bites.
**node-pty needs Node and a native addon**, so there is no single self-contained
binary. An image that runs this CLI must provide:

- a **`node`** interpreter on `PATH` (runs the CLI and node-pty's `node ptyHost.mjs` bridge),
- the compiled **`dist/**`** (or the source tree plus an install and `npm run build`),
- [`ptyHost.mjs`](../../../src/wrapper/internal/ptyHost.mjs) materialized on disk,
- the **`node-pty`** package with its built `pty.node` addon for the image's libc/arch,
- the **harness binaries** (`claude`, `codex`) on `PATH`, or their paths via
  `HARNESS_BINARY*`.

Recommended layout: ship the built `dist/**` (or the meta-harness source tree plus an
installed `node_modules`) and a Node runtime, and invoke `node /app/dist/cli/run.js …`.
The authoritative note is [`src/cli/PACKAGING.md`](../../../src/cli/PACKAGING.md).
