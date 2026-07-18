// Serialized-edit primitive: the Node/Bun-portable replacement for Go's flock
// `WithLockedFile` (pkg/harness/hookensure.go).
//
// Node and Bun ship no native flock, and a native addon (fs-ext) is rejected
// because this package runs under BOTH Node (compiled `dist`) and Bun (the
// `bun` export condition points at raw `src/**`). So we serialize with an
// O_EXCL sentinel lock — `fs.openSync(lockPath, "wx")` is atomic O_CREAT|O_EXCL
// on both runtimes — and commit mutations via a tmp-file + atomic rename, so a
// concurrent reader never observes a half-written config even between lock
// windows.

import {
  closeSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

// A lock held longer than this is presumed abandoned (crashed writer) and is
// reclaimable. Kept comfortably longer than any real edit window.
export const lockStaleTTLMs = 30_000;

// Bounded-backoff defaults for contended acquisition.
const defaultAcquireTimeoutMs = 10_000;
const retryBaseMs = 10;
const retryMaxMs = 250;

export interface LockOptions {
  // Max time to spend contending for the sentinel before giving up. Defaults to
  // defaultAcquireTimeoutMs.
  acquireTimeoutMs?: number;
  // Age past which a sentinel is treated as abandoned and reclaimed. Defaults to
  // lockStaleTTLMs.
  staleTTLMs?: number;
}

// sleepSync blocks the current thread for `ms` without a busy loop. Atomics.wait
// on a private SharedArrayBuffer is the one synchronous sleep available on both
// Node and Bun (setTimeout is async; there is no fs-level blocking primitive).
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function lockPathFor(configPath: string): string {
  return `${configPath}.lock`;
}

function tmpPathFor(configPath: string): string {
  return `${configPath}.tmp`;
}

// acquire creates the O_EXCL sentinel, retrying on EEXIST with bounded backoff.
// A sentinel older than the stale TTL is reclaimed (best-effort unlink) so a
// crashed writer cannot wedge the config forever.
function acquire(
  lockPath: string,
  timeoutMs: number,
  staleTTLMs: number,
): void {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    try {
      // "wx" == O_CREAT | O_EXCL | O_WRONLY — atomic create-or-fail.
      const fd = openSync(lockPath, "wx");
      // Record the holder's timestamp so a peer can judge staleness even if the
      // filesystem mtime is coarse.
      try {
        writeFileSync(fd, `${process.pid} ${Date.now()}\n`);
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (reclaimIfStale(lockPath, staleTTLMs)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `withLockedFile: timed out acquiring ${lockPath} after ${timeoutMs}ms`,
        );
      }
      const backoff = Math.min(retryBaseMs * 2 ** attempt, retryMaxMs);
      attempt++;
      sleepSync(backoff);
    }
  }
}

// reclaimIfStale unlinks the sentinel when its age exceeds the stale TTL.
// Returns true if a reclaim was attempted (caller should retry immediately).
function reclaimIfStale(lockPath: string, staleTTLMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch (err) {
    // Vanished between EEXIST and stat — the holder released; retry now.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw err;
  }
  if (ageMs < staleTTLMs) return false;
  try {
    unlinkSync(lockPath);
  } catch (err) {
    // Another peer already reclaimed it; that is fine — just retry.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return true;
}

function release(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

// withLockedFile runs `fn` while holding the O_EXCL sentinel for `configPath`,
// releasing it in a `finally`. Use atomicWriteFileSync inside `fn` to commit.
export function withLockedFile<T>(
  configPath: string,
  fn: () => T,
  opts: LockOptions = {},
): T {
  const lockPath = lockPathFor(configPath);
  acquire(
    lockPath,
    opts.acquireTimeoutMs ?? defaultAcquireTimeoutMs,
    opts.staleTTLMs ?? lockStaleTTLMs,
  );
  try {
    return fn();
  } finally {
    release(lockPath);
  }
}

// atomicWriteFileSync writes `data` to `<configPath>.tmp` then renames it over
// the target. rename(2) is atomic within a filesystem, so a reader either sees
// the old file or the new one — never a truncated write. Call only while
// holding the lock (the shared `.tmp` name is safe under serialization).
export function atomicWriteFileSync(
  configPath: string,
  data: string,
  mode = 0o600,
): void {
  const tmp = tmpPathFor(configPath);
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, configPath);
}
