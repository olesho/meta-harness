// probe-codex-permissions.ts — scripted live probes for codex's /permissions
// dialog: the commit keystrokes, the backout keystrokes, the composer-clear
// keystrokes, and CODEX_HOME containment.
//
// Why a scripted driver rather than record-pty.ts --interactive: --interactive
// needs a human at a real terminal (it wires process.stdin through in raw
// mode), and these probes are a MATRIX — the same four candidate encodings
// replayed against three menu families, each cell needing the screen inspected
// before the next cell may run. probe-shift-tab.ts established this shape for
// exactly that reason; this file reuses the same production seams (PtyProcess
// from src/wrapper/internal/pty.ts, Screen from src/screen, readyForInput from
// src/chat/ready.ts) and emits the same artifacts record-pty does — bytes.raw,
// stdin.log (every write, escape-encoded — THE pin), meta.json, screen dumps.
//
// SAFETY. Committing a /permissions preset writes the GLOBAL config.toml under
// $CODEX_HOME (observed: it adds `approvals_reviewer`). Every phase that can
// press Enter on a menu row therefore runs under an isolated, seeded CODEX_HOME
// (test/helpers/codex_home.ts) — never the developer's real ~/.codex. The
// `--codex-home real` escape hatch exists only for read-only recon and refuses
// to run any committing phase.
//
// Usage:
//   bun test/corpus/tools/probe-codex-permissions.ts --out <dir> --phase <name>
//     [--bin codex] [--cols 120] [--rows 40] [--settle 900]
//     [--ready-timeout 60000] [--codex-home isolated|real|<path>] [--keep-home]
//     [--notes "..."] [-- <extra harness args>]
//
// Phases:
//   recon            launch and dump one screen per second; press nothing.
//   permissions      open /permissions, then run the 2x2 commit-key matrix
//                    (digit+CR / digit+CSI-13-u, each as one burst and as two
//                    writes), backing the dialog out between cells.
//   update-notice    same 2x2 matrix against the "Update available!" notice.
//   approval         send a prompt that provokes a command-approval dialog,
//                    then run the same 2x2 matrix against it.
//   backout          open /permissions and try each ESC candidate in turn.
//   composer-clear   type "/permissions" WITHOUT submitting, then try each
//                    composer-clear candidate in turn.
//   commit           open /permissions, select "Approve for me", commit, and
//                    read the result back through /status. Isolated home only.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { readyForInput } from "../../../src/chat/ready.ts";
import { Screen } from "../../../src/screen/index.ts";
import {
  PtyProcess,
  resolveBinary,
} from "../../../src/wrapper/internal/pty.ts";
import { seedIsolatedCodexHome } from "../../helpers/codex_home.ts";

const enc = new TextEncoder();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Render bytes as a printable escape string ("\x1b[13u"), as record-pty does. */
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

