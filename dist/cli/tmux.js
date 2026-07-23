// tmux-detached mode for `meta-harness-wrapper`.
//
// Port of cmd/harness-wrapper/tmux.go. Session-name prefix renamed hw- -> mh-;
// the trace-file env var renamed HW_TRACE_FILE -> META_HARNESS_TRACE_FILE (a
// tmux-session env var set via `tmux set-environment` right after spawn, purely
// so attach/status/kill can recover the trace path later via
// `tmux show-environment` — NOT a general startup override; the re-exec'd
// child's own trace path always arrives as a literal --trace-file argv
// element).
//
// Divergence from Go: runTmuxAttach here validates --tmux-session BEFORE
// requireTmux() (Go's tmux.go:44-47 does spawn's check in the opposite order:
// requireTmux() then validSessionName()). Go's own attach/status/kill entry
// points already validate the name first (tmux.go's requireOneSessionArg);
// this port makes spawn consistent with those three so a malformed
// --tmux-session is rejected the same way regardless of whether tmux happens
// to be installed — the property the HARNESS-WRAPPER-3 ticket calls out as a
// hardening gap worth testing hermetically (no tmux binary required).
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolvePath } from "../discovery/discovery.js";
/** Prepended to every tmux session name owned by meta-harness-wrapper. */
export const TMUX_SESSION_PREFIX = "mh-";
/** Tmux-session env var stashing the trace-file path for attach/status/kill recovery. */
export const TRACE_FILE_ENV = "META_HARNESS_TRACE_FILE";
const SESSION_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Rejects names with characters that would confuse tmux or the filesystem. */
export function validSessionName(s) {
    return SESSION_NAME_RE.test(s);
}
/** Error when the `tmux` binary is not on PATH (or in a well-known dir). */
export function requireTmux() {
    if (resolvePath("tmux") === null) {
        return new Error("tmux not found in PATH");
    }
    return null;
}
/**
 * Picks the NDJSON trace path. An explicit --trace-file is used verbatim
 * (absolutized); otherwise falls back to
 * ~/.meta-harness/sessions/<name>.trace.ndjson.
 */
export function resolveTracePath(explicit, sessionName) {
    if (explicit !== "") {
        return { result: resolve(explicit), err: null };
    }
    const home = homedir();
    if (!home) {
        return {
            result: null,
            err: new Error("resolve home dir for default trace path"),
        };
    }
    return {
        result: join(home, ".meta-harness", "sessions", `${sessionName}.trace.ndjson`),
        err: null,
    };
}
/**
 * Builds the pane command tmux re-execs: this same entry point in --tmux-child
 * mode, carrying the resolved trace path plus every launch-time knob the parent
 * parsed. Any wrapper flag that shapes the run MUST be forwarded here or a
 * `--tmux-session` invocation silently loses it. Mirrors Go's reexec argv shape
 * (tmux.go:66-90); process.execPath + process.argv[1] stand in for Go's
 * single-binary os.Executable(). Pure and exported so the argv contract is
 * testable without a tmux binary.
 */
export function buildReexecArgv(args, tracePath) {
    const reexec = [
        process.execPath,
        process.argv[1] ?? "",
        "--tmux-child",
        args.tmuxSession,
        "--trace-file",
        tracePath,
    ];
    if (args.effort !== "")
        reexec.push("--effort", args.effort);
    if (args.model !== "")
        reexec.push("--model", args.model);
    if (args.permissionMode !== "")
        reexec.push("--permission-mode", args.permissionMode);
    reexec.push(args.harnessName, "--", ...args.harnessArgs);
    return reexec;
}
/**
 * Parent half of `meta-harness-wrapper --tmux-session <name> -- <harness> ...`:
 * resolves the trace path, re-execs this same binary with --tmux-child set
 * inside a detached tmux session, and exits. binPath is not needed here — the
 * in-pane child resolves the harness binary again via start()'s resolvePath()
 * call, in the same environment tmux's child shell will see (mirrors Go's
 * comment at tmux.go:34-37).
 */
