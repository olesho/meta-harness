// Unit tests for env-openshell containment layer.
//
// Tier 1 (hermetic): injectable CliRunner with scripted responses asserts exact
// argv for all five verbs (create/exec/upload/download/delete), env crossing as
// the `env K=V` prefix, host-alias rewrite, and policy YAML goldens.

import { describe, it, expect, beforeEach } from "vitest";
import {
  sandboxName,
  resolveGuestUrl,
  generatePolicy,
  openshell,
  type CliResult,
  type CliRunner,
} from "../src/env-openshell";
import { Context } from "../src/async";
import { compose, env } from "../src/env";
import { shQuote } from "../src/env/argv.ts";
import type {
  Containment,
  ContainmentLayer,
  ExecOpts,
  ExecResult,
  Provisioner,
  Workspace,
} from "../src/env";

describe("sandboxName", () => {
  it("generates a valid sandbox name from an agentId", () => {
    const name = sandboxName("my-agent-123");
    expect(name).toMatch(/^openshell-/);
    expect(name).toMatch(/^[a-z0-9\-]+$/);
    expect(name.length).toBeLessThanOrEqual(40);
  });

  it("is deterministic", () => {
    const agentId = "test-agent";
    expect(sandboxName(agentId)).toBe(sandboxName(agentId));
  });

  it("handles uppercase by lowercasing", () => {
    expect(sandboxName("MyAgent")).toMatch(/^openshell-myagent/);
  });

  it("strips non-alphanumeric characters", () => {
    expect(sandboxName("my/agent@123#test")).toMatch(
      /^openshell-my-agent-123-test/,
    );
  });

  it("truncates long names with a hash suffix", () => {
    const longId = "a".repeat(100);
    const name = sandboxName(longId);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toContain("-");
  });
});

describe("resolveGuestUrl", () => {
  it("leaves non-loopback URLs unchanged", () => {
    const url = "http://example.com:8080/path";
    expect(resolveGuestUrl(url, "docker")).toBe(url);
  });

  it("rewrites docker loopback to host.docker.internal", () => {
    const url = "http://127.0.0.1:53343";
    const result = resolveGuestUrl(url, "docker");
    expect(result).toBe("http://host.docker.internal:53343");
  });

  it("rewrites podman loopback to host.containers.internal", () => {
    const url = "http://127.0.0.1:8000";
    const result = resolveGuestUrl(url, "podman");
    expect(result).toBe("http://host.containers.internal:8000");
  });

  it("respects guest override", () => {
    const url = "http://127.0.0.1:8080";
    const result = resolveGuestUrl(url, "docker", "http://myhost:9000");
    expect(result).toBe("http://myhost:9000");
  });

  it("throws on localhost with unsupported driver", () => {
    const url = "http://localhost:8080";
    expect(() => resolveGuestUrl(url, "k8s")).toThrow();
  });

  it("throws on invalid URL", () => {
    expect(() => resolveGuestUrl("not a url", "docker")).toThrow();
  });
});

