#!/usr/bin/env node
// meta-harness `run` CLI — the separate-process one-shot mode.
//
// This is the TypeScript port of the Go `harness-wrapper run` one-shot contract:
// a thin, disposable CLI that can be baked into a container image and exec'd once
// per turn. It reads a prompt on STDIN, drives exactly one harness turn via the
// shared one-shot loop (src/oneshot), and writes the clean reply to STDOUT.
//
// Grammar:
//   run [--effort E] [--model M] <name> -- <harness args...>
// Flags sit between `run` and <name>; everything after `--` is forwarded verbatim
// to the harness. <name> is a short alias (claude → claude-code, codex → codex).
//
// Exit codes (must match the orchestrator's packages/agent/src/harness/headless.ts parser):
//   0   — turn completed; clean reply on stdout
//   1   — turn errored / fatal / stdin read failure
//   2   — usage: bad args, unknown harness, or empty prompt
//   124 — deadline: prints the literal `harness-wrapper run: context deadline
//         exceeded` on stderr (fires BOTH of the orchestrator's timeout signals)
//
// Packaging caveat: `bun build --compile` does NOT yield a self-contained binary
// here. node-pty under Bun spawns a `node ptyHost.mjs` bridge and loads a native
// `.node` addon from disk, so the image must still ship `node`, the ptyHost.mjs,
// and the materialized addon alongside the compiled executable. See PACKAGING.md.
import { pathToFileURL } from "node:url";
import { runOneShot, cleanEnv, DeadlineError, TurnErroredError, EmptyPromptError, } from "../oneshot/index.js";
import { Context } from "../internal/async/index.js";
// Exit codes + DeadlineLine come from the ONE shared protocol module
// (src/turnproto). Re-exported here so this CLI's tested surface — test/cli/
// run.test.ts imports them from this module — stays UNCHANGED.
export { ExitOK, ExitError, ExitUsage, ExitDeadline, DeadlineLine, } from "../turnproto/index.js";
import { ExitOK, ExitError, ExitUsage, ExitDeadline, DeadlineLine, } from "../turnproto/index.js";
/** Default one-shot deadline when HARNESS_WRAPPER_RUN_TIMEOUT is unset (Go: 15m). */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const HELP = `meta-harness run — one-shot harness turn (prompt on stdin → reply on stdout)

usage: run [--effort E] [--model M] <name> -- <harness args...>

  run <name>          drive one turn of the named harness
  <name>              short alias: claude → claude-code, codex → codex
  --effort E          reasoning effort passed to the harness
  --model M           model passed to the harness
  --                  everything after is forwarded verbatim to the harness
  -h, --help          show this help

Reads the prompt on stdin and writes the clean reply on stdout. Exit codes:
  0 ok · 1 errored/fatal · 2 usage · 124 deadline exceeded.
`;
/** Maps a CLI short name to the chat adapter (harness) name. */
export function resolveHarnessName(name) {
    switch (name) {
        case "claude":
        case "claude-code":
            return "claude-code";
        case "codex":
            return "codex";
        default:
            return null;
    }
}
/**
 * parseArgs implements the grammar. Flags (--effort/--model) must precede <name>;
 * <name> is the first non-flag token; a `--` separator ends CLI parsing and the
 * remainder is forwarded to the harness.
 */