/** Decode the "\x1b"/"\r"-style escapes this tool accepts on the command line. */
function unescape(s: string): string {
  return s
    .replaceAll("\\x1b", "\x1b")
    .replaceAll("\\r", "\r")
    .replaceAll("\\n", "\n")
    .replaceAll(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

const argv = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  return v ?? def;
}

const out = flag("--out", "");
if (!out) throw new Error("--out <dir> is required");
const phase = flag("--phase", "recon");
const bin = flag("--bin", "codex");
const harness = flag("--harness", "codex");
const cols = Number(flag("--cols", "120"));
const rows = Number(flag("--rows", "40"));
const settle = Number(flag("--settle", "900"));
const readyTimeoutMs = Number(flag("--ready-timeout", "60000"));
const homeMode = flag("--codex-home", "isolated");
const keepHome = argv.includes("--keep-home");
const notes = flag("--notes", "");
const reconSecs = Number(flag("--recon-secs", "20"));
const bootSettle = Number(flag("--boot-settle", "3000"));
// Which shape opens the dialog: one burst, or type-then-submit.
const openShape = flag("--open-shape", "burst");
// Run exactly ONE matrix cell, then exit. Every cell gets its own process and
// its own fresh isolated home, so no cell can inherit another's composer text,
// autocomplete popup, or committed preset. `""` runs the whole matrix in one
// process (fast, but only trustworthy once the cells are known independent).
const onlyCell = flag("--cell", "");
const prompt = flag(
  "--prompt",
  "Run the shell command `echo probe-approval-marker` for me. Do not explain, just run it.",
);
const dashDash = argv.indexOf("--");
const extraArgs = dashDash >= 0 ? argv.slice(dashDash + 1) : [];

// Phases that can land an Enter on a menu row must never run against the real
// ~/.codex — that is the global write this whole ticket exists to contain.
const COMMITTING = new Set(["permissions", "update-notice", "approval", "commit"]);
if (COMMITTING.has(phase) && homeMode === "real") {
  throw new Error(
    `phase ${phase} presses Enter on menu rows and would write the real ~/.codex/config.toml; ` +
      `use --codex-home isolated`,
  );
}

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

// ── Isolated home + real-home fingerprints ───────────────────────────────────

const realHome = join(homedir(), ".codex");
const realFiles = ["config.toml", "auth.json"];
function fingerprintRealHome(): Record<string, string | null> {
  const fp: Record<string, string | null> = {};
  for (const f of realFiles) {
    const p = join(realHome, f);
    fp[f] = existsSync(p)
      ? createHash("sha256").update(readFileSync(p)).digest("hex")
      : null;
  }
  return fp;
}

let codexHome = "";
let cleanupHome: (() => void) | null = null;
if (homeMode === "isolated") {
  const root = mkdtempSync(join(tmpdir(), "probe-codex-home-"));
  const seeded = seedIsolatedCodexHome(join(root, "home"));
  if (!seeded) {
    throw new Error(
      "no ~/.codex/auth.json — an empty CODEX_HOME lands on the sign-in wall " +
        "(signinWallRE / onboardingWall), so readyForInput never fires. Stop.",
    );
  }
  codexHome = seeded.dir;
  cleanupHome = () => {
    seeded.cleanup();
    rmSync(root, { recursive: true, force: true });
  };
} else if (homeMode !== "real") {
  codexHome = homeMode;
  mkdirSync(codexHome, { recursive: true });
}

// The "Update available!" notice renders when $CODEX_HOME/version.json advertises
// a newer release than the running binary. A FRESH home has no version.json, so
// the notice cannot appear on a first launch — it appears on the SECOND launch of
// a home, after the background version check has landed. Seeding the file makes
// the notice deterministic on the first launch instead.
//
// The seeded `latest_version` is deliberately a fiction and MUST stay one: this
// probe never selects the notice's row 1 ("Update now"), which shells out to
// `npm install -g @openai/codex` and mutates the developer's global binary.
if (argv.includes("--seed-update-notice")) {
  if (!codexHome) throw new Error("--seed-update-notice needs an isolated home");
  writeFileSync(
    join(codexHome, "version.json"),
    JSON.stringify({
      latest_version: flag("--seed-latest-version", "0.145.0"),
      last_checked_at: new Date().toISOString(),
      dismissed_version: null,
    }) + "\n",
  );
}

const beforeFingerprint = fingerprintRealHome();

// ── Recording plumbing (mirrors record-pty.ts) ───────────────────────────────

mkdirSync(out, { recursive: true });
const bytesPath = join(out, "bytes.raw");
const stdinLogPath = join(out, "stdin.log");
writeFileSync(bytesPath, new Uint8Array(0));
writeFileSync(stdinLogPath, "");

const startedAt = Date.now();
const stamp = () => ((Date.now() - startedAt) / 1000).toFixed(3).padStart(8);

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
if (codexHome) env.CODEX_HOME = codexHome;

const cwd = mkdtempSync(join(tmpdir(), "probe-codex-cwd-"));

const screen = new Screen(cols, rows);
const pty = await PtyProcess.spawn({
  binaryPath: resolved,
  args: extraArgs,
  cwd,
  env,
  cols,
  rows,
});

let exited = false;
// recording gates the bytes.raw tee: it is cleared before SIGTERM so the stream
// ends BEFORE teardown (the alt-screen restore would replay to a blank screen).
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
    `${stamp()}s  ${label.padEnd(18)} ${printable(d)}\n`,
  );
  pty.write(d);
}

