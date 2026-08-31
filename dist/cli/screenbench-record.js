#!/usr/bin/env node
// meta-harness `screenbench-record` CLI — the generic live PTY corpus recorder.
//
// This is A5 (META-HARNESS-51): the shipped, Node-run, PATH-resolvable recorder
// that `scripts/rebake-corpus.mjs` drives per `(harness × scenario)` to
// regenerate the live-recording corpus. It is the generalization of the
// dev-only, bun-run `test/corpus/tools/record-scenarios.ts` claude-code driver:
// same output triple (bytes.raw + meta.json + expected.txt) and same per-turn
// completion loop, but driven through the production seams so it can also record
// codex — resolveAdapter (completion predicate), readyForInput /
// requiresPromptReadiness (readiness gate), submitKeyForHarness (Enter key), and
// resolveBinary / PtyProcess (PTY plumbing).
//
// Runs under NODE, not bun: `dist/cli/screenbench-record.js` is the shipped bin.
// PtyProcess already spawns a `node ptyHost.mjs` bridge (node-pty's read loop is
// dead under bun; see the project memory), so this uses only Node-compatible
// APIs — do NOT re-hard-code a `bun` invocation.
//
// Scenario coverage is a GROWING set, not a closed one — the catalog below is
// the source of truth and each per-harness capability has its own spec map:
// claude-code × {multi-turn, tool-call, interrupted-mid-reply, trust-dialog} and
// codex × {multi-turn, tool-call} at the time of writing. Two flows have NO
// generic production seam and are therefore gated per harness:
//
//   * interrupt (`interruptSpecs`) — streaming detection, the interrupt
//     keystroke and the interrupt-landed marker are claude-code-only
//     (BusyDetector is not on the base Adapter; codex has no busy()).
//   * startup dialog (`dialogSpecs`) — the folder-trust dialog is a claude-code
//     concept; codex and pi have no equivalent startup dialog.
//
// A scenario flagged for a capability its harness has no spec for makes the
// recorder ERROR clearly (never silently no-op) before writing any file.
//
// TERMINAL STATE. Most scenarios end on a TurnComplete fired by the production
// adapter. A `dialog: true` scenario ends on a BLOCKING DIALOG instead: the
// settled frame is the last thing in bytes.raw and the harness is killed with
// the dialog still unanswered. `trust-dialog` is that scenario — it also carries
// `freshWorkdir: true`, because claude persists the trust decision per absolute
// path (`~/.claude.json` → `projects[<path>].hasTrustDialogAccepted`), so the
// recorder both SKIPS the trust-accepting warmup pass and mints a unique temp
// directory to keep the cell re-runnable.
//
// SCRIPTED STEPS. A scenario is no longer a prompt list driven by a fixed loop:
// it expands (src/cli/recordSteps.ts) into a `Step[]` an interpreter runs, so a
// recording can stop at a dialog, ANSWER it through the chat layer's own byte
// semantics, press scripted keys, and dump intermediate screens. `prompts` is
// kept as sugar and desugars to exactly what the old loop did — the three
// legacy cells record byte-path-identically.
//
// The two stop conditions stay DISTINCT, and both appear in the expanded steps
// recorded in meta.json:
//
//   * `await-input`          — the ADAPTER-EVENT stop condition. Resolves on an
//                              InputRequested, so it needs DetectInput to parse
//                              the dialog. Used by the question scenarios.
//   * `await-dialog-anchor`  — the ANCHOR stop condition (`dialog: true`
//                              desugars to it). Resolves on a screen anchor and
//                              must keep working on builds where the adapter
//                              cannot parse the menu at all, which is the whole
//                              point of the trust-dialog capture.
//
// Args (the subset rebake-corpus.mjs passes, plus optional overrides):
//   --harness <name>            claude-code | codex   (required)
//   --out <dir>                 scenario output dir    (required)
//   --scenario <name>           default: basename(--out)
//   --bin <path>                override binary; default: manifest entry.binary
//   --cols <n>  --rows <n>      terminal geometry (default 120 × 40)
//   --binary-version <v>        cross-check only (see below); NOT the recorded value
//   --cwd <dir>                 harness working dir (default: a temp dir)
//   --workdir <dir>             alias of --cwd (same field; conflicting values
//                               are a usage error, NOT last-wins)
//   --notes <text>              extra meta.json notes
//   --prompt <text>             (repeatable) ad-hoc script, for a scenario name
//                               that is NOT in the catalog
//   --keys "<spec>"             (repeatable) comma-separated escape-encoded
//                               bursts ('1,\t,\x1b[Z'), appended as `keys` steps
//   --stop-on-input[=<kind>]    ad-hoc `await-input`; replaces a trailing
//                               `await-turn` rather than following it
//   --launch-arg <arg>          (repeatable) overrides scenario.launchArgs
//   --no-warmup                 skip the claude trust-accepting warmup pass —
//                               recording against a PRE-TRUSTED cwd is how the
//                               question panes are captured, and there warmup is
//                               pure overhead
//   --allow-overwrite           proceed past the hand-captured-recording guard
//   --attempts <n>              whole-run retries (default 1), and ONLY on an
//                               await-input timeout: a half-answered dialog
//                               cannot be rewound, so retry is never partial
//
// ARTIFACTS. `bytes.raw`, `expected.txt` and `meta.json` keep their meanings
// (`binary_version` is still the probed NORMALIZED version, never the pin).
// Added: `stdin.log` (timestamped, printable()-rendered, one line per write, in
// the hand-capture tools' format), `screen-press-NN.txt` per `cycle` press, and
// whatever a `dump` step names. meta.json gains `mode`, `recorder`,
// `launch_args`, `keystrokes` and the expanded `steps`.
//
// META_HARNESS_CLAUDE_CONFIG is a TEST-ONLY override of the `~/.claude.json`
// path claudeTrustState reads. It exists so the hermetic test can point at a
// fixture; it is not an operator knob and rebake never sets it.
//
// `--binary-version` is a CROSS-CHECK, not the recorded value: rebake passes the
// desired pin, but meta.json records the NORMALIZED probed version (what actually
// produced the bytes). On mismatch the recorder fails with a corpus-integrity
// error and writes nothing.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { answerKeys } from "../chat/answerKeys.js";
import { ErrUnknownOption } from "../chat/errors.js";
import { resolveAdapter } from "../chat/index.js";
import { isClaudeNestingEnvKey } from "../chat/env.js";
import { readyForInput, requiresPromptReadiness, submitKeyForHarness, } from "../chat/ready.js";
import { isSentinel, wrap } from "../internal/async/index.js";
import { Screen } from "../screen/index.js";
import { DetectInput as claudecodeDetectInput } from "../turns/harness/claudecode.js";
import { Errored, InputRequested, InputResolved, TurnComplete, } from "../turns/index.js";
import { readFrom } from "../versions/index.js";
import { PtyProcess, resolveBinary } from "../wrapper/internal/pty.js";
import { decodeKeys, expandScenario, parseKeysSpec, printable, validateDumpFile, validateSteps, } from "./recordSteps.js";
// Repo root, resolvable both as compiled dist/cli/*.js AND as src/cli/*.ts under
// bun (both are exactly three dirs deep under the root). Used to locate the
// default rebake manifest when META_HARNESS_REBAKE_MANIFEST is unset.
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const ExitOK = 0;
export const ExitError = 1;
export const ExitUsage = 2;
const enc = new TextEncoder();
const ESC = enc.encode("\x1b");
// claude-code-specific warmup/quit anchors (carried forward verbatim from
// record-scenarios.ts, gated on harness === "claude-code").
const claudeTrustAnchors = [
    "Do you trust the files in this folder?",
    "Is this a project you created or one you trust?",
];
const claudeQuit = enc.encode("/quit\x1b[13u");
export const interruptSpecs = {
    "claude-code": {
        busyMarker: "esc to interrupt",
        streamingMarker: "⏺",
        key: ESC,
        confirmText: "Interrupted · What should Claude do instead?",
    },
};
export const dialogSpecs = {
    "claude-code": { anchors: claudeTrustAnchors, what: "folder-trust dialog" },
};
export const scenarios = {
    "multi-turn": {
        prompts: [
            "what is the capital of France",
            "what is its population",
            "how does that compare to Berlin",
        ],
        notes: "three consecutive short prompts; each turn must settle before the next",
    },
    "tool-call": {
        prompts: [
            "Use the Read tool to read notes.txt and tell me exactly what it says",
        ],
        setup: (cwd) => {
            writeFileSync(join(cwd, "notes.txt"), "The corpus fixture sentinel is: POMELO-CANYON-88\n");
        },
        notes: "single turn that makes a Read tool call before answering",
    },
    "interrupted-mid-reply": {
        prompts: ["Write a detailed 500 word essay about the history of Paris"],
        interrupt: true,
        notes: "long reply interrupted mid-stream; must end errored, not complete",
    },
    "trust-dialog": {
        prompts: [],
        dialog: true,
        freshWorkdir: true,
        setup: (cwd) => {
            execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
        },
        notes: "first launch in an untrusted git repo; settles on the folder-trust " +
            "dialog and ends InputRequested, never TurnComplete",
    },
};
const USAGE = `usage: meta-harness-screenbench-record --harness <name> --out <dir> \\
    [--scenario <name>] [--bin <path>] [--cwd <dir>] [--workdir <dir>] \\
    [--cols <n>] [--rows <n>] [--binary-version <v>] [--notes <text>] \\
    [--prompt <text>]... [--keys <spec>]... [--stop-on-input[=<kind>]] \\
    [--launch-arg <arg>]... [--no-warmup] [--allow-overwrite] [--attempts <n>]`;