describe("generatePolicy", () => {
  it("generates valid YAML for untrusted tier", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toContain("version: 1");
    expect(yaml).toContain("read_only:");
    expect(yaml).toContain("/usr");
    expect(yaml).toContain("/lib64");
    expect(yaml).toContain("enforcement: enforce");
  });

  it("generates untrusted tier golden YAML", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      modelPort: 443,
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toMatchSnapshot();
  });

  it("generates valid YAML for semi-trusted tier", () => {
    const yaml = generatePolicy({
      tier: "semi-trusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toContain("read_only:");
    expect(yaml).toContain("/usr");
    expect(yaml).not.toContain("/lib64");
    expect(yaml).toContain("enforcement: enforce");
  });

  it("generates semi-trusted tier golden YAML", () => {
    const yaml = generatePolicy({
      tier: "semi-trusted",
      modelHost: "api.anthropic.com",
      modelPort: 443,
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toMatchSnapshot();
  });

  it("generates valid YAML for trusted-internal tier", () => {
    const yaml = generatePolicy({
      tier: "trusted-internal",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toContain("read_only:");
    expect(yaml).toContain("/usr");
    expect(yaml).toContain("enforcement: observe");
  });

  it("generates trusted-internal tier golden YAML", () => {
    const yaml = generatePolicy({
      tier: "trusted-internal",
      modelHost: "api.anthropic.com",
      modelPort: 443,
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toMatchSnapshot();
  });

  it("includes model and fleet endpoints", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      modelPort: 443,
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toContain("api.anthropic.com");
    expect(yaml).toContain("localhost");
    expect(yaml).toContain("53343");
  });

  it("defaults model port to 443", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).toContain("port: 443");
  });

  it("uses custom harness path in fleet policy", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/opt/meta-harness/run",
    });
    expect(yaml).toContain("/opt/meta-harness/run");
  });

  it("emits NO scrape lane when scrapeEndpoints is absent (additive)", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    });
    expect(yaml).not.toContain("scrape");
  });

  it("emits a bare scrape lane bound to its binaries", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
      scrapeEndpoints: [
        {
          host: "news.ycombinator.com",
          binaries: ["/sandbox/.cache/camoufox/camoufox-bin"],
        },
      ],
    });
    expect(yaml).toContain("  scrape_0:");
    expect(yaml).toContain(
      "endpoints: [{ host: news.ycombinator.com, port: 443 }]",
    );
    expect(yaml).toContain(
      "binaries: [{ path: /sandbox/.cache/camoufox/camoufox-bin }]",
    );
    // Bare endpoint — a `tls: terminate` shape 403s the CONNECT (field-tested).
    expect(yaml).not.toContain("tls: terminate");
  });

  it("gives each scrape endpoint its own lane and honors custom ports", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
      scrapeEndpoints: [
        { host: "a.example", port: 8443, binaries: ["/bin/curl"] },
        { host: "b.example", binaries: ["/bin/wget", "/bin/curl"] },
      ],
    });
    expect(yaml).toContain("  scrape_0:");
    expect(yaml).toContain("{ host: a.example, port: 8443 }");
    expect(yaml).toContain("  scrape_1:");
    expect(yaml).toContain("{ host: b.example, port: 443 }");
    expect(yaml).toContain(
      "binaries: [{ path: /bin/wget }, { path: /bin/curl }]",
    );
  });

  it("generates scrape-lane golden YAML", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      modelPort: 443,
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
      scrapeEndpoints: [
        {
          host: "news.ycombinator.com",
          binaries: [
            "/sandbox/.cache/camoufox/camoufox-bin",
            "/sandbox/.venv/bin/python3.14",
          ],
        },
      ],
    });
    expect(yaml).toMatchSnapshot();
  });

  it("throws on unknown tier", () => {
    expect(() =>
      generatePolicy({
        tier: "unknown",
        modelHost: "api.anthropic.com",
        fleetHost: "localhost",
        fleetPort: 53343,
        harnessPath: "/usr/local/bin/harness-wrapper",
      }),
    ).toThrow();
  });
});