function text(): string {
  return screen.snapshot().text;
}

function dump(name: string): string {
  const t = text();
  writeFileSync(join(out, name), t);
  return t;
}

async function waitFor(
  pred: (t: string) => boolean,
  boundMs: number,
): Promise<boolean> {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline && !exited) {
    if (pred(text())) return true;
    await sleep(150);
  }
  return pred(text());
}

const log: Record<string, unknown>[] = [];
function note(entry: Record<string, unknown>): void {
  log.push(entry);
  console.log(JSON.stringify(entry));
}

// ── Shared screen predicates ─────────────────────────────────────────────────

const PERMISSIONS_ANCHOR = "Update Model Permissions";
const UPDATE_ANCHOR = "Update available!";
const APPROVAL_ANCHOR_RE = /Allow .*to run|Would you like|Apply changes|approve/i;
const composerRowRE = /^[^\S\r\n]*›(.*)$/;

/** The text of the LAST "› …" row — the composer, per codex.ts:355-357. */
function composerRow(t: string): string | null {
  const rows = t.split("\n").filter((l) => composerRowRE.test(l));
  const last = rows.at(-1);
  if (last === undefined) return null;
  return (composerRowRE.exec(last)?.[1] ?? "").trim();
}

/** Which menu row currently carries the "›" highlight, and which reads "(current)". */
function menuState(t: string): { highlighted: string | null; current: string | null } {
  let highlighted: string | null = null;
  let current: string | null = null;
  for (const line of t.split("\n")) {
    const m = /^\s*(›?)\s*(\d)\.\s+(.*?)(?:\s{2,}.*)?$/.exec(line);
    if (!m) continue;
    const label = `${m[2]}. ${m[3].trim()}`;
    if (m[1] === "›") highlighted = label;
    if (m[3].includes("(current)")) current = label;
  }
  return { highlighted, current };
}

// ── Candidate byte sequences under probe ─────────────────────────────────────

/**
 * The 2x2 commit matrix. `parseMenuOptions` (src/turns/harness/codex.ts:597)
 * emits `num + "\r"` as ONE burst; submitKeyForHarness (src/chat/ready.ts:299)
 * says a bare CR from a synthetic writer is not a submit under the kitty
 * protocol. `writeAnswer` (src/chat/conversation.ts:1007) writes opt.keys as a
 * SINGLE pty write, and writeMessageAndSubmit's docstring records codex 0.142.5
 * consuming a text+Enter burst as a PASTE. So both axes matter.
 */
interface Cell {
  id: string;
  writes: string[];
}
function commitCells(digits: string[]): Cell[] {
  // The digit ALTERNATES between cells so every cell targets a row that is not
  // already "(current)": otherwise a successful commit would be invisible
  // (committing the preset already in effect changes nothing on screen) and a
  // working encoding would be indistinguishable from a dead one.
  const shape = [
    (d: string) => ({ id: "cr-burst", writes: [`${d}\r`] }),
    (d: string) => ({ id: "cr-split", writes: [d, "\r"] }),
    (d: string) => ({ id: "csi13u-burst", writes: [`${d}\x1b[13u`] }),
    (d: string) => ({ id: "csi13u-split", writes: [d, "\x1b[13u"] }),
  ];
  return shape.map((f, i) => {
    const c = f(digits[i % digits.length]);
    return { id: `${c.id}-d${digits[i % digits.length]}`, writes: c.writes };
  });
}