export function parseArgs(argv) {
    const p = {
        harness: "",
        out: "",
        scenario: "",
        bin: "",
        cwd: "",
        cols: 120,
        rows: 40,
        binaryVersion: "",
        notes: "",
        prompts: [],
        keys: [],
        stopOnInput: false,
        stopOnInputKind: "",
        launchArgs: [],
        noWarmup: false,
        allowOverwrite: false,
        attempts: 1,
    };
    // --cwd and --workdir write the SAME field. Tracked separately only so a
    // conflicting pair is a usage error rather than silently last-wins: two
    // spellings of one directory that disagree is a caller bug, and picking one
    // would record into a directory the caller did not mean.
    let cwdFlagValue;
    let workdirFlagValue;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            p.help = true;
            return p;
        }
        const eq = a.indexOf("=");
        const inlineVal = eq >= 0 ? a.slice(eq + 1) : undefined;
        const flag = eq >= 0 ? a.slice(0, eq) : a;
        const next = () => {
            if (inlineVal !== undefined)
                return inlineVal;
            const v = argv[++i];
            if (v === undefined) {
                p.error = `missing value for ${flag}`;
                return "";
            }
            return v;
        };
        switch (flag) {
            case "--harness":
                p.harness = next();
                break;
            case "--out":
                p.out = next();
                break;
            case "--scenario":
                p.scenario = next();
                break;
            case "--bin":
                p.bin = next();
                break;
            case "--cwd":
                p.cwd = next();
                cwdFlagValue = p.cwd;
                break;
            case "--workdir":
                p.cwd = next();
                workdirFlagValue = p.cwd;
                break;
            case "--cols":
                p.cols = Number(next());
                break;
            case "--rows":
                p.rows = Number(next());
                break;
            case "--binary-version":
                p.binaryVersion = next();
                break;
            case "--notes":
                p.notes = next();
                break;
            case "--prompt":
                p.prompts.push(next());
                break;
            case "--keys":
                p.keys.push(next());
                break;
            case "--stop-on-input":
                // A BARE boolean flag with an optional inline kind. It must not consume
                // the next argv word: `--stop-on-input --keys 1` would otherwise eat
                // `--keys` as the kind and then reject it as an unknown flag.
                p.stopOnInput = true;
                if (inlineVal !== undefined && inlineVal !== "")
                    p.stopOnInputKind = inlineVal;
                break;
            case "--launch-arg":
                p.launchArgs.push(next());
                break;
            case "--no-warmup":
                if (inlineVal !== undefined) {
                    p.error = "--no-warmup takes no value";
                    return p;
                }
                p.noWarmup = true;
                break;
            case "--allow-overwrite":
                if (inlineVal !== undefined) {
                    p.error = "--allow-overwrite takes no value";
                    return p;
                }
                p.allowOverwrite = true;
                break;
            case "--attempts":
                p.attempts = Number(next());
                break;
            default:
                p.error = `unknown flag: ${a}`;
                return p;
        }
        if (p.error)
            return p;
    }
    if (cwdFlagValue !== undefined &&
        workdirFlagValue !== undefined &&
        cwdFlagValue !== workdirFlagValue) {
        p.error =
            `--cwd "${cwdFlagValue}" and --workdir "${workdirFlagValue}" are the ` +
                "same option and must not disagree (--workdir is an alias of --cwd)";
        return p;
    }
    if (!p.harness)
        p.error = "--harness <name> is required";
    else if (!p.out)
        p.error = "--out <dir> is required";
    else {
        // Scenario name defaults to the last path segment of --out, matching how
        // rebake-corpus.mjs encodes it (out = <root>/test/corpus/<name>/<scenario>).
        if (!p.scenario)
            p.scenario = basename(p.out);
        if (!Number.isFinite(p.cols) || p.cols <= 0)
            p.error = "--cols must be a positive integer";
        else if (!Number.isFinite(p.rows) || p.rows <= 0)
            p.error = "--rows must be a positive integer";
        else if (!Number.isInteger(p.attempts) || p.attempts <= 0)
            p.error = "--attempts must be a positive integer";
        else {
            // Escape validation happens HERE, not at write time: a typo in a burst is
            // a caller mistake, and finding it after a live recording has already
            // started costs a paid session.
            for (const spec of p.keys) {
                try {
                    parseKeysSpec(spec);
                }
                catch (err) {
                    p.error =
                        "--keys: " + (err instanceof Error ? err.message : String(err));
                    break;
                }
            }
        }
    }
    return p;
}
// --- version normalization ---------------------------------------------------
/**
 * normalizeVersion extracts the bare version token from a raw `--version` line.
 * A real harness prints more than the semver (e.g. "2.1.201 (Claude Code)")
 * while the manifest pin is the bare "2.1.201", so meta.json records — and the
 * --binary-version cross-check compares against — the FIRST whitespace token.
 */
