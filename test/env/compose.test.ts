// Tier-1 / Tier-5: the compose() combinator against fake layers — the full
// §5.1 operation-mapping table, tested once.

import { describe, expect, test } from "vitest";
import { Context } from "../../src/async/index.ts";
import { compose } from "../../src/env/index.ts";
import { FakeWorkspace, fakeCrossingLayer } from "./fakes.ts";
import { none } from "../../src/env/index.ts";

const ctx = Context.background();

describe("compose — crossing layer (§5.1 table)", () => {
  test("exec is wrapped and run via inner exec", async () => {
    const inner = new FakeWorkspace();
    const ws = compose(inner, fakeCrossingLayer());
    await ws.exec(ctx, ["git", "status"]);
    expect(inner.execCalls).toEqual([
      ["contain", "exec", "--", "git", "status"],
    ]);
  });

  test("upload stages on inner then crosses the boundary via inner exec", async () => {
    const inner = new FakeWorkspace();
    const ws = compose(inner, fakeCrossingLayer());
    await ws.upload(ctx, "/host/file", "/contained/repo/file");
    expect(inner.uploads.length).toBe(1);
    const [, staging] = inner.uploads[0];
    expect(staging.startsWith("/inner/tmp/")).toBe(true);
    // The cross step moves staging → final guest path via inner exec.
    expect(inner.execCalls).toEqual([
      ["contain", "cp-in", staging, "/contained/repo/file"],
    ]);
  });

  test("download crosses out to staging then pulls staging to host", async () => {
    const inner = new FakeWorkspace();
    const ws = compose(inner, fakeCrossingLayer());
    await ws.download(ctx, "/contained/repo/out", "/host/out");
    const staging = inner.downloads[0][0];
    expect(staging.startsWith("/inner/tmp/")).toBe(true);
    expect(inner.execCalls[0]).toEqual([
      "contain",
      "cp-out",
      "/contained/repo/out",
      staging,
    ]);
  });

  test("guestPath shadows inner with containment paths", () => {
    const ws = compose(new FakeWorkspace(), fakeCrossingLayer());
    expect(ws.guestPath("repo")).toBe("/contained/repo");
  });

  test("hostAlias folds across BOTH hops", () => {
    const ws = compose(new FakeWorkspace(), fakeCrossingLayer());
    // localhost → inner.host (inner) → contained.host (layer).
    expect(ws.hostAlias("http://localhost:9")).toBe("http://contained.host:9");
  });

  test("destroy tears down containment THEN inner, in order", async () => {
    const log: string[] = [];
    const inner = new FakeWorkspace({ log, id: "inner" });
    const ws = compose(inner, fakeCrossingLayer(log));
    await ws.destroy(ctx, "success");
    // teardown argv runs via inner exec, then inner.destroy.
    expect(inner.execCalls[0]).toEqual(["contain", "delete"]);
    expect(log).toEqual(["teardown", "destroy:inner"]);
  });

  test("destroy aggregates a failing inner destroy without skipping teardown", async () => {
    const inner = new FakeWorkspace({ failDestroy: true });
    const ws = compose(inner, fakeCrossingLayer());
    await expect(ws.destroy(ctx, "success")).rejects.toThrow(/compose.destroy/);
    // teardown still ran before the inner destroy threw.
    expect(inner.execCalls[0]).toEqual(["contain", "delete"]);
  });
});

describe("compose — identity (none) layer collapses to inner", () => {
  test("exec/upload/download/paths pass straight through", async () => {
    const inner = new FakeWorkspace();
    const ws = compose(inner, none().layer({}));
    await ws.exec(ctx, ["ls"]);
    await ws.upload(ctx, "/host/f", "/inner/repo/f");
    await ws.download(ctx, "/inner/repo/f", "/host/f2");
    expect(inner.execCalls).toEqual([["ls"]]); // unwrapped
    expect(inner.uploads).toEqual([["/host/f", "/inner/repo/f"]]); // straight to guest, no staging
    expect(inner.downloads).toEqual([["/inner/repo/f", "/host/f2"]]);
    expect(ws.guestPath("repo")).toBe("/inner/repo"); // deferred to inner
  });

  test("identity destroy runs only the inner destroy", async () => {
    const log: string[] = [];
    const inner = new FakeWorkspace({ log, id: "inner" });
    const ws = compose(inner, none().layer({}));
    await ws.destroy(ctx, "success");
    expect(inner.execCalls).toEqual([]); // no teardown exec
    expect(log).toEqual(["destroy:inner"]);
  });
});