/** The last "Permissions updated to X" confirmation codex printed, if any. */
function lastUpdateLine(t: string): string | null {
  const all = [...t.matchAll(/Permissions updated to (.+)/g)];
  return all.at(-1)?.[1].trim() ?? null;
}

const BACKOUT_CANDIDATES: Cell[] = [
  { id: "bare-esc", writes: ["\x1b"] },
  { id: "csi-27u", writes: ["\x1b[27u"] },
];

const CLEAR_CANDIDATES: Cell[] = [
  { id: "ctrl-u", writes: ["\x15"] },
  { id: "ctrl-a-ctrl-k", writes: ["\x01", "\x0b"] },
  { id: "backspace-run", writes: Array.from({ length: 24 }, () => "\x7f") },
];

async function runCell(cell: Cell, label: string): Promise<void> {
  for (const [i, w] of cell.writes.entries()) {
    writeKeys(w, `${label}#${i}`);
    if (cell.writes.length > 1) await sleep(180);
  }
  await sleep(settle);
}

// ── Phase 0 — boot interstitials, then readiness ─────────────────────────────

// Let the TUI paint before reading the boot screen: the very first frames are
// blank and would report every anchor absent.
await waitFor((t) => t.trim() !== "", 15_000);
await sleep(settle);
const bootText = dump("screen-00-boot.txt");
// The first-run interstitials a fresh, config-less home renders are a FINDING —
// record whatever the boot screen said before anything was pressed.
note({
  phase: "boot-screen",
  update_notice: bootText.includes(UPDATE_ANCHOR),
  press_enter_to_continue: bootText.includes("Press enter to continue"),
  folder_trust: /Do you trust the contents of this directory/i.test(bootText),
  signin_wall: /sign in with chatgpt|finish signing in/i.test(bootText),
  menu: menuState(bootText),
});

// Dismiss whatever the fresh home put in the way, recording WHICH encoding did
// it. This is a free extra cell of probe 1's matrix: the folder-trust screen is
// a numbered menu parsed by the same parseMenuOptions, and the shipped
// auto-dismiss for a KindNotice is a bare "\r" (codex.ts AutoDismissKeys).
//
// A BARE "\r" IS NEVER SAFE ON THE UPDATE NOTICE. Its highlighted default row
// is "1. Update now (runs `npm install -g @openai/codex`)", and a bare Enter
// there upgrades the GLOBAL binary — field-observed during this probe, which
// silently moved codex 0.144.5 -> 0.145.0 out from under the run. That is
// exactly why the shipped AutoDismissKeys KindUpdateNotice branch
// (codex.ts:536-540) returns the "Skip" ROW's keys (digit + CR) instead of a
// bare CR. This ladder does the same: it resolves the Skip row by label and
// never presses an unqualified Enter while the update anchor is on screen.
const DISMISS_LADDER = [
  { id: "bare-cr", keys: "\r" },
  { id: "csi13u", keys: "\x1b[13u" },
];

/** The digit of the first menu row whose label matches `re`, or null. */
function rowDigit(t: string, re: RegExp): string | null {
  for (const line of t.split("\n")) {
    const m = /^\s*›?\s*(\d)\.\s+(.*?)(?:\s{2,}.*)?$/.exec(line);
    if (m && re.test(m[2])) return m[1];
  }
  return null;
}