export function runTmuxSpawn(args) {
    if (!validSessionName(args.tmuxSession)) {
        process.stderr.write(`harness-wrapper: invalid --tmux-session value ${JSON.stringify(args.tmuxSession)} (allowed: [A-Za-z0-9_-], 1-64 chars)\n`);
        return 2;
    }
    const tmuxErr = requireTmux();
    if (tmuxErr) {
        process.stderr.write("harness-wrapper: " + tmuxErr.message + "\n");
        return 1;
    }
    const tmuxName = TMUX_SESSION_PREFIX + args.tmuxSession;
    const { result: tracePath, err: traceErr } = resolveTracePath(args.traceFile, args.tmuxSession);
    if (traceErr || !tracePath) {
        process.stderr.write("harness-wrapper: " + (traceErr?.message ?? "resolve trace path") + "\n");
        return 1;
    }
    try {
        mkdirSync(dirname(tracePath), { recursive: true });
    }
    catch (err) {
        process.stderr.write(`harness-wrapper: mkdir trace dir: ${String(err)}\n`);
        return 1;
    }
    // Re-exec: same entry point (node + this script), --tmux-child mode with
    // the resolved trace path. tmux runs this as the pane command.
    const reexec = buildReexecArgv(args, tracePath);
    const spawnResult = spawnSync("tmux", ["new-session", "-d", "-s", tmuxName, ...reexec], {
        stdio: ["ignore", "ignore", "inherit"],
    });
    if (spawnResult.error || spawnResult.status !== 0) {
        process.stderr.write(`harness-wrapper: tmux new-session failed: ${spawnResult.error?.message ?? "exit " + String(spawnResult.status)}\n`);
        return 1;
    }
    // Best-effort: stash the trace path in the tmux session env so subsequent
    // attach/status/kill calls can recover it.
    spawnSync("tmux", [
        "set-environment",
        "-t",
        tmuxName,
        TRACE_FILE_ENV,
        tracePath,
    ]);
    process.stdout.write(`session: ${args.tmuxSession}\n`);
    process.stdout.write(`tmux:    ${tmuxName}\n`);
    process.stdout.write(`trace:   ${tracePath}\n`);
    return 0;
}
function requireOneSessionArg(args, sub) {
    if (args.length !== 1) {
        process.stderr.write(`usage: harness-wrapper ${sub} <session-name>\n`);
        return { result: "", code: 2 };
    }
    if (!validSessionName(args[0])) {
        process.stderr.write(`harness-wrapper: invalid session name ${JSON.stringify(args[0])}\n`);
        return { result: "", code: 2 };
    }
    return { result: args[0], code: 0 };
}
/**
 * `meta-harness-wrapper attach <session>`. Node has no execve, so — unlike
 * Go's syscall.Exec (tmux.go:203) — this leaves an extra Node parent process
 * between the user's terminal and tmux for the lifetime of the attach. This is
 * a genuine, documented divergence (see HARNESS-WRAPPER-3 ticket Risks), not
 * an oversight: stdio:"inherit" still gives the user a normal-feeling
 * attached session, just with one extra process in the tree.
 */
