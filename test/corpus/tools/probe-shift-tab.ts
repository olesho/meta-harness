// probe-shift-tab.ts — scripted Shift+Tab capture for the permission-mode ring.
//
// record-pty.ts has no scripted-keystroke seam: probe mode writes only a prompt
// plus the submit key, and --interactive needs a human at a real terminal (it
// wires process.stdin through in raw mode). Capturing the Shift+Tab byte
// sequence needs neither — it needs a keystroke written into a live harness PTY
// and a screen dumped after each press — so this driver reuses the SAME
// production seams record-pty does (PtyProcess from src/wrapper/internal/pty.ts,
// Screen from src/screen, readyForInput from src/chat/ready.ts) and scripts the
// presses itself.
//
// It writes each candidate encoding in turn and reports which one actually
// changes the rendered screen, then presses the winner N times, dumping one
// screen per press. That difference — screen changed / did not change — is the
// ground truth; nothing here assumes an encoding.
//
// Usage:
//   bun test/corpus/tools/probe-shift-tab.ts --out <dir> [--bin claude]
//     [--harness claude-code] [--presses 8] [--cols 120] [--rows 40]
//     [--settle 900] [--candidates '\x1b[Z,\x1b[9;2u'] [-- <extra harness args>]

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readyForInput } from "../../../src/chat/ready.ts";
import { Screen } from "../../../src/screen/index.ts";
import {
  PtyProcess,
  resolveBinary,
} from "../../../src/wrapper/internal/pty.ts";

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Render bytes as a printable escape string ("\x1b[Z"), as record-pty does. */
function printable(data: Uint8Array): string {
  let out = "";
  for (const b of data) {
    if (b === 0x1b) out += "\\x1b";
    else if (b === 0x0d) out += "\\r";
    else if (b === 0x0a) out += "\\n";
    else if (b === 0x09) out += "\\t";
    else if (b < 0x20 || b === 0x7f)
      out += "\\x" + b.toString(16).padStart(2, "0");
    else out += String.fromCharCode(b);
  }
  return out;
}

const argv = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v ?? def;
}

const out = flag("--out", "");
if (!out) throw new Error("--out <dir> is required");
const bin = flag("--bin", "claude");
const harness = flag("--harness", "claude-code");
const presses = Number(flag("--presses", "8"));
const cols = Number(flag("--cols", "120"));
const rows = Number(flag("--rows", "40"));
const settle = Number(flag("--settle", "900"));
const readyTimeoutMs = Number(flag("--ready-timeout", "60000"));
const candidatesArg = flag("--candidates", "\\x1b[Z,\\x1b[9;2u");
// --status: after the ready dump and after every press, run the harness's
// `/status` command (the SessionIDPrimer keystrokes: "/status" + CSI 13 u) and
// dump the resulting box. That is how Codex's collaboration mode is read back
// from an authoritative surface rather than from the composer's terse marker.
const withStatus = argv.includes("--status");
// --press-before-ready: write one press BEFORE waiting for readiness, to probe
// whether a press landing in the boot window is swallowed. --boot-press-delay
// places it inside that window (e.g. after the composer paints but while MCP
// servers are still booting) rather than at t=0 before the TUI paints at all.
const pressBeforeReady = argv.includes("--press-before-ready");
const bootPressDelayMs = Number(flag("--boot-press-delay", "0"));
// --boot-keys overrides the boot-window press encoding (defaults to the first
// candidate, which is empty when --candidates is deliberately empty).
const bootKeys = flag("--boot-keys", "").replaceAll("\\x1b", "\x1b");
const dashDash = argv.indexOf("--");
const extraArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : [];

const candidates = candidatesArg
  .split(",")
  .map((s) => s.replaceAll("\\x1b", "\x1b"));

const resolved = resolveBinary(bin);
if (!resolved) throw new Error(`binary not found: ${bin}`);
let binaryVersion = "unknown";
try {
  binaryVersion =
    execFileSync(resolved, ["--version"], { encoding: "utf8" })
      .trim()
      .split("\n")[0] ?? "unknown";
} catch {
  /* leave "unknown" */
}

mkdirSync(out, { recursive: true });
const bytesPath = join(out, "bytes.raw");
const stdinLogPath = join(out, "stdin.log");
writeFileSync(bytesPath, new Uint8Array(0));
writeFileSync(stdinLogPath, "");

const startedAt = Date.now();
const stamp = () => ((Date.now() - startedAt) / 1000).toFixed(3).padStart(8);

const screen = new Screen(cols, rows);
const pty = await PtyProcess.spawn({
  binaryPath: resolved,
  args: extraArgs,
  cols,
  rows,
});