for (let round = 0; round < 4; round++) {
  const before = text();
  if (
    !before.includes("Press enter to continue") &&
    !before.includes(UPDATE_ANCHOR)
  )
    break;
  // The update-notice phase MEASURES this notice — leave it on screen.
  if (phase === "update-notice" && before.includes(UPDATE_ANCHOR)) break;

  if (before.includes(UPDATE_ANCHOR)) {
    // Never a bare Enter here — see the block comment above.
    const skip = rowDigit(before, /^Skip$/);
    if (skip === null) {
      note({
        phase: "interstitial-dismiss",
        round,
        error:
          "update notice on screen with no 'Skip' row — refusing to press Enter " +
          "(row 1 runs a global npm install -g)",
      });
      break;
    }
    writeKeys(`${skip}\r`, "dismiss-update-skip");
    await sleep(settle);
    const after = text();
    note({
      phase: "interstitial-dismiss",
      round,
      encoding: "skip-row",
      keys: printable(enc.encode(`${skip}\r`)),
      screen_changed: after !== before,
      dismissed: !after.includes(UPDATE_ANCHOR),
    });
    continue;
  }

  let dismissed = false;
  for (const step of DISMISS_LADDER) {
    writeKeys(step.keys, `dismiss-${step.id}`);
    await sleep(settle);
    const after = text();
    const gone =
      !after.includes("Press enter to continue") &&
      !after.includes(UPDATE_ANCHOR);
    note({
      phase: "interstitial-dismiss",
      round,
      encoding: step.id,
      keys: printable(enc.encode(step.keys)),
      screen_changed: after !== before,
      dismissed: gone,
    });
    if (gone) {
      dismissed = true;
      break;
    }
  }
  if (!dismissed) break;
}
dump("screen-01-after-dismiss.txt");

const readyDeadline = startedAt + readyTimeoutMs;
let ready = false;
while (Date.now() < readyDeadline && !exited) {
  if (readyForInput(harness, text())) {
    ready = true;
    break;
  }
  await sleep(150);
}
await sleep(settle);
note({ phase: "ready", ready, exited, at_ms: Date.now() - startedAt });
dump("screen-02-ready.txt");

// readyForInput() going true is NOT the same as "the composer will consume the
// next write": the recorded permission-mode-cycle-boot-window fixture shows the
// `›` composer painted, readyForInput true, and the keystroke swallowed anyway.
// A first burst written the same millisecond ready fired was in fact swallowed
// in an early run of this probe, so the boot window is held open explicitly.
await sleep(bootSettle);
dump("screen-03-boot-settled.txt");

/**
 * Opens the /permissions dialog in the requested shape and reports whether the
 * dialog actually appeared.
 *
 * `burst` writes "/permissions" + CSI 13 u as ONE pty write — the shape
 * primeSessionIDKeys (codex.ts:239-241) already ships for "/status", and the
 * shape a `permissionsDialogKeys()` would take. `split` types the command,
 * lets the slash-command autocomplete popup settle, then submits separately —
 * the shape probe-shift-tab.ts's statusDump uses precisely because an Enter
 * arriving in the same burst can be eaten by that popup.
 */
async function openPermissions(
  tag: string,
  shape: string = openShape,
): Promise<boolean> {
  if (shape === "split") {
    writeKeys("/permissions", `open-type-${tag}`);
    await sleep(settle);
    writeKeys("\x1b[13u", `open-submit-${tag}`);
  } else {
    writeKeys("/permissions\x1b[13u", `open-burst-${tag}`);
  }
  const opened = await waitFor((t) => t.includes(PERMISSIONS_ANCHOR), 12_000);
  await sleep(settle);
  return opened;
}