export function normalizeVersion(raw) {
    const t = raw.trim();
    return t.split(/\s+/)[0] ?? t;
}
// --- claude trust state ------------------------------------------------------
/**
 * claudeTrustState reports whether claude has already recorded an accepted
 * trust decision for `dir`. Returns null when the config cannot be read — an
 * unreadable config is NOT evidence of trust, so the caller proceeds with a
 * warning rather than blocking a legitimate recording.
 *
 * `configPath` is normally `~/.claude.json`; the caller resolves the TEST-ONLY
 * META_HARNESS_CLAUDE_CONFIG override.
 */
export function claudeTrustState(dir, configPath) {
    let cfg;
    try {
        cfg = JSON.parse(readFileSync(configPath, "utf8"));
    }
    catch {
        // Missing file or malformed JSON: unknown, not "untrusted" and not
        // "trusted". The caller warns and proceeds.
        return null;
    }
    const projects = cfg
        ?.projects;
    if (!projects || typeof projects !== "object")
        return false;
    // Compare against BOTH the raw path and its realpath: on macOS `/tmp/x` is
    // stored as `/private/tmp/x`, and a raw-only comparison makes this check
    // silently useless exactly where recordings are taken (a temp dir).
    const candidates = new Set([dir]);
    try {
        candidates.add(realpathSync(dir));
    }
    catch {
        /* dir need not exist yet */
    }
    for (const key of candidates) {
        const entry = projects[key];
        if (entry && entry.hasTrustDialogAccepted === true)
            return true;
    }
    // A `false` entry is the normal "seen but not trusted" state, and an absent
    // entry means never launched here — the dialog fires in both cases.
    return false;
}
// --- manifest resolution across the process boundary -------------------------
//
// The recorder is a separate child spawned by rebake-corpus.mjs, which passes
// only --harness/--out/--cols/--rows/--binary-version (no manifest path, no
// --bin, no shared memory). It must RE-RESOLVE the rebake manifest itself,
// mirroring rebake-corpus.mjs, and read entry.binary via readFrom(path). This is
// required, not a shortcut: the embedded catalog would resolve the real binary,
// defeating the hermetic test whose fake binary name lives only in the fixture
// manifest.
function manifestBinary(harness) {
    const manifestPath = process.env.META_HARNESS_REBAKE_MANIFEST ??
        join(root, "versions.rebake.json");
    let manifest;
    try {
        manifest = readFrom(manifestPath);
    }
    catch (err) {
        throw new Error(`cannot read rebake manifest ${manifestPath}: ` +
            (err instanceof Error ? err.message : String(err)) +
            "\n  (pass --bin to bypass the manifest, or set META_HARNESS_REBAKE_MANIFEST)");
    }
    const entry = manifest.get(harness);
    if (!entry) {
        throw new Error(`harness "${harness}" not found in rebake manifest ${manifestPath}`);
    }
    if (!entry.binary) {
        throw new Error(`harness "${harness}" has no binary in rebake manifest ${manifestPath}`);
    }
    return entry.binary;
}
// --- live PTY plumbing (ported from record-scenarios.ts) ---------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * process.env minus the outer Claude Code session markers. Delegates to the
 * canonical predicate behind cleanHarnessEnv, so the CLAUDE_CODE_OAUTH_TOKEN
 * credential survives (PUPPET-309); the record shape is kept because
 * PtyProcess.spawn takes a Record here, not KEY=VALUE entries.
 */
function cleanedEnv() {
    const out = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (isClaudeNestingEnvKey(k))
            continue;
        if (v !== undefined)
            out[k] = v;
    }
    return out;
}
async function spawnLive(bin, cwd, cols, rows, args, onData) {
    const screen = new Screen(cols, rows);
    const pty = await PtyProcess.spawn({
        binaryPath: bin,
        args,
        cwd,
        env: cleanedEnv(),
        cols,
        rows,
    });
    let exited = false;
    pty.onExit(() => {
        exited = true;
    });
    pty.onData((d) => {
        onData?.(d);
        void screen.write(d);
    });
    return { pty, screen, exited: () => exited };
}
/** Polls `cond` against the rendered screen until true, or throws at `timeoutMs`. */
async function waitFor(live, what, cond, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond(live.screen.snapshot().text))
            return;
        if (live.exited())
            throw new Error(`harness exited while waiting for ${what}`);
        await sleep(150);
    }
    throw new Error(`timeout waiting for ${what}; screen tail:\n` +
        live.screen.snapshot().text.trimEnd().split("\n").slice(-12).join("\n"));
}
/**
 * Waits for readiness. When `autoAnswerTrust` is set, claude-code's folder-trust
 * dialog is accepted on the way so warmup and the recording pass start from a
 * clean composer.
 *
 * `autoAnswerTrust` is an EXPLICIT parameter rather than an implicit property of
 * whichever branch called: a `freshWorkdir` recording needs the dialog left
 * standing, and answering it here would silently destroy the thing being
 * recorded. (The dialog branch does not call waitReady at all — `readyForInput`
 * is correctly false under a modal — but the intent belongs at the call site.)
 */
