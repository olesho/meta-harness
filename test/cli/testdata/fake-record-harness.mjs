#!/usr/bin/env node
// Hermetic fake harness for the screenbench-record CLI tests.
//
// Two behaviors, keyed off argv:
//   `--version`  → prints a bare-token version (env FAKE_HARNESS_VERSION, default
//                  "9.9.9") and exits 0. NO PTY, NO network — this is the branch
//                  the recorder's version probe (execFileSync) hits.
//   otherwise    → replays a JSON script (path in $FAKEHARNESS_SCRIPT) over its
//                  PTY, exactly like test/chat/fakeharness.mjs: paint frames on a
//                  delay, block until the recorder writes the expected submit
//                  bytes, echo the captured prompt where requested. This drives
//                  the genuine screen emulator + production turns adapter that the
//                  recorder polls for turn completion.
//
// The script is built in the test with the shared Builder (test/chat/
// fakeharness.ts), so its codex/claude frame vocabulary matches the real adapters.

import { readFileSync } from "node:fs";

const VERSION = process.env.FAKE_HARNESS_VERSION ?? "9.9.9";

// Version probe branch — must run before any PTY/raw-mode work.
if (process.argv.slice(2).includes("--version")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const ENV_VAR = "FAKEHARNESS_SCRIPT";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Byte accumulator over stdin that resolves once its buffer matches a RegExp.
// Raw mode means control bytes (the CSI-13u submit) arrive unbuffered; matching
// runs on a latin1 view so string index === byte index.
function readUntil(re) {
  return new Promise((resolve) => {
    const chunks = [];
    let acc = Buffer.alloc(0);
    const onData = (chunk) => {
      chunks.push(chunk);
      acc = Buffer.concat(chunks);
      const m = re.exec(acc.toString("latin1"));
      if (m) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        resolve({ buf: acc, index: m.index });
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

// Block until the parent closes the PTY and kills us.
function holdUntilClosed() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.on("data", () => {});
    process.stdin.on("end", resolve);
    process.stdin.on("close", resolve);
  });
}

async function run() {
  const path = process.env[ENV_VAR];
  if (!path) throw new Error(`${ENV_VAR} not set`);
  const sc = JSON.parse(readFileSync(path, "utf8"));

  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(true);
    } catch {
      /* best effort */
    }
  }

  let captured = "";
  for (const step of sc.steps ?? []) {
    if (step.frame) {
      const f = step.frame;
      if (f.delay_ms > 0) await sleep(f.delay_ms);
      let body = f.screen;
      if (f.echo) body = body.split("{{prompt}}").join(captured);
      body = body.split("\n").join("\r\n");
      if (!f.no_clear) body = "\x1b[2J\x1b[H" + body;
      process.stdout.write(body);
    } else if (step.wait_input) {
      const wi = step.wait_input;
      const re = new RegExp(wi.until_regex);
      const { buf, index } = await readUntil(re);
      if (wi.capture) captured = buf.subarray(0, index).toString("utf8");
    } else if (step.hold) {
      await holdUntilClosed();
      return;
    } else if (step.exit) {
      process.exit(step.exit.code);
    }
  }
  await holdUntilClosed();
}

run().catch((err) => {
  process.stderr.write(`fake-record-harness: ${err?.stack ?? err}\n`);
  process.exit(1);
});
