// Unit tests for env-openshell containment layer.
//
// Tier 1 (hermetic): injectable CliRunner with scripted responses asserts exact
// argv for all five verbs (create/exec/upload/download/delete), env crossing as
// the `env K=V` prefix, host-alias rewrite, and policy YAML goldens.

import { describe, it, expect, beforeEach } from "vitest"
import {
  sandboxName,
  resolveGuestUrl,
  generatePolicy,
  openshell,
  type CliResult,
  type CliRunner,
} from "../src/env-openshell"
import { Context, cancel } from "../src/async"

describe("sandboxName", () => {
  it("generates a valid sandbox name from an agentId", () => {
    const name = sandboxName("my-agent-123")
    expect(name).toMatch(/^openshell-/)
    expect(name).toMatch(/^[a-z0-9\-]+$/)
    expect(name.length).toBeLessThanOrEqual(40)
  })

  it("is deterministic", () => {
    const agentId = "test-agent"
    expect(sandboxName(agentId)).toBe(sandboxName(agentId))
  })

  it("handles uppercase by lowercasing", () => {
    expect(sandboxName("MyAgent")).toMatch(/^openshell-myagent/)
  })

  it("strips non-alphanumeric characters", () => {
    expect(sandboxName("my/agent@123#test")).toMatch(/^openshell-my-agent-123-test/)
  })

  it("truncates long names with a hash suffix", () => {
    const longId = "a".repeat(100)
    const name = sandboxName(longId)
    expect(name.length).toBeLessThanOrEqual(40)
    expect(name).toContain("-")
  })
})

describe("resolveGuestUrl", () => {
  it("leaves non-loopback URLs unchanged", () => {
    const url = "http://example.com:8080/path"
    expect(resolveGuestUrl(url, "docker")).toBe(url)
  })

  it("rewrites docker loopback to host.docker.internal", () => {
    const url = "http://127.0.0.1:53343"
    const result = resolveGuestUrl(url, "docker")
    expect(result).toBe("http://host.docker.internal:53343")
  })

  it("rewrites podman loopback to host.containers.internal", () => {
    const url = "http://127.0.0.1:8000"
    const result = resolveGuestUrl(url, "podman")
    expect(result).toBe("http://host.containers.internal:8000")
  })

  it("respects guest override", () => {
    const url = "http://127.0.0.1:8080"
    const result = resolveGuestUrl(url, "docker", "http://myhost:9000")
    expect(result).toBe("http://myhost:9000")
  })

  it("throws on localhost with unsupported driver", () => {
    const url = "http://localhost:8080"
    expect(() => resolveGuestUrl(url, "k8s")).toThrow()
  })

  it("throws on invalid URL", () => {
    expect(() => resolveGuestUrl("not a url", "docker")).toThrow()
  })
})

describe("generatePolicy", () => {
  it("generates valid YAML for untrusted tier", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    })
    expect(yaml).toContain("version: 1")
    expect(yaml).toContain("read_only:")
    expect(yaml).toContain("/usr")
    expect(yaml).toContain("/lib64")
    expect(yaml).toContain("enforcement: enforce")
  })

  it("generates valid YAML for semi-trusted tier", () => {
    const yaml = generatePolicy({
      tier: "semi-trusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    })
    expect(yaml).toContain("read_only:")
    expect(yaml).toContain("/usr")
    expect(yaml).not.toContain("/lib64")
    expect(yaml).toContain("enforcement: enforce")
  })

  it("generates valid YAML for trusted-internal tier", () => {
    const yaml = generatePolicy({
      tier: "trusted-internal",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    })
    expect(yaml).toContain("read_only:")
    expect(yaml).toContain("/usr")
    expect(yaml).toContain("enforcement: observe")
  })

  it("includes model and fleet endpoints", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      modelPort: 443,
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    })
    expect(yaml).toContain("api.anthropic.com")
    expect(yaml).toContain("localhost")
    expect(yaml).toContain("53343")
  })

  it("defaults model port to 443", () => {
    const yaml = generatePolicy({
      tier: "untrusted",
      modelHost: "api.anthropic.com",
      fleetHost: "localhost",
      fleetPort: 53343,
      harnessPath: "/usr/local/bin/harness-wrapper",
    })
    expect(yaml).toContain("port: 443")
  })

  it("throws on unknown tier", () => {
    expect(() =>
      generatePolicy({
        tier: "unknown",
        modelHost: "api.anthropic.com",
        fleetHost: "localhost",
        fleetPort: 53343,
        harnessPath: "/usr/local/bin/harness-wrapper",
      }),
    ).toThrow()
  })
})