async function waitReady(live, harness, timeoutMs, autoAnswerTrust) {
    let trustAnswered = false;
    await waitFor(live, "ready composer", (text) => {
        if (harness === "claude-code" &&
            autoAnswerTrust &&
            !trustAnswered &&
            claudeTrustAnchors.some((a) => text.includes(a))) {
            // The trust dialog has TWO live shapes. Older builds render numbered
            // rows ("1. Yes, proceed"), where the digit is an absolute,
            // highlight-independent key. claude 2.1.251 renders the choices
            // UNNUMBERED with the highlight defaulting to "No, exit"
            // (PUPPET-296 §1), where the only way to reach "Yes, I trust this
            // folder" is one Down then Enter. Numbered wins whenever it applies:
            // the digit is immune to a stale highlight.
            const numbered = /^[^\S\r\n]*(?:❯[^\S\r\n]+)?1\.[^\S\n]+\S/m.test(text);
            live.pty.write(numbered ? enc.encode("1") : enc.encode("\x1b[B\r"));
            trustAnswered = true;
            return false;
        }
        return readyForInput(harness, text);
    }, timeoutMs);
}
/** Warmup pass (claude-code only): persist folder trust so recording starts clean. */
async function warmup(bin, cwd, cols, rows, args) {
    // Same launch args as the recording pass: trust is persisted per directory,
    // but a flag that changes the startup screen (a bypass-enabling flag, say)
    // would otherwise make warmup wait for a composer the recording never sees.
    const live = await spawnLive(bin, cwd, cols, rows, args);
    try {
        await waitReady(live, "claude-code", 60_000, true);
    }
    finally {
        live.pty.kill("SIGTERM");
        await sleep(400);
        live.pty.kill("SIGKILL");
    }
}
async function quitAndWaitExit(live) {
    live.pty.write(claudeQuit);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !live.exited())
        await sleep(150);
    if (!live.exited()) {
        live.pty.kill("SIGTERM");
        await sleep(500);
        live.pty.kill("SIGKILL");
    }
    await sleep(300); // let the final output flush through the bridge
}
/**
 * The adapter's permission-mode cycle keystroke, or undefined.
 *
 * A verbatim copy of Conversation.adapterPermissionCycleKeys's shape, and for
 * the same reason: `permissionCycleKeys?()` is an OPTIONAL capability, so this
 * runtime probe is the only real check. The bytes themselves stay in the
 * adapter — claudecode.ts pins `\x1b[Z` and test/turns/permission_cycle.test.ts
 * exists to keep that encoding in exactly one place.
 */
function adapterPermissionCycleKeys(adapter) {
    const a = adapter;
    if (typeof a.permissionCycleKeys === "function") {
        return a.permissionCycleKeys();
    }
    return undefined;
}
/**
 * Thrown when an `await-input` step times out — the ONE failure `--attempts`
 * retries, because it is the one whose cause is the model declining to ask.
 * Every other failure (a missing option, a harness exit, an unexpected dialog)
 * is deterministic and would fail identically on a retry.
 */
class AwaitInputTimeout extends Error {
}
/** Drains the adapter once and maintains the input latch. */
function pump(live, ctx) {
    const evs = ctx.adapter.onScreen(live.screen.snapshot());
    for (const ev of evs) {
        if (ev.kind === InputRequested)
            ctx.lastInput = ev.input ?? null;
        else if (ev.kind === InputResolved)
            ctx.lastInput = null;
    }
    return evs;
}
/** Writes to the PTY, logging the bytes to stdin.log and to meta.keystrokes. */
function writeKeys(live, ctx, data, label) {
    const rendered = printable(data);
    appendFileSync(ctx.stdinLog, `${ctx.stamp()}s  ${label.padEnd(10)} ${rendered}\n`);
    ctx.keystrokes.push(rendered);
    live.pty.write(data);
}
/**
 * The named failure for a trust dialog the adapter cannot parse.
 *
 * Without it an `await-input` on such a frame simply burns its whole 240 s
 * timeout and reports "no input request", which reads as a model problem rather
 * than an adapter one. Guessing keys instead is NOT an option here: PUPPET-304
 * settled that with evidence, and a wrong guess answers the dialog and persists
 * a trust decision that cannot be un-persisted.
 */
const trustUnparseable = "folder-trust dialog is on screen but the adapter cannot parse its " +
    "options (unnumbered menu; needs PUPPET-296). Record in a pre-trusted " +
    "--cwd, or use the trust-dialog scenario, which captures the dialog " +
    "unanswered.";
