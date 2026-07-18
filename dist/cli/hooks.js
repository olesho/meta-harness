#!/usr/bin/env node
// meta-harness `hooks` CLI — the OUT-OF-PROCESS hook entry point.
//
// A harness (e.g. Claude Code) fires a configured hook by running this bin once
// per event, piping the native hook payload on stdin. This process parses the
// payload through the harness's HookProvider (parse + guards, from the
// provider-parse subtask) and APPENDS the resulting canonical SourceHook events
// to the spool file (from spool.ts). The in-process runtime later drains that
// spool via drainSpool. This process NEVER touches the in-process runtime — the
// spool file is the whole hand-off.
//
// This bin MUST resolve to compiled `dist` under Node (never Bun): a fresh Node
// startup per event is inherent to the hook design, and the rendered hook
// command pins the Node bin path. See package.json "bin".
//
// A hook that crashes must not take the harness down with it: main() swallows
// all errors, writes a diagnostic to stderr, and exits 0. When the spool dir is
// absent (HW_EVENT_SPOOL unset) the handler is inert, mirroring the yield
// handler's "absent ⇒ inert" contract.
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { EnvHome, EnvHookCwd, EnvSpool, } from "../acquisition/internal/yield.js";
import { ClaudeHookProvider } from "../hooks/claude.js";
import { appendSpool } from "../hooks/spool.js";
// Extra HW_* env vars this CLI reads that are not part of the yield handshake.
// EnvConfigDir overrides the harness config dir (else the provider defaults it
// from home); EnvSessionID is the expected session id for the session-mismatch
// guard (empty ⇒ no expectation).
export const EnvConfigDir = "HW_CONFIG_DIR";
export const EnvSessionID = "HW_HARNESS_SESSION_ID";
// providers maps a harness name to its concrete HookProvider. Only Claude Code
// ships a provider today; an unknown name yields no events (inert).
function providerFor(harnessName) {
    switch (harnessName) {
        case "claude":
        case "claudecode":
        case "claude-code":
            return new ClaudeHookProvider();
        default:
            return null;
    }
}
// contextFromEnv builds the HookContext the provider needs from the HW_* env
// vars the orchestrator set in the harness launch env (see yield.hookEnv).
function contextFromEnv(env) {
    return {
        cwd: env[EnvHookCwd] ?? "",
        home: env[EnvHome] ?? homedir(),
        configDir: env[EnvConfigDir] ?? "",
        spoolDir: env[EnvSpool] ?? "",
        harnessSessionID: env[EnvSessionID] ?? "",
    };
}
// injectEventName ensures the payload carries a hook_event_name. The harness
// passes the native event name as a CLI arg; if the JSON payload omits it (some
// harnesses only pass it out-of-band), we splice the arg in so the provider can
// dispatch. A non-JSON payload is returned unchanged (the provider will drop
// it). An empty event arg is ignored.
function injectEventName(stdin, event) {
    if (event === "")
        return stdin;
    let payload;
    try {
        payload = JSON.parse(stdin);
    }
    catch {
        return stdin;
    }
    if (payload &&
        typeof payload === "object" &&
        payload.hook_event_name === undefined) {
        payload.hook_event_name = event;
        return JSON.stringify(payload);
    }
    return stdin;
}
// handleHookEvent is the hook CLI entry: parse the stdin payload through the
// harness provider's parse+guards and append the resulting canonical SourceHook
// events to the spool. Returns the number of events spooled (0 when inert,
// dropped by a guard, or the harness/spool is unknown). It never throws for an
// ordinary dropped payload; only genuinely exceptional IO faults propagate.
export function handleHookEvent(harnessName, event, env, stdin) {
    const ctx = contextFromEnv(env);
    // No spool dir ⇒ nowhere to hand off ⇒ inert.
    if (ctx.spoolDir === "")
        return 0;
    const provider = providerFor(harnessName);
    if (provider === null)
        return 0;
    const raw = injectEventName(stdin, event);
    const parsed = provider.parsePayload(raw, ctx);
    if (parsed.length === 0)
        return 0;
    appendSpool(ctx.spoolDir, parsed);
    return parsed.length;
}
// readStdin reads all of stdin as a UTF-8 string. Hook payloads are small; a
// synchronous slurp of fd 0 is simplest and avoids an async pipeline in a
// process whose only job is one parse+append.
async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}
export async function main(argv) {
    // argv: [harnessName, eventName?]
    const harnessName = argv[0] ?? "";
    const event = argv[1] ?? "";
    const stdin = await readStdin();
    handleHookEvent(harnessName, event, process.env, stdin);
    // A hook always succeeds from the harness's perspective — its output is
    // consumed asynchronously via the spool, never inline.
    return 0;
}
// Entry point — only when executed directly (not when imported by tests).
// Mirrors run.ts / check-versions.ts: import.meta.main is Node ≥24.2 only.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        // Never fail the harness on a hook error — diagnose and exit clean.
        process.stderr.write("meta-harness-hooks: " + String(err) + "\n");
        process.exit(0);
    });
}
//# sourceMappingURL=hooks.js.map