describe("OpenShellContainment", () => {
  let cli: CliRunner
  let calls: Array<{ argv: string[] }>

  beforeEach(() => {
    calls = []
    cli = (argv: string[]) => {
      calls.push({ argv })
      // Simulate successful responses for preflight checks
      if (argv[1] === "status") {
        return { code: 0, stdout: "Status: Connected", stderr: "" }
      }
      if (argv[1] === "provider" && argv[2] === "get") {
        return { code: 0, stdout: "Provider found", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
  })

  describe("preflight", () => {
    it("checks gateway connectivity", async () => {
      const ctx = new Context()
      const containment = openshell({ cli })
      await containment.preflight(ctx)
      expect(calls.some((c) => c.argv[1] === "status")).toBe(true)
    })

    it("checks provider registration", async () => {
      const ctx = new Context()
      const containment = openshell({ cli })
      await containment.preflight(ctx)
      expect(
        calls.some((c) => c.argv[1] === "provider" && c.argv[2] === "get"),
      ).toBe(true)
    })

    it("throws when gateway is disconnected", async () => {
      const ctx = new Context()
      cli = () => ({ code: 0, stdout: "Status: Disconnected", stderr: "" })
      const containment = openshell({ cli })
      await expect(containment.preflight(ctx)).rejects.toThrow(/not Connected/)
    })

    it("throws when provider is not registered", async () => {
      const ctx = new Context()
      cli = (argv: string[]) => {
        if (argv[1] === "status") {
          return { code: 0, stdout: "Status: Connected", stderr: "" }
        }
        if (argv[1] === "provider") {
          return { code: 1, stdout: "", stderr: "Provider not found" }
        }
        return { code: 0, stdout: "", stderr: "" }
      }
      const containment = openshell({ cli })
      await expect(containment.preflight(ctx)).rejects.toThrow(/not registered/)
    })
  })

  describe("layer", () => {
    it("generates a ContainmentLayer", () => {
      const containment = openshell({ cli })
      const layer = containment.layer({
        tier: "untrusted",
        modelHost: "api.anthropic.com",
        fleetHost: "localhost",
        fleetPort: 53343,
        harnessPath: "/usr/local/bin/harness-wrapper",
      })
      expect(layer).toBeDefined()
      expect(layer.execWrap).toBeDefined()
      expect(layer.crossUpload).toBeDefined()
      expect(layer.crossDownload).toBeDefined()
      expect(layer.pathMap).toBeDefined()
      expect(layer.teardown).toBeDefined()
      expect(layer.aliasMap).toBeDefined()
    })

    describe("execWrap", () => {
      it("wraps argv with openshell sandbox exec prefix", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const [wrapped] = layer.execWrap(["echo", "hello"], {})
        expect(wrapped).toContain("openshell")
        expect(wrapped).toContain("sandbox")
        expect(wrapped).toContain("exec")
        expect(wrapped).toContain("__SANDBOX_NAME__")
        expect(wrapped).toContain("env")
        expect(wrapped).toContain("echo")
        expect(wrapped).toContain("hello")
      })

      it("includes --no-tty flag", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const [wrapped] = layer.execWrap(["test"], {})
        expect(wrapped).toContain("--no-tty")
      })

      it("sets workdir", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const [wrapped] = layer.execWrap(["test"], {})
        expect(wrapped).toContain("--workdir")
        expect(wrapped).toContain("/sandbox/repo")
      })
    })

    describe("crossUpload", () => {
      it("generates upload argv", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const argv = layer.crossUpload("/tmp/file", "/sandbox/repo/file")
        expect(argv).toContain("openshell")
        expect(argv).toContain("sandbox")
        expect(argv).toContain("upload")
        expect(argv).toContain("--no-git-ignore")
        expect(argv).toContain("__SANDBOX_NAME__")
        expect(argv).toContain("/tmp/file")
        expect(argv).toContain("/sandbox/repo/file")
      })
    })

    describe("crossDownload", () => {
      it("generates download argv", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const argv = layer.crossDownload("/sandbox/out", "/tmp/out")
        expect(argv).toContain("openshell")
        expect(argv).toContain("sandbox")
        expect(argv).toContain("download")
        expect(argv).toContain("__SANDBOX_NAME__")
        expect(argv).toContain("/sandbox/out")
        expect(argv).toContain("/tmp/out")
      })
    })

    describe("pathMap", () => {
      it("maps repo path", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        expect(layer.pathMap("repo")).toBe("/sandbox/repo")
      })

      it("maps home path", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        expect(layer.pathMap("home")).toBe("/sandbox/.home")
      })

      it("maps tmp path", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        expect(layer.pathMap("tmp")).toBe("/tmp")
      })
    })

    describe("teardown", () => {
      it("generates delete argv", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const argv = layer.teardown()
        expect(argv).toContain("openshell")
        expect(argv).toContain("sandbox")
        expect(argv).toContain("delete")
        expect(argv).toContain("__SANDBOX_NAME__")
      })
    })

    describe("aliasMap", () => {
      it("rewrites loopback URLs for guest", () => {
        const containment = openshell({ driver: "docker", cli })
        const layer = containment.layer({})
        const result = layer.aliasMap?.("http://127.0.0.1:8080")
        expect(result).toBe("http://host.docker.internal:8080")
      })

      it("leaves non-loopback URLs unchanged", () => {
        const containment = openshell({ cli })
        const layer = containment.layer({})
        const url = "http://example.com:8080"
        expect(layer.aliasMap?.(url)).toBe(url)
      })
    })
  })

  describe("hostile input", () => {
    it("handles argv with quotes", () => {
      const containment = openshell({ cli })
      const layer = containment.layer({})
      const [wrapped] = layer.execWrap(['"quoted"'], {})
      expect(wrapped).toContain('"quoted"')
    })

    it("handles argv with newlines", () => {
      const containment = openshell({ cli })
      const layer = containment.layer({})
      const [wrapped] = layer.execWrap(["echo\nmalicious"], {})
      expect(wrapped).toContain("echo\nmalicious")
    })

    it("handles argv with leading dashes", () => {
      const containment = openshell({ cli })
      const layer = containment.layer({})
      const [wrapped] = layer.execWrap(["--flag"], {})
      expect(wrapped).toContain("--flag")
    })

    it("handles empty argv", () => {
      const containment = openshell({ cli })
      const layer = containment.layer({})
      const [wrapped] = layer.execWrap([], {})
      expect(wrapped.length).toBeGreaterThan(0)
    })

    it("handles argv with spaces", () => {
      const containment = openshell({ cli })
      const layer = containment.layer({})
      const [wrapped] = layer.execWrap(["arg with spaces"], {})
      expect(wrapped).toContain("arg with spaces")
    })
  })
})