describe("OpenShellContainment", () => {
  let cli: CliRunner;
  let calls: { argv: string[] }[];
  let mockWorkspace: Workspace;

  beforeEach(() => {
    calls = [];
    mockWorkspace = {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      upload: async () => {},
      download: async () => {},
      guestPath: () => "/sandbox/repo",
      hostAlias: (url: string) => url,
      destroy: async () => {},
    };
    cli = (argv: string[]) => {
      calls.push({ argv });
      // Simulate successful responses for preflight checks
      if (argv[1] === "status") {
        return { code: 0, stdout: "Status: Connected", stderr: "" };
      }
      if (argv[1] === "provider" && argv[2] === "get") {
        return { code: 0, stdout: "Provider found", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
  });

  describe("preflight", () => {
    it("checks gateway connectivity", async () => {
      const ctx = Context.background();
      const containment = openshell({ cli });
      await containment.preflight(ctx, mockWorkspace);
      expect(calls.some((c) => c.argv[1] === "status")).toBe(true);
    });

    it("checks provider registration", async () => {
      const ctx = Context.background();
      const containment = openshell({ cli });
      await containment.preflight(ctx, mockWorkspace);
      expect(
        calls.some((c) => c.argv[1] === "provider" && c.argv[2] === "get"),
      ).toBe(true);
    });

    it("throws when gateway is disconnected", async () => {
      const ctx = Context.background();
      cli = () => ({ code: 0, stdout: "Status: Disconnected", stderr: "" });
      const containment = openshell({ cli });
      await expect(containment.preflight(ctx, mockWorkspace)).rejects.toThrow(
        /not Connected/,
      );
    });

    it("throws when provider is not registered", async () => {
      const ctx = Context.background();
      cli = (argv: string[]) => {
        if (argv[1] === "status") {
          return { code: 0, stdout: "Status: Connected", stderr: "" };
        }
        if (argv[1] === "provider") {
          return { code: 1, stdout: "", stderr: "Provider not found" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const containment = openshell({ cli });
      await expect(containment.preflight(ctx, mockWorkspace)).rejects.toThrow(
        /not registered/,
      );
    });
  });

  // Unit-test seam: name the (pretend already-created) sandbox explicitly.
  const SB = { sandboxName: "openshell-test-sb" };

  describe("layer", () => {
    it("throws without a sandboxName (production must use acquire)", () => {
      const containment = openshell({ cli });
      expect(() => containment.layer({})).toThrow(/acquire/);
    });

    it("generates a ContainmentLayer", () => {
      const containment = openshell({ cli });
      const layer = containment.layer({ ...SB, tier: "untrusted" });
      expect(layer).toBeDefined();
      expect(layer.execWrap).toBeDefined();
      expect(layer.crossUpload).toBeDefined();
      expect(layer.crossDownload).toBeDefined();
      expect(layer.pathMap).toBeDefined();
      expect(layer.teardown).toBeDefined();
      expect(layer.aliasMap).toBeDefined();
    });

    describe("execWrap", () => {
      it("wraps argv with openshell sandbox exec prefix and the real name", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const [wrapped] = layer.execWrap(["echo", "hello"], {});
        expect(wrapped).toEqual([
          "openshell",
          "sandbox",
          "exec",
          "-n",
          "openshell-test-sb",
          "--no-tty",
          "--workdir",
          "/sandbox/repo",
          "--",
          "echo",
          "hello",
        ]);
      });

      it("includes --no-tty flag", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const [wrapped] = layer.execWrap(["test"], {});
        expect(wrapped).toContain("--no-tty");
      });

      it("defaults workdir to the guest repo path", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const [wrapped] = layer.execWrap(["test"], {});
        const i = wrapped.indexOf("--workdir");
        expect(i).toBeGreaterThan(-1);
        expect(wrapped[i + 1]).toBe("/sandbox/repo");
      });

      it("consumes opts.cwd into --workdir (no host cwd leak)", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const [wrapped, rest] = layer.execWrap(["test"], {
          cwd: "/sandbox/repo/sub",
        });
        const i = wrapped.indexOf("--workdir");
        expect(wrapped[i + 1]).toBe("/sandbox/repo/sub");
        expect(rest.cwd).toBeUndefined();
      });

      it("emits no bare `env` token when env is empty", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        for (const opts of [{}, { env: {} }]) {
          const [wrapped] = layer.execWrap(["echo", "hi"], opts);
          expect(wrapped).not.toContain("env");
          expect(wrapped[wrapped.indexOf("--") + 1]).toBe("echo");
        }
      });

      it("crosses env as an in-guest `env K=V` prefix and strips it from opts", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const [wrapped, rest] = layer.execWrap(["printenv", "FOO"], {
          env: { FOO: "bar baz" },
        });
        const sep = wrapped.indexOf("--");
        expect(wrapped.slice(sep + 1)).toEqual([
          "env",
          "FOO=bar baz",
          "printenv",
          "FOO",
        ]);
        expect(rest.env).toBeUndefined();
      });

      it("passes stdin through unchanged", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const [, rest] = layer.execWrap(["cat"], { stdin: "hello\n" });
        expect(rest.stdin).toBe("hello\n");
      });
    });

    describe("crossUpload", () => {
      // `openshell sandbox upload` always nests the tree at DEST/<basename(SRC)>
      // (field-tested, 0.0.53), so the layer uploads into guest /tmp and moves
      // into place in-guest, chained through a single host `sh -c`.
      it("uploads into guest /tmp then moves into place, with the real name", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const argv = layer.crossUpload(
          "/host/tmp/env-stage-1-tree",
          "/sandbox/repo/tree",
        );
        expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
        const script = argv[2];
        expect(script).toContain(
          "'openshell' 'sandbox' 'upload' '--no-git-ignore' 'openshell-test-sb' " +
            "'/host/tmp/env-stage-1-tree' '/tmp'",
        );
        expect(script).toContain(
          "'openshell' 'sandbox' 'exec' '-n' 'openshell-test-sb' '--no-tty' '--' 'sh' '-c'",
        );
        // The in-guest move rides as ONE shQuote'd token: mkdir parent, clear
        // the target, move the nested upload into place.
        expect(script).toContain(
          "'mkdir -p '\\''/sandbox/repo'\\'' && rm -rf '\\''/sandbox/repo/tree'\\'' && " +
            "mv '\\''/tmp/env-stage-1-tree'\\'' '\\''/sandbox/repo/tree'\\'''",
        );
      });

      it("quotes hostile guest paths so they cannot break out of the script", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const hostile = "/sandbox/repo/a b; rm -rf $HOME";
        const argv = layer.crossUpload("/host/tmp/env-stage-2-x", hostile);
        expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
        // The in-guest move must be built with strict shQuote at BOTH layers:
        // hostile path quoted inside the move script, the whole move re-quoted
        // as one token of the outer host command.
        const move =
          `mkdir -p ${shQuote("/sandbox/repo")} && ` +
          `rm -rf ${shQuote(hostile)} && ` +
          `mv ${shQuote("/tmp/env-stage-2-x")} ${shQuote(hostile)}`;
        expect(argv[2]).toContain(shQuote(move));
      });
    });

    describe("crossDownload", () => {
      it("generates download argv with the real name", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const argv = layer.crossDownload("/sandbox/out", "/tmp/out");
        expect(argv).toEqual([
          "openshell",
          "sandbox",
          "download",
          "openshell-test-sb",
          "/sandbox/out",
          "/tmp/out",
        ]);
      });
    });

    describe("pathMap", () => {
      it("maps repo path", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        expect(layer.pathMap("repo")).toBe("/sandbox/repo");
      });

      it("repo path follows the guestPath option", () => {
        const containment = openshell({ cli, guestPath: "/sandbox/work" });
        const layer = containment.layer(SB);
        expect(layer.pathMap("repo")).toBe("/sandbox/work");
        const [wrapped] = layer.execWrap(["test"], {});
        expect(wrapped[wrapped.indexOf("--workdir") + 1]).toBe("/sandbox/work");
      });

      it("maps home path", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        expect(layer.pathMap("home")).toBe("/sandbox/.home");
      });

      it("maps tmp path", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        expect(layer.pathMap("tmp")).toBe("/tmp");
      });
    });

    describe("teardown", () => {
      it("generates delete argv with the real name", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        expect(layer.teardown()).toEqual([
          "openshell",
          "sandbox",
          "delete",
          "openshell-test-sb",
        ]);
      });

      it("is idempotent: second call returns [] (real CLI errors on redundant delete)", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        expect(layer.teardown().length).toBeGreaterThan(0);
        expect(layer.teardown()).toEqual([]);
      });
    });

    describe("aliasMap", () => {
      it("rewrites loopback URLs for guest", () => {
        const containment = openshell({ driver: "docker", cli });
        const layer = containment.layer(SB);
        const result = layer.aliasMap?.("http://127.0.0.1:8080");
        expect(result).toBe("http://host.docker.internal:8080");
      });

      it("leaves non-loopback URLs unchanged", () => {
        const containment = openshell({ cli });
        const layer = containment.layer(SB);
        const url = "http://example.com:8080";
        expect(layer.aliasMap?.(url)).toBe(url);
      });
    });
  });

  describe("hostile input", () => {
    it("handles argv with quotes", () => {
      const containment = openshell({ cli });
      const layer = containment.layer(SB);
      const [wrapped] = layer.execWrap(['"quoted"'], {});
      expect(wrapped).toContain('"quoted"');
    });

    it("handles argv with newlines", () => {
      const containment = openshell({ cli });
      const layer = containment.layer(SB);
      const [wrapped] = layer.execWrap(["echo\nmalicious"], {});
      expect(wrapped).toContain("echo\nmalicious");
    });

    it("handles argv with leading dashes", () => {
      const containment = openshell({ cli });
      const layer = containment.layer(SB);
      const [wrapped] = layer.execWrap(["--flag"], {});
      expect(wrapped).toContain("--flag");
    });

    it("handles empty argv", () => {
      const containment = openshell({ cli });
      const layer = containment.layer(SB);
      const [wrapped] = layer.execWrap([], {});
      expect(wrapped.length).toBeGreaterThan(0);
    });

    it("handles argv with spaces", () => {
      const containment = openshell({ cli });
      const layer = containment.layer(SB);
      const [wrapped] = layer.execWrap(["arg with spaces"], {});
      expect(wrapped).toContain("arg with spaces");
    });
  });

  describe("acquire", () => {
    const ctx = Context.background();

    /** Mock inner Workspace recording every exec's (argv, opts); scriptable
     *  per-argv results. */
    function recordingWorkspace(
      script?: (argv: string[]) => ExecResult | undefined,
    ) {
      const calls: { argv: string[]; opts?: ExecOpts }[] = [];
      const ws: Workspace = {
        exec: async (_c, argv, opts) => {
          calls.push({ argv, opts });
          return script?.(argv) ?? { code: 0, stdout: "", stderr: "" };
        },
        upload: async () => {},
        download: async () => {},
        guestPath: (kind) => `/host/${kind}`,
        hostAlias: (url) => url,
        destroy: async () => {},
      };
      return { ws, calls };
    }

    it("runs recovery-delete, create, mkdir in order (no --from/--policy by default)", async () => {
      const { ws, calls } = recordingWorkspace();
      const containment = openshell({ cli, agentId: "acq-test" });
      const name = sandboxName("acq-test");
      const layer = await containment.acquire!(ctx, ws, {});

      expect(calls.map((c) => c.argv)).toEqual([
        ["openshell", "sandbox", "delete", name],
        // `-- true`: an initial command makes create exit instead of attaching
        // an interactive shell; the sandbox is kept alive (no --no-keep).
        [
          "openshell",
          "sandbox",
          "create",
          "--name",
          name,
          "--no-tty",
          "--",
          "true",
        ],
        [
          "openshell",
          "sandbox",
          "exec",
          "-n",
          name,
          "--no-tty",
          "--",
          "mkdir",
          "-p",
          "/sandbox/repo",
          "/sandbox/.home",
        ],
      ]);
      // Returned layer is closed over the real name.
      const [wrapped] = layer.execWrap(["true"], {});
      expect(wrapped).toContain(name);
    });

    it("passes --from when the containment was built with one", async () => {
      const { ws, calls } = recordingWorkspace();
      const containment = openshell({
        cli,
        agentId: "acq-from",
        from: "node:22-slim",
      });
      await containment.acquire!(ctx, ws, {});
      const create = calls.find((c) => c.argv[2] === "create")!;
      expect(create.argv).toEqual([
        "openshell",
        "sandbox",
        "create",
        "--name",
        sandboxName("acq-from"),
        "--from",
        "node:22-slim",
        "--no-tty",
        "--",
        "true",
      ]);
    });

    it("stages a policy file and passes --policy when policy.tier is set", async () => {
      const { ws, calls } = recordingWorkspace();
      const containment = openshell({ cli, agentId: "acq-pol" });
      await containment.acquire!(ctx, ws, { tier: "untrusted" });
      const name = sandboxName("acq-pol");
      const path = `/host/tmp/openshell-policy-${name}.yaml`;

      const staged = calls.find((c) => c.argv[0] === "sh")!;
      expect(staged.argv).toEqual(["sh", "-c", `cat > '${path}'`]);
      expect(staged.opts?.stdin).toContain("version: 1");
      expect(staged.opts?.stdin).toContain("enforcement: enforce");

      const create = calls.find((c) => c.argv[2] === "create")!;
      expect(create.argv.join(" ")).toContain(`--policy ${path}`);
    });

    it("derives the name from policy.agentId over opts.agentId", async () => {
      const { ws, calls } = recordingWorkspace();
      const containment = openshell({ cli, agentId: "from-opts" });
      await containment.acquire!(ctx, ws, { agentId: "from-policy" });
      const create = calls.find((c) => c.argv[2] === "create")!;
      expect(create.argv).toContain(sandboxName("from-policy"));
    });

    it("throws when neither policy.agentId nor opts.agentId is set", async () => {
      const { ws, calls } = recordingWorkspace();
      const containment = openshell({ cli });
      await expect(containment.acquire!(ctx, ws, {})).rejects.toThrow(
        /agentId/,
      );
      expect(calls).toEqual([]); // nothing acquired
    });

    it("throws with stderr when create fails", async () => {
      const { ws } = recordingWorkspace((argv) =>
        argv[2] === "create"
          ? { code: 1, stdout: "", stderr: "no such image" }
          : undefined,
      );
      const containment = openshell({ cli, agentId: "acq-fail" });
      await expect(containment.acquire!(ctx, ws, {})).rejects.toThrow(
        /no such image/,
      );
    });

    it("best-effort deletes the sandbox when mkdir prep fails (no leak)", async () => {
      const { ws, calls } = recordingWorkspace((argv) =>
        argv.includes("mkdir")
          ? { code: 1, stdout: "", stderr: "mkdir denied" }
          : undefined,
      );
      const containment = openshell({ cli, agentId: "acq-mkdir" });
      await expect(containment.acquire!(ctx, ws, {})).rejects.toThrow(
        /mkdir denied/,
      );
      const name = sandboxName("acq-mkdir");
      expect(calls[calls.length - 1].argv).toEqual([
        "openshell",
        "sandbox",
        "delete",
        name,
      ]);
    });

    it("acquire-derived layer through compose(): double-destroy is a no-op", async () => {
      // Mirrors conformance.ts "destroy: idempotent" through the same code path
      // (compose's unconditional layer.teardown()), hermetically.
      const deletes: string[][] = [];
      const { ws } = recordingWorkspace((argv) => {
        if (argv[2] === "delete") deletes.push(argv);
        return undefined;
      });
      const containment = openshell({ cli, agentId: "acq-idem" });
      const layer = await containment.acquire!(ctx, ws, {});
      deletes.length = 0; // ignore the crash-recovery delete

      const composed = compose(ws, layer);
      await composed.destroy(ctx, "success");
      await expect(composed.destroy(ctx, "success")).resolves.toBeUndefined();
      expect(deletes).toEqual([
        ["openshell", "sandbox", "delete", sandboxName("acq-idem")],
      ]);
    });

    it("env() prefers acquire over layer when both are present", async () => {
      const { ws } = recordingWorkspace();
      const prov: Provisioner = {
        name: () => "fake",
        preflight: async () => {},
        create: async () => ws,
      };
      const identity: ContainmentLayer = {
        execWrap: (argv, opts) => [argv, opts],
        crossUpload: () => [],
        crossDownload: () => [],
        pathMap: () => "",
        teardown: () => [],
      };
      let acquired = 0;
      let layered = 0;
      const contain: Containment = {
        name: () => "fake",
        preflight: async () => {},
        layer: () => {
          layered++;
          return identity;
        },
        acquire: async () => {
          acquired++;
          return identity;
        },
      };
      const environment = await env(ctx, {
        provision: prov,
        contain,
        spec: { image: "img", name: "acq-env-pref" },
      });
      expect(acquired).toBe(1);
      expect(layered).toBe(0);
      await environment.destroy(ctx);
    });
  });
});