async function main(): Promise<void> {
  switch (phase) {
    case "recon": {
      for (let i = 0; i < reconSecs; i++) {
        await sleep(1000);
        dump(`screen-recon-${String(i).padStart(2, "0")}.txt`);
        if (exited) break;
      }
      note({
        phase: "recon",
        home_files: codexHome && existsSync(codexHome) ? readdirSync(codexHome) : [],
      });
      break;
    }

    case "open": {
      // Which shape of `permissionsDialogKeys()` actually opens the dialog.
      // Read-only: the dialog is backed out with ESC, never committed.
      const opened = await openPermissions("shape", openShape);
      const t = dump("screen-04-open.txt");
      note({
        phase: "open",
        shape: openShape,
        keys:
          openShape === "split"
            ? [printable(enc.encode("/permissions")), printable(enc.encode("\x1b[13u"))]
            : [printable(enc.encode("/permissions\x1b[13u"))],
        opened,
        menu: menuState(t),
        composer_row: composerRow(t),
      });
      writeKeys("\x1b", "open-backout");
      await sleep(settle);
      dump("screen-05-open-backout.txt");
      break;
    }

    case "permissions":
    case "update-notice":
    case "approval": {
      const family =
        phase === "permissions"
          ? "permissions_prompt"
          : phase === "update-notice"
            ? "update_notice"
            : "approval_prompt";

      if (phase === "approval") {
        writeKeys(prompt, "approval-prompt");
        await sleep(settle);
        writeKeys("\x1b[13u", "approval-submit");
        const got = await waitFor(
          (t) => APPROVAL_ANCHOR_RE.test(t) && /^\s*›?\s*\d\.\s+/m.test(t),
          120_000,
        );
        note({ phase: "approval-dialog", appeared: got });
        dump("screen-approval-dialog.txt");
        if (!got) break;
      }

      // Whether the family's modal is GONE. For permissions the header vanishes
      // outright; the update notice instead leaves a passive "Update available!"
      // banner in scrollback after Skip, so its anchor is useless here and the
      // interactive footer is what actually disappears. The approval dialog is
      // likewise identified by its footer plus a live menu.
      const modalGone = (t: string): boolean =>
        phase === "permissions"
          ? !t.includes(PERMISSIONS_ANCHOR)
          : !t.includes("Press enter to continue") &&
            !/^\s*›?\s*\d\.\s+/m.test(t);

      // For permissions, rows 2 ("Approve for me" — the preset this ticket is
      // about) and 3 ("Full Access") alternate so no cell ever re-commits the
      // row already "(current)". For the update notice row 2 is "Skip" — the row
      // the shipped AutoDismissKeys picks, and never "1. Update now".
      // On an approval dialog row 3 is "No, and tell Codex what to do
      // differently" — the DENY row. Every cell picks it, so a working encoding
      // is proven without this probe ever approving a command.
      const defaultDigits =
        phase === "permissions" ? ["2", "3"] : phase === "approval" ? ["3"] : ["2"];
      const digitsArg = flag("--digits", "");
      const allCells = commitCells(
        digitsArg ? digitsArg.split(",") : defaultDigits,
      );
      const cells = onlyCell
        ? allCells.filter((c) => c.id === onlyCell || c.id.startsWith(onlyCell))
        : allCells;
      if (cells.length === 0) {
        throw new Error(
          `--cell ${onlyCell} matched none of: ${allCells.map((c) => c.id).join(", ")}`,
        );
      }
      for (const cell of cells) {
        if (phase === "permissions") {
          const opened = await openPermissions(cell.id);
          if (!opened) {
            note({ phase: "cell", family, cell: cell.id, error: "dialog did not open" });
            continue;
          }
        }
        if (phase === "update-notice" && modalGone(text())) {
          note({
            phase: "cell",
            family,
            cell: cell.id,
            error: "no live update notice on screen",
          });
          break;
        }
        const before = text();
        const beforeState = menuState(before);
        dump(`screen-${family}-${cell.id}-before.txt`);
        await runCell(cell, `commit-${cell.id}`);
        const after = text();
        const afterState = menuState(after);
        dump(`screen-${family}-${cell.id}-after.txt`);
        const dialogGone = modalGone(after);
        note({
          phase: "cell",
          family,
          cell: cell.id,
          writes: cell.writes.map((w) => printable(enc.encode(w))),
          burst: cell.writes.length === 1,
          before_highlight: beforeState.highlighted,
          after_highlight: afterState.highlighted,
          before_current: beforeState.current,
          after_current: afterState.current,
          selection_moved: beforeState.highlighted !== afterState.highlighted,
          dialog_dismissed: dialogGone,
          committed: dialogGone && afterState.current !== beforeState.current,
          confirmation_before: lastUpdateLine(before),
          confirmation_after: lastUpdateLine(after),
          composer_row: composerRow(after),
          screen_changed: before !== after,
        });
        // Back out of anything still up before the next cell.
        if (!dialogGone) {
          writeKeys("\x1b", `backout-after-${cell.id}`);
          await sleep(settle);
        }
        // Clear whatever the cell may have left in the composer.
        writeKeys("\x15", `clear-after-${cell.id}`);
        await sleep(400);
      }
      break;
    }

    case "backout": {
      for (const cand of BACKOUT_CANDIDATES) {
        const opened = await openPermissions(cand.id);
        if (!opened) {
          note({ phase: "backout", cand: cand.id, error: "dialog did not open" });
          continue;
        }
        dump(`screen-backout-${cand.id}-before.txt`);
        await runCell(cand, `backout-${cand.id}`);
        const after = text();
        dump(`screen-backout-${cand.id}-after.txt`);
        const state = menuState(after);
        note({
          phase: "backout",
          cand: cand.id,
          writes: cand.writes.map((w) => printable(enc.encode(w))),
          dialog_dismissed: !after.includes(PERMISSIONS_ANCHOR),
          current_after: state.current,
          composer_row: composerRow(after),
        });
        if (after.includes(PERMISSIONS_ANCHOR)) {
          // Leave a clean screen for the next candidate.
          writeKeys("\x1b", `force-backout-${cand.id}`);
          await sleep(settle);
        }
        writeKeys("\x15", `clear-${cand.id}`);
        await sleep(400);
      }
      break;
    }

    case "composer-clear": {
      for (const cand of CLEAR_CANDIDATES) {
        // Literal text in the composer, deliberately NOT submitted.
        writeKeys("/permissions", `type-${cand.id}`);
        await sleep(settle);
        const typed = dump(`screen-clear-${cand.id}-typed.txt`);
        const typedRow = composerRow(typed);
        await runCell(cand, `clear-${cand.id}`);
        const after = dump(`screen-clear-${cand.id}-after.txt`);
        const clearedRow = composerRow(after);
        note({
          phase: "composer-clear",
          cand: cand.id,
          writes: cand.writes.map((w) => printable(enc.encode(w))),
          write_count: cand.writes.length,
          typed_row: typedRow,
          cleared_row: clearedRow,
          cleared: clearedRow === "",
          // A slash command opens an autocomplete popup; note whether it closed.
          popup_gone: !after.includes(PERMISSIONS_ANCHOR),
        });
        if (clearedRow !== "") {
          // Force a clean composer for the next candidate.
          writeKeys("\x1b", `esc-${cand.id}`);
          await sleep(300);
          for (let i = 0; i < 40; i++) writeKeys("\x7f", `bs-${cand.id}`);
          await sleep(500);
        }
      }
      break;
    }

    case "commit": {
      // Deliverable 3 + probe 3: commit "Approve for me" inside the isolated,
      // seeded home and record the already-current dialog state.
      const opened = await openPermissions("commit");
      note({ phase: "commit-open", opened, state: menuState(text()) });
      dump("screen-10-dialog-before.txt");
      if (!opened) break;

      const winner = unescape(flag("--commit-keys", "2\\x1b[13u"));
      const winnerSplit = argv.includes("--commit-split");
      if (winnerSplit) {
        writeKeys(winner.slice(0, 1), "commit#0");
        await sleep(250);
        writeKeys(winner.slice(1), "commit#1");
      } else {
        writeKeys(winner, "commit");
      }
      const done = await waitFor((t) => /Permissions updated/i.test(t), 10_000);
      await sleep(settle);
      const confirm = dump("screen-11-committed.txt");
      note({
        phase: "commit",
        keys: printable(enc.encode(winner)),
        split: winnerSplit,
        confirmation_line: /Permissions updated to (.*)/i.exec(confirm)?.[1]?.trim() ?? null,
        saw_confirmation: done,
      });

      // Read the posture back through the shipped surface.
      writeKeys("/status\x1b[13u", "status");
      await waitFor((t) => t.includes('Permissions:'), 15_000);
      await sleep(settle);
      const status = dump("screen-12-status.txt");
      note({
        phase: "status",
        permissions_row: /Permissions:.*/.exec(status)?.[0]?.trim() ?? null,
      });

      // Re-open the dialog: THIS is the fixture state — "2. Approve for me
      // (current)". The corpus only has "1. Ask for approval (current)".
      writeKeys("\x1b", "clear-status");
      await sleep(400);
      writeKeys("\x15", "clear-composer");
      await sleep(400);
      const reopened = await openPermissions("already-current");
      await sleep(settle);
      const fixture = dump("screen-13-approve-current.txt");
      note({
        phase: "already-current",
        reopened,
        state: menuState(fixture),
      });
      // Back out WITHOUT committing again.
      writeKeys("\x1b", "final-backout");
      await sleep(settle);
      dump("screen-14-after-backout.txt");
      break;
    }

    default:
      throw new Error(`unknown --phase: ${phase}`);
  }
}