let exited = false;
// recording gates the bytes.raw tee. It is cleared before SIGTERM so the
// recording ENDS BEFORE TEARDOWN, matching the discipline of the existing
// permission-mode fixtures: on exit the harness emits the alt-screen restore
// (ESC[?1049l) and pops the kitty keyboard protocol, and a stream ending with
// those replays to a BLANK screen — useless as a fixture.
let recording = true;
pty.onExit(() => {
  exited = true;
});
pty.onData((d) => {
  if (recording) appendFileSync(bytesPath, d);
  void screen.write(d);
});

function writeKeys(s: string, label: string): void {
  const d = enc.encode(s);
  appendFileSync(
    stdinLogPath,
    `${stamp()}s  ${label.padEnd(12)} ${printable(d)}\n`,
  );
  pty.write(d);
}

function dump(name: string): string {
  const { text } = screen.snapshot();
  writeFileSync(join(out, name), text);
  return text;
}

const log: Record<string, unknown>[] = [];

/**
 * Run `/status` and dump the resulting box.
 *
 * Deliberately NOT the single "/status\x1b[13u" burst primeSessionIDKeys sends:
 * typing a slash command opens an autocomplete popup, and an Enter arriving in
 * the same burst is consumed by the popup instead of submitting — the text then
 * sits in the composer and swallows every subsequent keystroke, including the
 * Shift+Tab presses this probe is measuring. So: type, let the popup settle,
 * submit separately, then clear the composer (ESC, then Ctrl-U kill-line) so
 * the next press lands on an empty composer.
 */
async function statusDump(name: string): Promise<string> {
  writeKeys("/status", "status-type");
  await sleep(settle);
  writeKeys("\x1b[13u", "status-enter");
  await sleep(settle * 2);
  const text = dump(name);
  writeKeys("\x1b", "esc");
  await sleep(200);
  writeKeys("\x15", "kill-line");
  await sleep(300);
  return text;
}

// Phase -1 — optional boot-window press, BEFORE readiness.
if (pressBeforeReady) {
  const keys = bootKeys || candidates[0] || "\x1b[Z";
  if (bootPressDelayMs > 0) await sleep(bootPressDelayMs);
  const atMs = Date.now() - startedAt;
  dump("screen-boot-before-press.txt");
  writeKeys(keys, "boot-press");
  await sleep(settle);
  dump("screen-boot-after-press.txt");
  log.push({
    phase: "boot-press",
    keys: printable(enc.encode(keys)),
    at_ms: atMs,
  });
  console.log(`boot-press ${printable(enc.encode(keys))} at ${atMs}ms`);
}

// Phase 0 — wait for the production readiness predicate (same as record-pty).
const readyDeadline = startedAt + readyTimeoutMs;
let ready = false;
while (Date.now() < readyDeadline && !exited) {
  if (readyForInput(harness, screen.snapshot().text)) {
    ready = true;
    break;
  }
  await sleep(150);
}
console.log(`ready=${ready} exited=${exited} at ${Date.now() - startedAt}ms`);
await sleep(settle);
let prev = dump("screen-00-ready.txt");
if (withStatus) prev = await statusDump("screen-00-ready-status.txt");

// Phase 1 — which candidate encoding does the harness actually react to?
let working = "";
for (const c of candidates) {
  const label = printable(enc.encode(c));
  writeKeys(c, "candidate");
  await sleep(settle);
  const text = dump(`screen-cand-${label.replaceAll(/[^\w]/g, "_")}.txt`);
  const changed = text !== prev;
  log.push({ phase: "candidate", keys: label, changed });
  console.log(`candidate ${label} changed=${changed}`);
  if (changed && !working) working = c;
  prev = text;
}

// Phase 2 — press the winner repeatedly, one screen per rung.
if (working) {
  for (let i = 0; i < presses; i++) {
    writeKeys(working, `press-${i + 1}`);
    await sleep(settle);
    const n = String(i + 1).padStart(2, "0");
    let text = dump(`screen-press-${n}.txt`);
    const changed = text !== prev;
    log.push({ phase: "press", n: i + 1, changed });
    console.log(`press ${i + 1} changed=${changed}`);
    if (withStatus) text = await statusDump(`screen-press-${n}-status.txt`);
    prev = text;
  }
} else {
  console.log("NO CANDIDATE CHANGED THE SCREEN");
}

writeFileSync(
  join(out, "probe.json"),
  JSON.stringify(
    {
      harness,
      binary_version: binaryVersion,
      recorded_at: new Date(startedAt).toISOString(),
      cols,
      rows,
      extra_args: extraArgs,
      candidates: candidates.map((c) => printable(enc.encode(c))),
      working: working ? printable(enc.encode(working)) : null,
      ready,
      log,
    },
    null,
    2,
  ) + "\n",
);
dump("screen-final.txt");
recording = false; // everything past here is teardown — see the flag's comment.
pty.kill("SIGTERM");
await sleep(400);
pty.kill("SIGKILL");
process.exit(0);