/** Runs one expanded step list against a live PTY. Throws on the first failure. */
async function runSteps(live, ctx, steps) {
    // `await-turn` numbering counts COMPLETIONS, not step indices, so the legacy
    // scenarios keep the exact "turn N completion" wording they logged before.
    let turn = 0;
    for (const [i, step] of steps.entries()) {
        const where = `step ${i + 1}/${steps.length} ${step.kind}`;
        switch (step.kind) {
            case "prompt": {
                if (ctx.waitsForReady)
                    await waitReady(live, ctx.harness, 90_000, true);
                process.stderr.write(`[screenbench-record] ${where}: ${step.text}\n`);
                writeKeys(live, ctx, enc.encode(step.text), "prompt");
                await sleep(750);
                // claude-code echoes the prompt into the composer before submit; assert
                // it to catch a swallowed keystroke. Other harnesses (codex) consume the
                // text as a paste and do not echo pre-submit — skip the assertion there.
                if (ctx.harness === "claude-code" &&
                    !live.screen.snapshot().text.includes(step.text)) {
                    throw new Error(`prompt was not echoed into the composer: ${step.text}`);
                }
                writeKeys(live, ctx, ctx.submit, "submit");
                break;
            }
            case "await-turn": {
                turn++;
                const n = turn;
                // The production adapter is the completion predicate. A dialog or an
                // error HERE means the scenario went sideways — fail loudly rather than
                // record garbage. This throw is deliberately kept: it only disappears
                // for the steps where a dialog is the point (`await-input`,
                // `await-dialog-anchor`).
                await waitFor(live, `turn ${n} completion`, () => {
                    const evs = pump(live, ctx);
                    for (const ev of evs) {
                        if (ev.kind === InputRequested || ev.kind === Errored) {
                            throw new Error(`unexpected ${ev.kind} during turn ${n}`);
                        }
                    }
                    return evs.some((ev) => ev.kind === TurnComplete);
                }, step.timeoutMs ?? 180_000);
                break;
            }
            case "interrupt": {
                const ispec = ctx.ispec;
                if (!ispec) {
                    throw new Error(`no interrupt spec for harness "${ctx.harness}" (gate missed)`);
                }
                // Wait until the reply is visibly streaming (busy marker AND reply
                // glyph) before interrupting — an ESC during the think phase merely
                // restores the prompt. Then confirm the interrupt landed.
                await waitFor(live, "streaming reply", (t) => t.includes(ispec.busyMarker) && t.includes(ispec.streamingMarker), 120_000);
                await sleep(1_500);
                process.stderr.write("[screenbench-record] sending interrupt\n");
                writeKeys(live, ctx, ispec.key, "interrupt");
                await waitFor(live, "interrupt marker", (t) => t.includes(ispec.confirmText), 30_000);
                break;
            }
            case "await-dialog-anchor": {
                const dspec = ctx.dspec;
                if (!dspec) {
                    throw new Error(`no dialog spec for harness "${ctx.harness}" (gate missed)`);
                }
                // The anchor is the ONLY gate; DetectInput is NOT. Gating on the
                // production adapter would make this recording impossible to take: on
                // 2.1.251 DetectInput returns null for this exact frame — that is the
                // bug PUPPET-296 fixes and that this recording exists to pin.
                await waitFor(live, dspec.what, (t) => dspec.anchors.some((a) => t.includes(a)), step.timeoutMs ?? 90_000);
                await sleep(2_000); // let the dialog finish painting (borders, wrapping)
                // Informational receipt only — never a gate. A structural "wait for the
                // second row" check would re-introduce the parse dependency; the fixed
                // settle above is the guard against a mid-render capture.
                const req = claudecodeDetectInput(live.screen.snapshot().text);
                process.stderr.write(req === null
                    ? "[screenbench-record] note: DetectInput returns null on this frame " +
                        "(expected pre-PUPPET-296; the recording captures the unparsed shape)\n"
                    : `[screenbench-record] DetectInput: ${req.kind}, ` +
                        `${req.options?.length ?? 0} option(s)\n`);
                break;
            }
            case "await-input": {
                const want = step.inputKind;
                const what = want ? `input request (kind ${want})` : "input request";
                // Already pending: an `answer` step leaves the NEXT request latched, so
                // a following await-input must not wait for an edge that already fired.
                const pending = ctx.lastInput;
                if (pending && (!want || pending.kind === want))
                    break;
                try {
                    await waitFor(live, what, () => {
                        const evs = pump(live, ctx);
                        if (ctx.harness === "claude-code" && ctx.lastInput === null) {
                            const text = live.screen.snapshot().text;
                            if (claudeTrustAnchors.some((a) => text.includes(a)) &&
                                claudecodeDetectInput(text) === null) {
                                throw new Error(trustUnparseable);
                            }
                        }
                        return evs.some((ev) => ev.kind === InputRequested &&
                            (!want || ev.input?.kind === want));
                    }, 
                    // The model has to DECIDE to ask (AskUserQuestion is a tool call it
                    // may take a while to reach), so this is far longer than a turn.
                    step.timeoutMs ?? 240_000);
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    // waitFor reports both timeouts and harness exits; only the timeout is
                    // the retryable "the model never asked" case.
                    if (msg.startsWith("timeout waiting for")) {
                        throw new AwaitInputTimeout(msg);
                    }
                    throw err;
                }
                break;
            }
            case "answer": {
                const req = ctx.lastInput;
                if (!req) {
                    throw new Error("no pending input request; an `answer` step must follow an " +
                        "`await-input` step (a dialog that resolved in between clears the latch)");
                }
                let chunks;
                try {
                    // The chat layer's exact byte semantics, deep-imported: a single
                    // optionID on a multi-select prompt becomes toggle-then-submitKeys,
                    // never a bare toggle (which would leave the dialog up forever).
                    chunks = answerKeys(req, {
                        ...(step.optionID !== undefined ? { optionID: step.optionID } : {}),
                        ...(step.optionIDs !== undefined
                            ? { optionIDs: step.optionIDs }
                            : {}),
                    });
                }
                catch (err) {
                    if (isSentinel(err, ErrUnknownOption)) {
                        const ids = (req.options ?? []).map((o) => o.id);
                        const asked = step.optionIDs ?? [step.optionID ?? ""];
                        throw wrap(`answer step: no option ${JSON.stringify(asked.join(", "))} on ` +
                            `input request "${req.prompt}" (available option ids: ` +
                            `${ids.length > 0 ? ids.join(", ") : "none"})`, err);
                    }
                    throw err;
                }
                const answeredID = req.id;
                for (const [k, chunk] of chunks.entries()) {
                    writeKeys(live, ctx, chunk, `answer${String(k + 1)}`);
                    await sleep(250); // let the TUI absorb each chunk before the next
                }
                // A following step must never race the redraw, so wait for the dialog
                // to actually MOVE: either it resolved, or a different request replaced
                // it. A timeout here is a failure, not a shrug — it means the bytes we
                // wrote did not answer anything.
                await waitFor(live, "the answered dialog to resolve or be superseded", () => {
                    const evs = pump(live, ctx);
                    return evs.some((ev) => ev.kind === InputResolved ||
                        (ev.kind === InputRequested && ev.input?.id !== answeredID));
                }, 30_000);
                break;
            }
            case "keys": {
                const bytes = decodeKeys(step.bytes);
                process.stderr.write(`[screenbench-record] ${where}: ${printable(bytes)}\n`);
                writeKeys(live, ctx, bytes, step.label ?? "keys");
                await sleep(900); // probe-shift-tab.ts's measured settle
                break;
            }
            case "cycle": {
                const keys = ctx.cycleKeys;
                if (!keys) {
                    throw new Error(`harness "${ctx.harness}" has no permission-mode cycle keystroke (gate missed)`);
                }
                const n = step.presses ?? 1;
                for (let k = 0; k < n; k++) {
                    writeKeys(live, ctx, keys, "cycle");
                    await sleep(900); // probe-shift-tab.ts's measured settle
                    ctx.presses++;
                    writeFileSync(join(ctx.out, `screen-press-${String(ctx.presses).padStart(2, "0")}.txt`), live.screen.snapshot().text);
                }
                break;
            }
            case "await-text":
                await waitFor(live, `text ${JSON.stringify(step.text)}`, (t) => t.includes(step.text), step.timeoutMs ?? 120_000);
                break;
            case "settle":
                await sleep(step.ms);
                break;
            case "dump":
                // validateDumpFile re-runs here rather than trusting the earlier
                // validation: it returns the name, so the join CANNOT be written
                // without the check.
                writeFileSync(join(ctx.out, validateDumpFile(step.file)), live.screen.snapshot().text);
                break;
        }
    }
}
// --- the overwrite guard (§5.4) ----------------------------------------------
const recorderTag = "src/cli/screenbench-record.ts";
/**
 * The meta.json keys this CLI wrote BEFORE it recorded a `recorder` field.
 *
 * Needed because the guard's simple rule ("no `recorder` ⇒ hand-captured")
 * would refuse to re-record the very cells rebake owns: every recorder-written
 * cell on disk today (codex/multi-turn, claude-code/tool-call, …) predates the
 * field. A hand-captured meta.json always carries prose keys beyond this set
 * (`mode`, `cycle_order`, `not_measured`, `hand_recorded`, `log`, …), so an
 * exact-subset test separates the two without touching the artifacts.
 */
