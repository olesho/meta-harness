import { describe, expect, test } from "vitest";
import {
  argsContainAnyFlag,
  configKeyValue,
  flagValue,
} from "../../src/wrapper/internal/harnessargs.ts";

describe("argsContainAnyFlag", () => {
  const cases: {
    name: string;
    args: string[];
    flags: string[];
    want: boolean;
  }[] = [
    {
      name: "bare token",
      args: ["-s", "read-only"],
      flags: ["-s"],
      want: true,
    },
    {
      name: "attached long form",
      args: ["--sandbox=read-only"],
      flags: ["-s", "--sandbox"],
      want: true,
    },
    {
      name: "clap attached short form",
      args: ["-sread-only"],
      flags: ["-s"],
      want: true,
    },
    {
      name: "one-sided prefix match on a single-dash token (documented caveat)",
      args: ["-auto-something"],
      flags: ["-a"],
      want: true,
    },
    {
      name: "long flag never prefix-matches",
      args: ["--sandboxed"],
      flags: ["--sandbox"],
      want: false,
    },
    { name: "absent", args: ["exec"], flags: ["-s", "--sandbox"], want: false },
    { name: "empty flag list", args: ["-s"], flags: [], want: false },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(argsContainAnyFlag(tc.args, tc.flags)).toBe(tc.want);
    });
  }
});

describe("flagValue", () => {
  const cases: {
    name: string;
    args: string[];
    flags: string[];
    want: [string, boolean];
  }[] = [
    {
      name: "separated form",
      args: ["-s", "read-only"],
      flags: ["-s", "--sandbox"],
      want: ["read-only", true],
    },
    {
      name: "attached long form",
      args: ["--sandbox=workspace-write"],
      flags: ["-s", "--sandbox"],
      want: ["workspace-write", true],
    },
    {
      name: "attached short form",
      args: ["-sread-only"],
      flags: ["-s", "--sandbox"],
      want: ["read-only", true],
    },
    {
      name: "short flag with = is read as the attached long form",
      args: ["-s=danger-full-access"],
      flags: ["-s"],
      want: ["danger-full-access", true],
    },
    {
      name: "LAST occurrence wins",
      args: ["-s", "read-only", "--sandbox=danger-full-access"],
      flags: ["-s", "--sandbox"],
      want: ["danger-full-access", true],
    },
    {
      name: "trailing flag is present but unreadable",
      args: ["exec", "-s"],
      flags: ["-s"],
      want: ["", true],
    },
    {
      name: "absent",
      args: ["exec"],
      flags: ["-s", "--sandbox"],
      want: ["", false],
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(flagValue(tc.args, ...tc.flags)).toEqual(tc.want);
    });
  }
});

describe("configKeyValue", () => {
  const cases: {
    name: string;
    args: string[];
    key: string;
    want: [string, boolean];
  }[] = [
    {
      name: "-c k=v",
      args: ["-c", "sandbox_mode=read-only"],
      key: "sandbox_mode",
      want: ["read-only", true],
    },
    {
      name: "-ck=v",
      args: ["-csandbox_mode=read-only"],
      key: "sandbox_mode",
      want: ["read-only", true],
    },
    {
      name: "--config k=v",
      args: ["--config", "sandbox_mode=read-only"],
      key: "sandbox_mode",
      want: ["read-only", true],
    },
    {
      name: "--config=k=v",
      args: ["--config=sandbox_mode=read-only"],
      key: "sandbox_mode",
      want: ["read-only", true],
    },
    {
      name: "double quotes stripped (the emitted form)",
      args: ["-c", 'sandbox_mode="danger-full-access"'],
      key: "sandbox_mode",
      want: ["danger-full-access", true],
    },
    {
      name: "single quotes stripped",
      args: ["-c", "sandbox_mode='danger-full-access'"],
      key: "sandbox_mode",
      want: ["danger-full-access", true],
    },
    {
      name: "only ONE matched pair is stripped",
      args: ["-c", 'sandbox_mode=""x""'],
      key: "sandbox_mode",
      want: ['"x"', true],
    },
    {
      name: "mismatched quotes left alone",
      args: ["-c", "sandbox_mode=\"x'"],
      key: "sandbox_mode",
      want: ["\"x'", true],
    },
    {
      name: "LAST occurrence wins",
      args: [
        "-c",
        "sandbox_mode=read-only",
        "-c",
        "sandbox_mode=danger-full-access",
      ],
      key: "sandbox_mode",
      want: ["danger-full-access", true],
    },
    {
      name: "key with no value is present with an empty value",
      args: ["-c", "sandbox_mode"],
      key: "sandbox_mode",
      want: ["", true],
    },
    {
      name: "trailing -c",
      args: ["exec", "-c"],
      key: "sandbox_mode",
      want: ["", false],
    },
    {
      name: "other keys ignored",
      args: ["-c", 'model="o3"'],
      key: "sandbox_mode",
      want: ["", false],
    },
    {
      name: "key prefix is not a match",
      args: ["-c", "sandbox_mode_extra=x"],
      key: "sandbox_mode",
      want: ["", false],
    },
  ];
  for (const tc of cases) {
    test(tc.name, () => {
      expect(configKeyValue(tc.args, tc.key)).toEqual(tc.want);
    });
  }
});