await main();

// ── Teardown, containment verdict, artifacts ─────────────────────────────────

dump("screen-final.txt");
recording = false;
pty.kill("SIGTERM");
await sleep(400);
pty.kill("SIGKILL");
await sleep(200);

const isolatedFiles =
  codexHome && existsSync(codexHome) ? readdirSync(codexHome).sort() : [];
const isolatedConfigPath = codexHome ? join(codexHome, "config.toml") : "";
const isolatedConfig =
  isolatedConfigPath && existsSync(isolatedConfigPath)
    ? readFileSync(isolatedConfigPath, "utf8")
    : null;
if (isolatedConfig !== null) {
  writeFileSync(join(out, "isolated-config.toml"), isolatedConfig);
}
const afterFingerprint = fingerprintRealHome();
const realHomeUnchanged = realFiles.every(
  (f) => beforeFingerprint[f] === afterFingerprint[f],
);

const containment = {
  codex_home: codexHome || "(real ~/.codex)",
  isolated_home_files: isolatedFiles,
  isolated_config_written: isolatedConfig !== null,
  isolated_config_has_approvals_reviewer:
    isolatedConfig !== null && isolatedConfig.includes('approvals_reviewer'),
  isolated_config_has_granular:
    isolatedConfig !== null && isolatedConfig.includes('granular'),
  real_home_before: beforeFingerprint,
  real_home_after: afterFingerprint,
  real_home_unchanged: realHomeUnchanged,
  real_config_unchanged:
    beforeFingerprint["config.toml"] === afterFingerprint["config.toml"],
  real_auth_unchanged:
    beforeFingerprint["auth.json"] === afterFingerprint["auth.json"],
};
console.log("CONTAINMENT " + JSON.stringify(containment, null, 2));

writeFileSync(
  join(out, "meta.json"),
  JSON.stringify(
    {
      harness,
      binary_version: binaryVersion,
      recorded_at: new Date(startedAt).toISOString(),
      cols,
      rows,
      phase,
      extra_args: extraArgs,
      ready,
      notes:
        notes || `probe-codex-permissions ${phase} capture (${binaryVersion})`,
      containment,
      log,
    },
    null,
    2,
  ) + "\n",
);

rmSync(cwd, { recursive: true, force: true });
if (cleanupHome && !keepHome) cleanupHome();
else if (keepHome) console.log(`KEPT CODEX_HOME=${codexHome}`);
process.exit(0);