const legacyMetaKeys = new Set([
    "harness",
    "binary_version",
    "recorded_at",
    "cols",
    "rows",
    "notes",
    "workdir",
    "keystrokes",
]);
/**
 * True when `meta` describes a recording THIS CLI produced, and may therefore
 * be regenerated without losing anything a human wrote.
 *
 * Fails CLOSED: unreadable, non-object, or unrecognized meta.json is treated as
 * hand-captured. The cost of a wrong `false` is one `--allow-overwrite`; the
 * cost of a wrong `true` is prose that cost a paid live session.
 */
export function recorderOwnedMeta(meta) {
    if (meta === null || typeof meta !== "object" || Array.isArray(meta))
        return false;
    const m = meta;
    const rec = m.recorder;
    if (typeof rec === "string")
        return rec.startsWith(recorderTag);
    if (rec !== undefined)
        return false;
    return Object.keys(m).every((k) => legacyMetaKeys.has(k));
}
// --- main --------------------------------------------------------------------
export async function main(argv) {
    const p = parseArgs(argv);
    if (p.help) {
        process.stdout.write(USAGE + "\n");
        return ExitOK;
    }
    if (p.error) {
        process.stderr.write(`screenbench-record: ${p.error}\n${USAGE}\n`);
        return ExitUsage;
    }
    // --- resolve the scenario into ONE expanded step list ---------------------
    //
    // Three sources, in this order: the catalog entry (if the name is one), the
    // ad-hoc `--prompt` script (if it is not), and the `--stop-on-input` /
    // `--keys` tail, which appends to either. The result is the single artifact
    // of record: it goes into meta.json verbatim, so what was driven is legible
    // from the recording without re-reading this file.
    const catalogEntry = scenarios[p.scenario];
    const adhoc = p.prompts.length > 0 || p.keys.length > 0;
    if (!catalogEntry && !adhoc) {
        process.stderr.write(`screenbench-record: unknown scenario "${p.scenario}" ` +
            `(known: ${Object.keys(scenarios).join(", ")}; or pass --prompt/--keys ` +
            `for an ad-hoc script)\n`);
        return ExitUsage;
    }
    if (catalogEntry && p.prompts.length > 0) {
        process.stderr.write(`screenbench-record: --prompt is for an ad-hoc script only, but ` +
            `"${p.scenario}" is a catalog scenario with its own prompts\n${USAGE}\n`);
        return ExitUsage;
    }
    const scenario = catalogEntry ?? {
        prompts: p.prompts,
        notes: "ad-hoc script from --prompt/--keys",
    };
    let steps;
    try {
        steps = catalogEntry ? expandScenario(catalogEntry) : [];
        if (!catalogEntry && p.prompts.length > 0) {
            steps = expandScenario({ prompts: p.prompts });
        }
        if (p.stopOnInput) {
            const stop = {
                kind: "await-input",
                ...(p.stopOnInputKind ? { inputKind: p.stopOnInputKind } : {}),
            };
            // Stopping on a dialog REPLACES the trailing wait-for-completion: the
            // turn does not complete, it blocks. Appending both would hard-error in
            // await-turn on the very dialog the caller asked to stop at.
            const last = steps.length - 1;
            if (last >= 0 && steps[last].kind === "await-turn")
                steps[last] = stop;
            else
                steps.push(stop);
        }
        for (const spec of p.keys)
            steps.push(...parseKeysSpec(spec));
        if (steps.length === 0) {
            throw new Error("scenario expands to no steps");
        }
        validateSteps(steps);
    }
    catch (err) {
        process.stderr.write(`screenbench-record: scenario "${p.scenario}": ` +
            (err instanceof Error ? err.message : String(err)) +
            `\n`);
        return ExitUsage;
    }
    // --- pre-write gates ------------------------------------------------------
    //
    // Everything that can refuse a recording refuses HERE, before a single byte
    // is written, so an unsupported request never leaves a partial scenario dir
    // behind for `discover` to find.
    // requiresHarness — declared by the scenario itself.
    if (scenario.requiresHarness && scenario.requiresHarness !== p.harness) {
        process.stderr.write(`screenbench-record: scenario "${p.scenario}" requires harness ` +
            `"${scenario.requiresHarness}", not "${p.harness}"\n`);
        return ExitError;
    }
    // Interrupt-spec gate. interrupt is claude-code-only this ticket.
    if (steps.some((s) => s.kind === "interrupt") && !interruptSpecs[p.harness]) {
        process.stderr.write(`screenbench-record: no interrupt spec for harness "${p.harness}" — ` +
            `scenario "${p.scenario}" cannot be recorded (interrupt is claude-code-only ` +
            `until a per-harness interrupt seam lands)\n`);
        return ExitError;
    }
    // Dialog-spec gate — same shape and placement as the interrupt gate above.
    // The folder-trust dialog is a claude-code concept.
    if (steps.some((s) => s.kind === "await-dialog-anchor") &&
        !dialogSpecs[p.harness]) {
        process.stderr.write(`screenbench-record: no dialog spec for harness "${p.harness}" — ` +
            `scenario "${p.scenario}" cannot be recorded (the folder-trust dialog is ` +
            `a claude-code concept; codex and pi have no equivalent startup dialog)\n`);
        return ExitError;
    }
    let adapter;
    try {
        adapter = resolveAdapter(p.harness);
    }
    catch (err) {
        process.stderr.write(`screenbench-record: ${err instanceof Error ? err.message : String(err)}\n`);
        return ExitError;
    }
    // The SAME structural probe the chat layer uses (conversation.ts's
    // adapterPermissionCycleKeys): the capability is optional on the Adapter
    // interface, so a runtime `typeof … === "function"` test is the only real
    // check. Never hard-code the bytes here — claudecode.ts pins the encoding and
    // test/turns/permission_cycle.test.ts exists to keep it in ONE place.
    const cycleKeys = adapterPermissionCycleKeys(adapter);
    if (steps.some((s) => s.kind === "cycle") && !cycleKeys) {
        process.stderr.write(`screenbench-record: harness "${p.harness}" has no permission-mode cycle ` +
            `keystroke — scenario "${p.scenario}" cannot be recorded (its adapter ` +
            `implements no permissionCycleKeys())\n`);
        return ExitError;
    }
    // Resolve the binary: --bin override wins; otherwise the manifest's
    // entry.binary for this harness, resolved on PATH.
    let binName;
    try {
        binName = p.bin || manifestBinary(p.harness);
    }
    catch (err) {
        process.stderr.write(`screenbench-record: ${err instanceof Error ? err.message : String(err)}\n`);
        return ExitError;
    }
    const resolved = resolveBinary(binName);
    if (!resolved) {
        process.stderr.write(`screenbench-record: binary not found: ${binName}\n`);
        return ExitError;
    }
    // Probe the REAL version and normalize it; this — not --binary-version — is
    // what meta.json records (it must reflect what produced the bytes).
    let binaryVersion;
    try {
        const raw = execFileSync(resolved, ["--version"], {
            encoding: "utf8",
        });
        binaryVersion = normalizeVersion(raw);
    }
    catch (err) {
        process.stderr.write(`screenbench-record: failed to probe ${resolved} --version: ` +
            (err instanceof Error ? err.message : String(err)) +
            "\n");
        return ExitError;
    }
    // Cross-check --binary-version against the NORMALIZED token (never the raw
    // line). A mismatch is a corpus-integrity bug — fail, write nothing.
    if (p.binaryVersion && p.binaryVersion !== binaryVersion) {
        process.stderr.write(`screenbench-record: corpus-integrity error: --binary-version ` +
            `"${p.binaryVersion}" != probed "${binaryVersion}" for ${resolved} ` +
            `(recording against the wrong binary)\n`);
        return ExitError;
    }
    // Untrusted-directory precondition — still BEFORE any file write. An operator
    // who supplies --cwd for a freshWorkdir scenario has taken the uniqueness
    // guarantee into their own hands; if claude has already been trusted there the
    // dialog will not fire and the run would silently record a ready composer.
    if (scenario.freshWorkdir && p.cwd) {
        const configPath = process.env.META_HARNESS_CLAUDE_CONFIG ?? join(homedir(), ".claude.json");
        const trusted = claudeTrustState(p.cwd, configPath);
        if (trusted === true) {
            process.stderr.write(`screenbench-record: --cwd ${p.cwd} is already trusted by claude ` +
                `(~/.claude.json projects[...].hasTrustDialogAccepted); the trust ` +
                `dialog will not fire. Omit --cwd to mint a fresh directory.\n`);
            return ExitError;
        }
        if (trusted === null) {
            process.stderr.write(`[screenbench-record] warning: cannot read ${configPath} — proceeding ` +
                `without the already-trusted precondition check\n`);
        }
    }
    // Overwrite guard (§5.4) — the LAST pre-write gate. The hand-captured
    // meta.json files hold irreplaceable prose evidence (the measured ring
    // length, both probed Shift+Tab encodings, the `not_measured` list) that cost
    // a paid live session; re-recording over one destroys it silently, because
    // the recorder writes a meta.json of its own shape.
    const metaPath = join(p.out, "meta.json");
    if (!p.allowOverwrite && existsSync(metaPath)) {
        let existing = null;
        try {
            existing = JSON.parse(readFileSync(metaPath, "utf8"));
        }
        catch {
            /* unreadable → treated as hand-captured, see recorderOwnedMeta */
        }
        if (!recorderOwnedMeta(existing)) {
            const m = (existing ?? {});
            const mode = typeof m.mode === "string"
                ? m.mode
                : typeof m.recorder === "string"
                    ? m.recorder
                    : "unset";
            process.stderr.write(`screenbench-record: ${p.out} holds a hand-captured recording (meta.json mode\n` +
                `"${mode}"); re-recording would destroy its capture notes.\n` +
                `Pass --allow-overwrite to proceed, after copying the prose you need to keep.\n`);
            return ExitError;
        }
    }
    // From here on we write files.
    let cwd;
    if (p.cwd) {
        cwd = p.cwd;
        mkdirSync(cwd, { recursive: true });
    }
    else if (scenario.freshWorkdir) {
        // A deterministic path is single-use for this scenario: claude persists
        // trust per absolute path (~/.claude.json projects[<path>]
        // .hasTrustDialogAccepted), so run 2 would record a ready composer instead
        // of the dialog. Mint a unique dir so the cell is re-runnable.
        cwd = mkdtempSync(join(tmpdir(), "meta-harness-corpus-rec-trust-"));
    }
    else {
        cwd = join(tmpdir(), "meta-harness-corpus-rec", p.harness, p.scenario);
        mkdirSync(cwd, { recursive: true });
    }
    mkdirSync(p.out, { recursive: true });
    try {
        scenario.setup?.(cwd);
    }
    catch (err) {
        process.stderr.write(`screenbench-record: setup for scenario "${p.scenario}" failed in ` +
            `${cwd}: ` +
            (err instanceof Error ? err.message : String(err)) +
            "\n");
        return ExitError;
    }
    // --launch-arg OVERRIDES the scenario's own launchArgs rather than appending
    // to them: the flag exists to record the same script under a different launch
    // configuration, and a silent merge would make the two impossible to separate.
    const launchArgs = p.launchArgs.length > 0 ? p.launchArgs : (scenario.launchArgs ?? []);
    // Warmup exists to ANSWER and persist the folder-trust decision so the
    // recording pass starts from a clean composer — which is exactly the state a
    // freshWorkdir scenario needs absent. Skip it there, and whenever the caller
    // says the cwd is already trusted (--no-warmup), where it is pure overhead.
    if (p.harness === "claude-code" && !scenario.freshWorkdir && !p.noWarmup) {
        process.stderr.write(`[screenbench-record] warmup in ${cwd}\n`);
        await warmup(resolved, cwd, p.cols, p.rows, launchArgs);
    }
    const bytesPath = join(p.out, "bytes.raw");
    const stdinLogPath = join(p.out, "stdin.log");
    const submit = submitKeyForHarness(p.harness, "");
    const waitsForReady = requiresPromptReadiness(p.harness);
    // The TERMINAL state decides the teardown: a scenario that ends on a blocking
    // dialog must neither settle for a turn that will never complete nor be sent
    // /quit (there is no composer under a modal, and answering the dialog first
    // would persist hasTrustDialogAccepted for the throwaway directory).
    const endsOnDialog = steps[steps.length - 1].kind === "await-dialog-anchor";
    let startedAt;
    let finalText;
    let keystrokes;
    for (let attempt = 1;; attempt++) {
        // Truncate BOTH artifacts per attempt: a retry re-records from scratch (a
        // half-answered dialog cannot be rewound), so a previous attempt's bytes
        // must not survive into the recording that is finally kept.
        writeFileSync(bytesPath, new Uint8Array(0));
        writeFileSync(stdinLogPath, "");
        startedAt = new Date();
        const t0 = Date.now();
        let recording = true;
        const live = await spawnLive(resolved, cwd, p.cols, p.rows, launchArgs, (d) => {
            if (recording)
                appendFileSync(bytesPath, d);
        });
        const ctx = {
            adapter,
            harness: p.harness,
            submit,
            waitsForReady,
            ...(interruptSpecs[p.harness]
                ? { ispec: interruptSpecs[p.harness] }
                : {}),
            ...(dialogSpecs[p.harness] ? { dspec: dialogSpecs[p.harness] } : {}),
            ...(cycleKeys ? { cycleKeys } : {}),
            out: p.out,
            stdinLog: stdinLogPath,
            stamp: () => ((Date.now() - t0) / 1000).toFixed(3).padStart(8),
            keystrokes: [],
            lastInput: null,
            presses: 0,
        };
        try {
            await runSteps(live, ctx, steps);
            if (!endsOnDialog)
                await sleep(1_500); // settle so the final turn renders
        }
        catch (err) {
            // Stop recording BEFORE any kill on EVERY error path: a teardown's
            // alt-screen restore (ESC[?1049l) appended to bytes.raw replays as a
            // blank screen, which is worse than a truncated recording.
            recording = false;
            live.pty.kill("SIGKILL");
            const msg = err instanceof Error ? err.message : String(err);
            if (err instanceof AwaitInputTimeout && attempt < p.attempts) {
                process.stderr.write(`[screenbench-record] attempt ${attempt}/${p.attempts} timed out ` +
                    `waiting for an input request; re-recording from scratch\n`);
                await sleep(500);
                continue;
            }
            process.stderr.write(`screenbench-record: ${msg}\n`);
            return ExitError;
        }
        // Freeze the recording at the settled frame, THEN quit (claude-code only):
        // the goodbye/resume screen /quit paints must not leak into bytes.raw.
        // Non-claude harnesses have no generic graceful-quit seam, so just stop and
        // kill.
        finalText = live.screen.snapshot().text;
        recording = false;
        if (p.harness === "claude-code" && !endsOnDialog) {
            await quitAndWaitExit(live);
        }
        else {
            live.pty.kill("SIGTERM");
            await sleep(400);
            live.pty.kill("SIGKILL");
        }
        keystrokes = ctx.keystrokes;
        break;
    }
    writeFileSync(join(p.out, "expected.txt"), finalText.replace(/\s+$/u, "") + "\n");
    const meta = {
        harness: p.harness,
        binary_version: binaryVersion,
        recorded_at: startedAt.toISOString(),
        cols: p.cols,
        rows: p.rows,
        mode: "scripted",
        recorder: `${recorderTag} (scripted steps)`,
        launch_args: launchArgs,
        notes: `screenbench-record ${p.scenario}: ${scenario.notes}` +
            (p.notes ? ` — ${p.notes}` : ""),
        // Every write, in printable() form and in order — the same rendering
        // stdin.log carries, so meta.json alone answers "what was typed". A cell
        // that ends on an UNANSWERED dialog writes nothing, and says so in the
        // prose form the hand-captured fixtures use rather than as an empty list.
        keystrokes: endsOnDialog && keystrokes.length === 0
            ? "none (dialog captured unanswered)"
            : keystrokes,
        // The expanded script, verbatim: which stop condition a scenario used
        // (`await-input` vs `await-dialog-anchor`) is legible from the artifact.
        steps,
        // The captured frame renders the absolute path verbatim (the "Accessing
        // workspace:" line), so a reader of expected.txt can tell the path is a
        // recorder artifact rather than a transcription error. It is a temp path.
        ...(endsOnDialog ? { workdir: cwd } : {}),
    };
    writeFileSync(join(p.out, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    process.stdout.write(`recorded ${p.out} (${p.scenario}, ${p.harness}, binary ${binaryVersion})\n`);
    return ExitOK;
}
// Node-safe main guard (mirrors src/cli/run.ts): only run when invoked directly.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
        process.stderr.write("screenbench-record: fatal: " + String(err) + "\n");
        process.exit(ExitError);
    });
}
//# sourceMappingURL=screenbench-record.js.map