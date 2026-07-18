#!/usr/bin/env node
// meta-harness-wrapper — CLI parity port of cmd/harness-wrapper: foreground
// supervised TTY passthrough, plus the tmux-detached attach/status/kill/list
// subcommands (src/cli/tmux.ts) and the exact one-shot `run` mode (delegated
// to src/cli/run.ts's exported main(), NOT reimplemented here — see that
// file's module doc for the one-shot grammar/exit-code contract it owns).
//
// Note for future readers: src/turns/wrapper.ts already uses the bare name
// "wrapper" for something unrelated to this file — not a collision (different
// directories), but easy to conflate by name alone.
//
// Package wiring this CLI still needs once merged into meta-harness proper:
// package.json's "bin" map gets `"meta-harness-wrapper": "./dist/cli/wrapper.js"`
// alongside the existing meta-harness-run / meta-harness-structured-run entries.
import { closeSync, openSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { StatusBlockedByCost, StatusFailed, StatusIdle, StatusInterrupted, StatusUnknown, start, } from "../wrapper/api.js";
import { Discard, newWriterEmitter, } from "../wrapper/trace.js";
import { Context } from "../internal/async/index.js";
import { main as runOneShotMain } from "./run.js";
import { assertSupportedHarness, } from "./harnessResolver.js";
import { parseHarnessWrapperArgs, } from "./wrapperFlags.js";
import { runTmuxAttach, runTmuxKill, runTmuxList, runTmuxSpawn, runTmuxStatus, } from "./tmux.js";
const USAGE = `usage: meta-harness-wrapper [wrapper-flags] <name> -- <harness args>
       meta-harness-wrapper run <name> [wrapper-flags] -- <harness args>   (prompt on stdin)
       meta-harness-wrapper attach <session>
       meta-harness-wrapper status <session> [--json]
       meta-harness-wrapper kill <session>
       meta-harness-wrapper list

wrapper flags (must come BEFORE the harness name):
  --trace-file PATH       write trace events as NDJSON to PATH
  --trace-stderr          write trace events as NDJSON to stderr
  --tmux-session NAME     spawn the run inside a detached tmux session
                          named mh-<NAME> and exit immediately

supported harness names: claude, codex, opencode, pi

By default trace events are dropped, since stderr would corrupt an
interactive harness TUI. Pass --trace-file or --trace-stderr to enable.

Tmux mode lets you detach from a long-running agent: the harness keeps
running inside the tmux session, and \`meta-harness-wrapper attach\`
(or \`tmux attach -t mh-<NAME>\`) reconnects you. Trace events go to
~/.meta-harness/sessions/<NAME>.trace.ndjson by default.
`;
/**
 * Maps a wrapper Result onto a process exit code. Ported from Go's
 * exitCodeFor (cmd/harness-wrapper/main.go:192-219); all ten Status constants
 * already exist 1:1 in both runtimes, so this is a straight port with no
 * parity gap.
 */
export function exitCodeFor(res) {
    switch (res.status) {
        case StatusIdle:
            return res.exitCode;
        case StatusFailed:
            return res.exitCode > 0 ? res.exitCode : 1;
        case StatusBlockedByCost:
            return res.exitCode > 0 ? res.exitCode : 1;
        case StatusInterrupted:
            return res.exitCode > 0 ? res.exitCode : 130;
        case StatusUnknown:
            return res.exitCode > 0 ? res.exitCode : 0;
        default:
            return 1;
    }
}
/**
 * Records the wrapper CLI's final view of a run. Ported from Go's
 * emitCLIExitTrace (main.go:138-162). `res` is null only when start() itself
 * failed (no Result was ever produced).
 */
function emitCLIExitTrace(emitter, res, runErr) {
    const fields = {
        status: res?.status ?? "",
        exit_code: res?.exitCode ?? -1,
        signal: res?.signal ?? "",
        reason: res?.reason ?? "",
        pid: res?.pid ?? 0,
        started_at: res?.startedAt ?? null,
        ended_at: res?.endedAt ?? null,
    };
    if (res?.startedAt && res.endedAt) {
        fields.duration_ms = res.endedAt.getTime() - res.startedAt.getTime();
    }
    if (runErr)
        fields.error = runErr.message;
    emitter.emit({ at: new Date(), kind: "wrapper_cli_exited", fields });
}
/**
 * Opens the trace Emitter for the parsed CLI flags. Default: trace events are
 * dropped (Discard) — the common case is an interactive harness in a real
 * terminal, where trace JSON on stderr would corrupt the TUI. Opt-in via
 * --trace-file or --trace-stderr. Ported from Go's openTraceEmitter
 * (main.go:174-187); the returned close() is always safe to call.
 */
function openTraceEmitter(args) {
    if (args.traceFile !== "") {
        const fd = openSync(args.traceFile, "a");
        const w = {
            write: (chunk) => {
                writeSync(fd, chunk);
            },
        };
        return {
            emitter: newWriterEmitter(w),
            close: () => {
                closeSync(fd);
            },
        };
    }
    if (args.traceStderr) {
        const w = {
            write: (chunk) => {
                process.stderr.write(chunk);
            },
        };
        return {
            emitter: newWriterEmitter(w),
            close: () => {
                /* no-op: nothing to close */
            },
        };
    }
    return {
        emitter: Discard,
        close: () => {
            /* no-op: nothing to close */
        },
    };
}
/**
 * A cancellation context wired to SIGHUP/SIGTERM: emits wrapper_cli_signal
 * and cancels ctx so the foreground run tears down gracefully. Ported from
 * Go's signalAwareContext (main.go:101-132).
 */
function signalAwareContext(emitter) {
    const { ctx, cancel } = Context.withCancel(Context.background());
    const onSignal = (signal) => {
        emitter.emit({
            at: new Date(),
            kind: "wrapper_cli_signal",
            fields: { signal },
        });
        cancel();
    };
    process.on("SIGHUP", onSignal);
    process.on("SIGTERM", onSignal);
    let stopped = false;
    return {
        ctx,
        stop: () => {
            if (stopped)
                return;
            stopped = true;
            process.off("SIGHUP", onSignal);
            process.off("SIGTERM", onSignal);
        },
    };
}
export function installRawModeGuard(stdin) {
    const enabled = stdin.isTTY;
    if (enabled)
        stdin.setRawMode(true);
    let cleaned = false;
    const onExit = () => {
        cleanup();
    };
    function cleanup() {
        if (cleaned)
            return;
        cleaned = true;
        if (enabled)
            stdin.setRawMode(false);
        process.off("exit", onExit);
    }
    process.on("exit", onExit);
    return { cleanup };
}
async function runTTYForeground(sess, emitter) {
    const guard = installRawModeGuard(process.stdin);
    try {
        // Best-effort initial resize from whatever the TTY reports — no invented
        // 80x24 default (Go's setupTerminalIfTTY only resizes when GetsizeFull
        // succeeds; there is no fallback literal in pkg/wrapper).
        if (process.stdout.columns && process.stdout.rows) {
            sess.resize(process.stdout.columns, process.stdout.rows);
        }
        const onResize = () => {
            if (process.stdout.columns && process.stdout.rows) {
                sess.resize(process.stdout.columns, process.stdout.rows);
            }
        };
        process.stdout.on("resize", onResize);
        const onData = (chunk) => {
            sess.writeStdin(new Uint8Array(chunk));
        };
        process.stdin.on("data", onData);
        process.stdin.resume();
        try {
            const { result } = await sess.wait();
            emitCLIExitTrace(emitter, result, null);
            return exitCodeFor(result);
        }
        finally {
            process.stdin.off("data", onData);
            process.stdout.off("resize", onResize);
        }
    }
    finally {
        guard.cleanup();
    }
}
async function runHeadlessForeground(sess, emitter) {
    const onData = (chunk) => {
        sess.writeStdin(new Uint8Array(chunk));
    };
    const onEnd = () => {
        sess.writeStdin(new Uint8Array([0x04, 0x04]));
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.resume();
    try {
        const { result } = await sess.wait();
        emitCLIExitTrace(emitter, result, null);
        return exitCodeFor(result);
    }
    finally {
        process.stdin.off("data", onData);
        process.stdin.off("end", onEnd);
    }
}
async function runForeground(resolved, parsed, emitter) {
    const { ctx, stop: stopSignalWatcher } = signalAwareContext(emitter);
    try {
        const cfg = {
            binaryPath: resolved.binaryPath,
            harness: resolved.harness,
            args: parsed.harnessArgs,
            // Never set cfg.stdin: when set, Session forwards it and appends
            // EOT-EOT on source EOF (session.ts forwardStdin) — that's the
            // headless-only convenience path, not what an interactive terminal
            // wants. This CLI drives writeStdin itself instead (below).
            stdout: {
                write: (data) => {
                    process.stdout.write(Buffer.from(data));
                },
            },
            trace: emitter,
            effort: parsed.effort,
            model: parsed.model,
        };
        let sess;
        try {
            sess = await start(ctx, cfg);
        }
        catch (err) {
            const e = err instanceof Error ? err : new Error(String(err));
            emitCLIExitTrace(emitter, null, e);
            process.stderr.write("harness-wrapper: " + e.message + "\n");
            return 1;
        }
        // Acquire the write lock unconditionally, once, for both the TTY and
        // non-TTY paths alike (mirrors src/chat/conversation.ts:1595-1598).
        // acquireWriter() only returns ok=false when another caller already holds
        // the lock — impossible for a lone foreground CLI process — but if it
        // ever does, fail loudly: stop() the session (it already spawned the real
        // PTY child) before the non-zero exit, never silently degrade to
        // read-only.
        const { release, ok } = sess.acquireWriter();
        if (!ok) {
            await sess.stop();
            process.stderr.write("harness-wrapper: failed to acquire wrapper writer lock\n");
            return 1;
        }
        try {
            const isTTY = process.stdin.isTTY && process.stdout.isTTY;
            return isTTY
                ? await runTTYForeground(sess, emitter)
                : await runHeadlessForeground(sess, emitter);
        }
        finally {
            release();
        }
    }
    finally {
        stopSignalWatcher();
    }
}
async function runHarnessWrapper(argv) {
    const { result: parsed, err: parseErr } = parseHarnessWrapperArgs(argv);
    if (parseErr || !parsed) {
        process.stderr.write((parseErr?.message ?? "harness-wrapper: bad args") + "\n");
        return 2;
    }
    const { result: resolved, err: resolveErr } = assertSupportedHarness(parsed.harnessName);
    if (resolveErr || !resolved) {
        process.stderr.write((resolveErr?.message ?? "unsupported harness") + "\n");
        return 2;
    }
    // Parent of a tmux-backed run: spawn the detached session and exit. The
    // harness keeps running inside the pane via a re-exec into this same entry
    // point with --tmux-child set (src/cli/tmux.ts).
    if (parsed.tmuxSession !== "") {
        return runTmuxSpawn(parsed);
    }
    const { emitter, close } = openTraceEmitter(parsed);
    try {
        return await runForeground(resolved, parsed, emitter);
    }
    finally {
        close();
    }
}
export async function main(argv) {
    if (argv.length === 1 &&
        (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help")) {
        process.stdout.write(USAGE);
        return 0;
    }
    // Tmux-mode subcommands and the one-shot `run` mode don't follow the
    // `<harness> -- <args>` shape, so they're routed before the main parser
    // (mirrors Go's main.go:38-49).
    if (argv.length >= 1) {
        switch (argv[0]) {
            case "attach":
                return runTmuxAttach(argv.slice(1));
            case "status":
                return runTmuxStatus(argv.slice(1));
            case "kill":
                return runTmuxKill(argv.slice(1));
            case "list":
                return runTmuxList(argv.slice(1));
            case "run":
                // src/cli/run.ts owns the one-shot exit-code contract; main() already
                // just returns the code (no process.exit()) when imported rather than
                // run as the entrypoint, which is exactly the shape needed here.
                return runOneShotMain(argv.slice(1));
            default:
                break;
        }
    }
    return runHarnessWrapper(argv);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        process.stderr.write("harness-wrapper: fatal: " + String(err) + "\n");
        process.exit(1);
    });
}
//# sourceMappingURL=wrapper.js.map