export function parseArgs(argv) {
    const out = { harnessArgs: [] };
    let i = 0;
    for (; i < argv.length; i++) {
        const a = argv[i];
        if (a === "-h" || a === "--help") {
            out.help = true;
            return out;
        }
        if (a === "--") {
            out.error = "missing <name> before `--`";
            return out;
        }
        if (a === "--effort" || a === "--model") {
            const v = argv[i + 1];
            if (v === undefined) {
                out.error = `flag ${a} requires a value`;
                return out;
            }
            if (a === "--effort")
                out.effort = v;
            else
                out.model = v;
            i++;
            continue;
        }
        if (a.startsWith("--effort=")) {
            out.effort = a.slice("--effort=".length);
            continue;
        }
        if (a.startsWith("--model=")) {
            out.model = a.slice("--model=".length);
            continue;
        }
        if (a.startsWith("-")) {
            out.error = `unknown flag: ${a}`;
            return out;
        }
        // First non-flag token is <name>.
        out.name = a;
        i++;
        break;
    }
    if (out.name === undefined) {
        out.error = "missing <name>";
        return out;
    }
    // Remaining args: expect an optional `--` then harness args.
    if (i < argv.length) {
        if (argv[i] === "--") {
            out.harnessArgs = argv.slice(i + 1);
        }
        else {
            out.error = `unexpected argument: ${argv[i]} (harness args must follow \`--\`)`;
            return out;
        }
    }
    return out;
}
/** parseTimeout reads HARNESS_WRAPPER_RUN_TIMEOUT (Go duration) → ms; default 15m. */
export function parseTimeoutMs(raw) {
    if (!raw || raw.trim() === "")
        return DEFAULT_TIMEOUT_MS;
    const ms = parseGoDuration(raw.trim());
    return ms === null || ms <= 0 ? DEFAULT_TIMEOUT_MS : ms;
}
/** parseGoDuration parses a subset of Go durations ("15m", "90s", "1h30m", "500ms"). */
export function parseGoDuration(s) {
    const re = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;
    const units = {
        ns: 1e-6,
        us: 1e-3,
        µs: 1e-3,
        ms: 1,
        s: 1000,
        m: 60_000,
        h: 3_600_000,
    };
    let total = 0;
    let matched = false;
    let lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
        if (m.index !== lastIndex)
            return null; // gap → malformed
        total += parseFloat(m[1]) * units[m[2]];
        lastIndex = re.lastIndex;
        matched = true;
    }
    if (!matched || lastIndex !== s.length)
        return null;
    return total;
}
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    let len = 0;
    for (const c of chunks)
        len += c.length;
    const buf = new Uint8Array(len);
    let off = 0;
    for (const c of chunks) {
        buf.set(c, off);
        off += c.length;
    }
    return new TextDecoder().decode(buf);
}
/** resolveBinaryPath returns the harness binary path (env override or the name itself). */
function resolveBinaryPath(harness, env) {
    // Allow an explicit override so images can pin an absolute path.
    const key = "HARNESS_BINARY_" + harness.toUpperCase().replace(/-/g, "_");
    return env[key] ?? env.HARNESS_BINARY ?? harness;
}
export async function main(argv) {
    const parsed = parseArgs(argv);
    if (parsed.help) {
        process.stdout.write(HELP);
        return ExitOK;
    }
    if (parsed.error) {
        process.stderr.write("run: " + parsed.error + "\n");
        return ExitUsage;
    }
    const harness = resolveHarnessName(parsed.name);
    if (harness === null) {
        process.stderr.write(`run: unknown harness: ${parsed.name}\n`);
        return ExitUsage;
    }
    let prompt;
    try {
        prompt = await readStdin();
    }
    catch (err) {
        process.stderr.write("run: failed to read stdin: " + String(err) + "\n");
        return ExitError;
    }
    if (prompt.trim() === "") {
        process.stderr.write("run: empty prompt\n");
        return ExitUsage;
    }
    const env = cleanEnv(Object.entries(process.env).map(([k, v]) => `${k}=${v ?? ""}`));
    const binaryPath = resolveBinaryPath(harness, process.env);
    const timeoutMs = parseTimeoutMs(process.env.HARNESS_WRAPPER_RUN_TIMEOUT);
    const { ctx, cancel } = Context.withDeadline(Context.background(), timeoutMs);
    try {
        const reply = await runOneShot(ctx, {
            harness,
            binaryPath,
            prompt,
            args: parsed.harnessArgs,
            env,
            effort: parsed.effort,
            model: parsed.model,
        });
        process.stdout.write(reply);
        if (!reply.endsWith("\n"))
            process.stdout.write("\n");
        return ExitOK;
    }
    catch (err) {
        if (err instanceof DeadlineError) {
            // 124 + the literal anchor line fires BOTH of the orchestrator's timeout signals.
            process.stderr.write(DeadlineLine + "\n");
            return ExitDeadline;
        }
        if (err instanceof EmptyPromptError) {
            process.stderr.write("run: empty prompt\n");
            return ExitUsage;
        }
        if (err instanceof TurnErroredError) {
            process.stderr.write("run: " + err.message + "\n");
            return ExitError;
        }
        process.stderr.write("run: " + (err instanceof Error ? err.message : String(err)) + "\n");
        return ExitError;
    }
    finally {
        cancel();
    }
}
// Entry point — only when executed directly (not when imported by tests).
// Node-safe idiom (import.meta.main exists only in Node ≥24.2, so it would make
// this bin a silent no-op on older Node); mirrors structured-runner.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        process.stderr.write("run: fatal: " + String(err) + "\n");
        process.exit(ExitError);
    });
}
//# sourceMappingURL=run.js.map