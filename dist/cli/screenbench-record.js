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
//   --notes <text>             extra meta.json notes
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
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveAdapter } from "../chat/index.js";
import { isClaudeNestingEnvKey } from "../chat/env.js";
import { readyForInput, requiresPromptReadiness, submitKeyForHarness, } from "../chat/ready.js";
import { Screen } from "../screen/index.js";
import { DetectInput as claudecodeDetectInput } from "../turns/harness/claudecode.js";
import { Errored, InputRequested, TurnComplete } from "../turns/index.js";
import { readFrom } from "../versions/index.js";
import { PtyProcess, resolveBinary } from "../wrapper/internal/pty.js";
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
    [--cols <n>] [--rows <n>] [--binary-version <v>] [--notes <text>]`;
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
async function spawnLive(bin, cwd, cols, rows, onData) {
    const screen = new Screen(cols, rows);
    const pty = await PtyProcess.spawn({
        binaryPath: bin,
        args: [],
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
async function warmup(bin, cwd, cols, rows) {
    const live = await spawnLive(bin, cwd, cols, rows);
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
    const scenario = scenarios[p.scenario];
    if (!scenario) {
        process.stderr.write(`screenbench-record: unknown scenario "${p.scenario}" ` +
            `(known: ${Object.keys(scenarios).join(", ")})\n`);
        return ExitUsage;
    }
    // Interrupt-spec gate — BEFORE any file write, so an unsupported request
    // leaves no partial scenario. interrupt is claude-code-only this ticket.
    if (scenario.interrupt && !interruptSpecs[p.harness]) {
        process.stderr.write(`screenbench-record: no interrupt spec for harness "${p.harness}" — ` +
            `scenario "${p.scenario}" cannot be recorded (interrupt is claude-code-only ` +
            `until a per-harness interrupt seam lands)\n`);
        return ExitError;
    }
    // Dialog-spec gate — BEFORE any file write, same shape and placement as the
    // interrupt gate above. The folder-trust dialog is a claude-code concept.
    if (scenario.dialog && !dialogSpecs[p.harness]) {
        process.stderr.write(`screenbench-record: no dialog spec for harness "${p.harness}" — ` +
            `scenario "${p.scenario}" cannot be recorded (the folder-trust dialog is ` +
            `a claude-code concept; codex and pi have no equivalent startup dialog)\n`);
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
    // Warmup exists to ANSWER and persist the folder-trust decision so the
    // recording pass starts from a clean composer — which is exactly the state a
    // freshWorkdir scenario needs absent. Skip it there.
    if (p.harness === "claude-code" && !scenario.freshWorkdir) {
        process.stderr.write(`[screenbench-record] warmup in ${cwd}\n`);
        await warmup(resolved, cwd, p.cols, p.rows);
    }
    const bytesPath = join(p.out, "bytes.raw");
    writeFileSync(bytesPath, new Uint8Array(0));
    const startedAt = new Date();
    let recording = true;
    const live = await spawnLive(resolved, cwd, p.cols, p.rows, (d) => {
        if (recording)
            appendFileSync(bytesPath, d);
    });
    const adapter = resolveAdapter(p.harness);
    const submit = submitKeyForHarness(p.harness, "");
    const waitsForReady = requiresPromptReadiness(p.harness);
    const ispec = scenario.interrupt ? interruptSpecs[p.harness] : undefined;
    try {
        if (scenario.dialog) {
            // The anchor is the ONLY gate; DetectInput is NOT. Gating on the
            // production adapter would make this recording impossible to take: on
            // 2.1.251 DetectInput returns null for this exact frame — that is the bug
            // PUPPET-296 fixes and that this recording exists to pin.
            const dspec = dialogSpecs[p.harness];
            await waitFor(live, dspec.what, (t) => dspec.anchors.some((a) => t.includes(a)), 90_000);
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
        }
        for (const [i, prompt] of scenario.prompts.entries()) {
            if (waitsForReady)
                await waitReady(live, p.harness, 90_000, true);
            process.stderr.write(`[screenbench-record] turn ${i + 1}: ${prompt}\n`);
            live.pty.write(enc.encode(prompt));
            await sleep(750);
            // claude-code echoes the prompt into the composer before submit; assert it
            // to catch a swallowed keystroke. Other harnesses (codex) consume the
            // text as a paste and do not echo pre-submit — skip the assertion there.
            if (p.harness === "claude-code" &&
                !live.screen.snapshot().text.includes(prompt)) {
                throw new Error(`prompt was not echoed into the composer: ${prompt}`);
            }
            live.pty.write(submit);
            if (ispec && i === scenario.prompts.length - 1) {
                // Wait until the reply is visibly streaming (busy marker AND reply
                // glyph) before interrupting — an ESC during the think phase merely
                // restores the prompt. Then confirm the interrupt landed.
                await waitFor(live, "streaming reply", (t) => t.includes(ispec.busyMarker) && t.includes(ispec.streamingMarker), 120_000);
                await sleep(1_500);
                process.stderr.write("[screenbench-record] sending interrupt\n");
                live.pty.write(ispec.key);
                await waitFor(live, "interrupt marker", (t) => t.includes(ispec.confirmText), 30_000);
            }
            else {
                // The production adapter is the completion predicate: poll until it
                // fires TurnComplete for this turn. A dialog or interrupt here means the
                // scenario went sideways — fail loudly rather than record garbage.
                await waitFor(live, `turn ${i + 1} completion`, () => {
                    const evs = adapter.onScreen(live.screen.snapshot());
                    for (const ev of evs) {
                        if (ev.kind === InputRequested || ev.kind === Errored) {
                            throw new Error(`unexpected ${ev.kind} during turn ${i + 1}`);
                        }
                    }
                    return evs.some((ev) => ev.kind === TurnComplete);
                }, 180_000);
            }
        }
        if (!scenario.dialog)
            await sleep(1_500); // settle so the final turn fully renders
    }
    catch (err) {
        live.pty.kill("SIGKILL");
        process.stderr.write(`screenbench-record: ${err instanceof Error ? err.message : String(err)}\n`);
        return ExitError;
    }
    // Freeze the recording at the settled frame, THEN quit (claude-code only): the
    // goodbye/resume screen /quit paints must not leak into bytes.raw. Non-claude
    // harnesses have no generic graceful-quit seam, so just stop and kill.
    //
    // A dialog scenario takes the SIGTERM→SIGKILL branch instead: /quit writes
    // into a composer that does not exist under a modal, and answering the dialog
    // first would persist hasTrustDialogAccepted for the throwaway directory.
    const finalText = live.screen.snapshot().text;
    recording = false;
    if (p.harness === "claude-code" && !scenario.dialog) {
        await quitAndWaitExit(live);
    }
    else {
        live.pty.kill("SIGTERM");
        await sleep(400);
        live.pty.kill("SIGKILL");
    }
    writeFileSync(join(p.out, "expected.txt"), finalText.replace(/\s+$/u, "") + "\n");
    const meta = {
        harness: p.harness,
        binary_version: binaryVersion,
        recorded_at: startedAt.toISOString(),
        cols: p.cols,
        rows: p.rows,
        notes: `screenbench-record ${p.scenario}: ${scenario.notes}` +
            (p.notes ? ` — ${p.notes}` : ""),
        // The captured frame renders the absolute path verbatim (the "Accessing
        // workspace:" line), so a reader of expected.txt can tell the path is a
        // recorder artifact rather than a transcription error. It is a temp path.
        ...(scenario.dialog
            ? { workdir: cwd, keystrokes: "none (dialog captured unanswered)" }
            : {}),
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