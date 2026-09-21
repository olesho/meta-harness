// vitest `globalSetup`: reclaim tmux sessions leaked by the suite's own
// tmux-backed tests (PUPPET-327 / PUPPET-329).
//
// test/cli/wrapper.test.ts and test/cli/tmux.test.ts create REAL detached tmux
// sessions. Their in-test `afterEach` hooks cover an assertion that throws and
// a vitest timeout, but nothing in-process can survive a SIGKILL of the runner:
// the tmux server is a daemon, so a killed run leaves its session — and the
// `--mode stuck` node tree inside it — alive forever, reparented to pid 1.
// 24 such orphans were measured on 2026-08-31, the oldest 16 days old.
//
// The run that leaks cannot clean up after itself, but the NEXT run can. That
// is why the `setup()` half matters and why a teardown-only hook would not
// bound the leak.
//
// SCOPE: `mh-ws3-` only. `mh-` is the production prefix
// (TMUX_SESSION_PREFIX, src/cli/tmux.ts) and an operator's detached
// `meta-harness-wrapper --tmux-session` run is legitimately long-lived; test
// sessions are the `ws3-cli-<pid>` / `ws3-test-<pid>` names alone. Never widen
// this prefix.

import { spawnSync } from "node:child_process";

/** The only session-name prefix this sweep is allowed to kill. */
const TEST_SESSION_PREFIX = "mh-ws3-";

/**
 * Whether the process that created a test session is still running. Test
 * session names end in the creating vitest worker's pid (`ws3-cli-<pid>`,
 * `ws3-test-<pid>`); a live pid means another run — e.g. a parallel suite in
 * a sibling worktree on the same tmux server — still owns the session, so it
 * is not a leak. EPERM means the pid exists (another user's process). A name
 * with no pid suffix is treated as orphaned.
 */
function ownerAlive(name: string): boolean {
  const m = /-(\d+)$/.exec(name);
  if (m === null) return false;
  try {
    process.kill(Number(m[1]), 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kills every tmux session named `mh-ws3-*` whose creating process has
 * exited (see ownerAlive). Fully best-effort: a missing
 * `tmux` binary or a non-zero `list-sessions` (the "no server running" case)
 * means there is nothing to sweep, never a failed test run — the tmux tests
 * themselves are already gated on `hasTmux`.
 */
export function sweepTestSessions(): number {
  const listed = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], {
    encoding: "utf8",
  });
  if (listed.error !== undefined || listed.status !== 0) {
    return 0;
  }

  const names = (listed.stdout ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(TEST_SESSION_PREFIX) && !ownerAlive(l));

  let killed = 0;
  for (const name of names) {
    const res = spawnSync("tmux", ["kill-session", "-t", name], {
      stdio: "ignore",
    });
    if (res.error === undefined && res.status === 0) {
      killed += 1;
    }
  }
  if (killed > 0) {
    // Surface the leak in gate output instead of cleaning it up silently.
    console.log(
      `[tmux-sweep] killed ${String(killed)} leaked test session(s) matching ${TEST_SESSION_PREFIX}*`,
    );
  }
  return killed;
}

export function setup(): void {
  sweepTestSessions();
}

export function teardown(): void {
  sweepTestSessions();
}