export function runTmuxAttach(argv) {
    const { result: name, code } = requireOneSessionArg(argv, "attach");
    if (code !== 0)
        return code;
    const tmuxErr = requireTmux();
    if (tmuxErr) {
        process.stderr.write("harness-wrapper: " + tmuxErr.message + "\n");
        return 1;
    }
    const tmuxName = TMUX_SESSION_PREFIX + name;
    const result = spawnSync("tmux", ["attach", "-t", tmuxName], {
        stdio: "inherit",
    });
    if (result.error) {
        process.stderr.write(`harness-wrapper: exec tmux attach: ${result.error.message}\n`);
        return 1;
    }
    return result.status ?? 0;
}
/** `meta-harness-wrapper kill <session>`. */
export function runTmuxKill(argv) {
    const { result: name, code } = requireOneSessionArg(argv, "kill");
    if (code !== 0)
        return code;
    const tmuxErr = requireTmux();
    if (tmuxErr) {
        process.stderr.write("harness-wrapper: " + tmuxErr.message + "\n");
        return 1;
    }
    const tmuxName = TMUX_SESSION_PREFIX + name;
    const result = spawnSync("tmux", ["kill-session", "-t", tmuxName], {
        stdio: ["ignore", "ignore", "inherit"],
    });
    if (result.error || result.status !== 0) {
        process.stderr.write(`harness-wrapper: tmux kill-session failed: ${result.error?.message ?? "exit " + String(result.status)}\n`);
        return 1;
    }
    return 0;
}
function listSessions() {
    const result = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"]);
    if (result.error || result.status !== 0)
        return null;
    const out = result.stdout.toString("utf8").trim();
    if (out === "")
        return [];
    return out
        .split("\n")
        .filter((line) => line.startsWith(TMUX_SESSION_PREFIX))
        .map((line) => line.slice(TMUX_SESSION_PREFIX.length));
}
/** `meta-harness-wrapper list`. Bare session names (without the mh- prefix), sorted. */
export function runTmuxList(argv) {
    if (argv.length !== 0) {
        process.stderr.write("usage: harness-wrapper list\n");
        return 2;
    }
    const tmuxErr = requireTmux();
    if (tmuxErr) {
        process.stderr.write("harness-wrapper: " + tmuxErr.message + "\n");
        return 1;
    }
    const names = listSessions();
    // tmux returns non-zero when no server is running; treat as empty (Go: tmux.go:239-242).
    if (names === null)
        return 0;
    for (const n of [...names].sort())
        process.stdout.write(n + "\n");
    return 0;
}
function tmuxSessionExists(name) {
    const result = spawnSync("tmux", [
        "has-session",
        "-t",
        TMUX_SESSION_PREFIX + name,
    ]);
    return result.status === 0;
}
/**
 * Recovers the trace-file path for a session by reading the tmux session env.
 * Falls back to the default path scheme if the session is gone or never set
 * the var.
 */
function lookupTraceFile(name) {
    const tmuxName = TMUX_SESSION_PREFIX + name;
    const result = spawnSync("tmux", [
        "show-environment",
        "-t",
        tmuxName,
        TRACE_FILE_ENV,
    ]);
    if (!result.error && result.status === 0) {
        const line = result.stdout.toString("utf8").trim();
        const prefix = TRACE_FILE_ENV + "=";
        if (line.startsWith(prefix)) {
            const v = line.slice(prefix.length);
            if (v !== "")
                return { result: v, err: null };
        }
    }
    return resolveTracePath("", name);
}
/** Reads the last NDJSON event from a trace file, or null if missing/empty. */
function readLastTraceEvent(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return { result: null, err: null };
        return {
            result: null,
            err: err instanceof Error ? err : new Error(String(err)),
        };
    }
    let lastLine = "";
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (trimmed !== "")
            lastLine = trimmed;
    }
    if (lastLine === "")
        return { result: null, err: null };
    try {
        return {
            result: JSON.parse(lastLine),
            err: null,
        };
    }
    catch (err) {
        return {
            result: null,
            err: new Error(`parse last trace line: ${String(err)}`),
        };
    }
}
/** `meta-harness-wrapper status <session> [--json]`. */
export function runTmuxStatus(argv) {
    let wantJSON = false;
    const positional = [];
    for (const a of argv) {
        if (a === "--json")
            wantJSON = true;
        else
            positional.push(a);
    }
    const { result: name, code } = requireOneSessionArg(positional, "status");
    if (code !== 0)
        return code;
    const { result: tracePath, err: lookupErr } = lookupTraceFile(name);
    if (lookupErr || !tracePath) {
        process.stderr.write("harness-wrapper: " + (lookupErr?.message ?? "lookup trace file") + "\n");
        return 1;
    }
    const { result: last, err: readErr } = readLastTraceEvent(tracePath);
    if (readErr) {
        process.stderr.write(`harness-wrapper: read trace ${JSON.stringify(tracePath)}: ${readErr.message}\n`);
        return 1;
    }
    const alive = tmuxSessionExists(name);
    if (wantJSON) {
        const out = {
            session: name,
            alive,
            trace: tracePath,
        };
        if (last)
            out.last_event = last;
        process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        return 0;
    }
    process.stdout.write(`session: ${name}\n`);
    process.stdout.write(`alive:   ${String(alive)}\n`);
    process.stdout.write(`trace:   ${tracePath}\n`);
    if (last) {
        let line = `last:    ${String(last.kind)}`;
        if ("at" in last)
            line += ` @ ${String(last.at)}`;
        process.stdout.write(line + "\n");
    }
    return 0;
}
//# sourceMappingURL=tmux.js.map