// Shared test doubles for the env-layer suites.

import type { Context } from "../../src/async/index.ts";
import type {
  Capability,
  ContainmentLayer,
  CredentialInjector,
  ExecOpts,
  ExecResult,
  Redactor,
  Workspace,
} from "../../src/env/index.ts";

/** A Redactor that records every registered secret in acquisition order, and a
 *  monotonically-increasing tick so tests can prove redactions were registered
 *  BEFORE a given apply() call. */
export class RecordingRedactor implements Redactor {
  readonly registered: string[] = [];
  register(secret: string): void {
    this.registered.push(secret);
  }
}

/** A scriptable CredentialInjector. `apply()` can be told to fail on demand so
 *  the §4-step-5 unwind (redactions active even after a half-failed apply) is
 *  proven, not deferred. Records the order of every lifecycle call. */
export class ScriptedInjector implements CredentialInjector {
  applied = false;
  cleaned = 0;
  applyCalledAfterRedactions?: string[];
  constructor(
    readonly opts: {
      id: string;
      secrets?: string[];
      caps?: Capability[];
      failApply?: boolean;
      log?: string[];
      redactor?: RecordingRedactor;
    },
  ) {}

  requires(): Capability[] {
    return this.opts.caps ?? [];
  }
  redactions(): string[] {
    return this.opts.secrets ?? [];
  }
  async apply(_ctx: Context, _ws: Workspace): Promise<void> {
    // Snapshot what the redactor already holds — proves redactions ran first.
    if (this.opts.redactor)
      this.applyCalledAfterRedactions = [...this.opts.redactor.registered];
    this.opts.log?.push(`apply:${this.opts.id}`);
    if (this.opts.failApply) throw new Error(`apply failed: ${this.opts.id}`);
    this.applied = true;
  }
  async cleanup(_ctx: Context, _ws: Workspace): Promise<void> {
    this.cleaned++;
    this.opts.log?.push(`cleanup:${this.opts.id}`);
  }
}

/** A minimal in-memory Workspace that records exec argv and destroy calls, used
 *  by compose() unit tests. Upload/download record their (from,to) pairs. */
export class FakeWorkspace implements Workspace {
  readonly execCalls: string[][] = [];
  readonly uploads: [string, string][] = [];
  readonly downloads: [string, string][] = [];
  destroyCount = 0;
  lastOutcome?: string;
  constructor(
    readonly opts: {
      log?: string[];
      id?: string;
      execResult?: (argv: string[]) => ExecResult;
      failDestroy?: boolean;
    } = {},
  ) {}

  async exec(
    _ctx: Context,
    argv: string[],
    _opts?: ExecOpts,
  ): Promise<ExecResult> {
    this.execCalls.push(argv);
    return this.opts.execResult?.(argv) ?? { code: 0, stdout: "", stderr: "" };
  }
  async upload(
    _ctx: Context,
    hostPath: string,
    guestPath: string,
  ): Promise<void> {
    this.uploads.push([hostPath, guestPath]);
  }
  async download(
    _ctx: Context,
    guestPath: string,
    hostPath: string,
  ): Promise<void> {
    this.downloads.push([guestPath, hostPath]);
  }
  guestPath(kind: "repo" | "home" | "tmp"): string {
    return `/inner/${kind}`;
  }
  hostAlias(hostUrl: string): string {
    return hostUrl.replace("localhost", "inner.host");
  }
  async destroy(_ctx: Context, outcome?: string): Promise<void> {
    this.destroyCount++;
    this.lastOutcome = outcome;
    this.opts.log?.push(`destroy:${this.opts.id ?? "inner"}`);
    if (this.opts.failDestroy) throw new Error("inner destroy failed");
  }
}

/** A non-identity ContainmentLayer that crosses a real boundary — exercises
 *  compose()'s staging, cross-verbs, alias folding, and teardown ordering. */
export function fakeCrossingLayer(log?: string[]): ContainmentLayer {
  return {
    execWrap(argv, opts) {
      return [["contain", "exec", "--", ...argv], opts];
    },
    crossUpload(staging, guest) {
      return ["contain", "cp-in", staging, guest];
    },
    crossDownload(guest, staging) {
      return ["contain", "cp-out", guest, staging];
    },
    pathMap(kind) {
      return `/contained/${kind}`;
    },
    teardown() {
      log?.push("teardown");
      return ["contain", "delete"];
    },
    aliasMap(url) {
      return url.replace("inner.host", "contained.host");
    },
  };
}
