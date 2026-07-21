# `meta-harness-wrapper` (the wrapper CLI)

A supervised-process front end over a single harness run. It is the CLI parity port of
Go's `cmd/harness-wrapper`: it launches a harness (`claude`, `codex`, `opencode`, `pi`)
under PTY supervision and, by default, hands the terminal straight through to it —
**foreground supervised TTY passthrough**. On top of that default it adds tmux-detached
subcommands, trace capture, and a delegated one-shot `run` mode.

Source: [`src/cli/wrapper.ts`](../../../src/cli/wrapper.ts), with flag parsing in
[`src/cli/wrapperFlags.ts`](../../../src/cli/wrapperFlags.ts) and the tmux machinery in
[`src/cli/tmux.ts`](../../../src/cli/tmux.ts). It runs on **Node** from the compiled
[`dist/cli/wrapper.js`](../../../dist/cli/wrapper.js) (declared as the package `bin`
`meta-harness-wrapper`).

> This documents the `meta-harness-wrapper` **binary**. The
> [`wrapper`](wrapper.md) doc (`meta-harness/wrapper`) documents the separate PTY
> supervision **library** — different subject, similar name.

---

## Usage

```
usage: meta-harness-wrapper [wrapper-flags] <name> -- <harness args>
       meta-harness-wrapper run <name> [wrapper-flags] -- <harness args>   (prompt on stdin)
       meta-harness-wrapper attach <session>
       meta-harness-wrapper status <session> [--json]
       meta-harness-wrapper kill <session>
       meta-harness-wrapper list
```

Wrapper flags must come **before** the harness name. Supported harness names: `claude`,
`codex`, `opencode`, `pi`.

The first positional argument selects the mode: the tmux subcommands (`attach`, `status`,
`kill`, `list`) and the one-shot `run` mode don't follow the `<name> -- <args>` shape, so
they are routed in a pre-parser switch ([`src/cli/wrapper.ts`](../../../src/cli/wrapper.ts),
mirroring Go's `main.go` dispatch). Anything else falls through to the default foreground
passthrough.

## Foreground passthrough (default)

With no tmux flag and no `run`/tmux subcommand, the wrapper runs the harness in the
foreground with the parent's TTY passed through, supervising it for status/exit
classification. This is the everyday interactive mode.

## Tmux-detached mode

`--tmux-session <NAME>` spawns the run inside a **detached** tmux session named
`mh-<NAME>` (the `mh-` prefix lives in [`src/cli/tmux.ts`](../../../src/cli/tmux.ts)) and
exits immediately, so a long-running agent keeps going after you disconnect. Manage the
detached session with the subcommands:

- `attach <session>` — reconnect to a detached session (equivalent to `tmux attach -t mh-<NAME>`).
- `status <session> [--json]` — report whether the session is alive.
- `kill <session>` — terminate the session.
- `list` — list the wrapper's `mh-`-prefixed sessions.

## Tracing

- `--trace-file <PATH>` — write trace events as NDJSON to `PATH`.
- `--trace-stderr` — write trace events as NDJSON to stderr (**mutually exclusive** with
  `--trace-file`).

By default trace events are **dropped**, because writing to stderr would corrupt an
interactive harness TUI. In tmux mode, trace events default to
`~/.meta-harness/sessions/<NAME>.trace.ndjson`. The trace path environment marker is
`META_HARNESS_TRACE_FILE` ([`src/cli/tmux.ts`](../../../src/cli/tmux.ts)).

## Harness tuning

- `--effort <low|medium|high|xhigh|max>` — reasoning effort for supported harnesses.
- `--model <id>` — model id for supported harnesses (`claude --model`, `codex -c model`).

## `run` — delegated one-shot mode

`meta-harness-wrapper run <name> ...` reads a prompt on **stdin**, drives exactly one
harness turn, and writes the clean reply to **stdout**. This mode does **not** reimplement
the one-shot loop: it delegates to [`src/cli/run.ts`](../../../src/cli/run.ts)'s exported
`main()`, which owns the one-shot grammar, stdin/stdout shape, and exit-code contract.

See **[`cli.md`](cli.md)** (`meta-harness-run`) for that contract — it is documented there
and deliberately **not restated here**, so the two docs cannot drift.

## Auto-accept trust

There is **no `--auto-accept` wrapper flag.** Auto-accept-trust is not an operator toggle
on this CLI; it is a one-shot **input policy**. The one-shot path installs it automatically
via `AutoAcceptTrust` ([`src/oneshot/oneshot.ts`](../../../src/oneshot/oneshot.ts)), which
mirrors Go's `run.go` `AUTO_ACCEPT_TRUST` input policy and is applied in unattended
contexts (the one-shot loop and the gateway) rather than being flipped per invocation.
