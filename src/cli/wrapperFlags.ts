// CLI flag surface for `meta-harness-wrapper`.
//
// Ported from cmd/harness-wrapper/flags.go: parseHarnessWrapperArgs splits the
// args after the "harness-wrapper" subcommand at the required "--" separator,
// parses the wrapper flags + harness name from the prefix, and passes
// everything after "--" verbatim to the harness.
//
//   [wrapper-flags...] <harness-name> -- <harness args...>
//
// FLAG_DEFS is the single definition of the flag surface (mirrors Go's
// harnessWrapperFlagSet), so both the parser and the contract-freezing golden
// test (test/cli/wrapperFlags.test.ts, test/cli/testdata/wrapper-flags.golden)
// derive from the same table.

/** The parsed form of a `harness-wrapper` invocation. */
export interface HarnessWrapperArgs {
  traceFile: string;
  traceStderr: boolean;
  effort: string;
  model: string;
  /**
   * Requests the wrapper spawn the run inside a detached tmux session named
   * mh-<value> and exit immediately after `tmux new-session -d` succeeds.
   */
  tmuxSession: string;
  /** In-pane re-exec marker; set only by the tmux-spawn parent. */
  tmuxChild: string;
  harnessName: string;
  harnessArgs: string[];
}

type FlagType = "string" | "bool";

interface FlagDef {
  name: string;
  type: FlagType;
  /** Rendered default value, as Go's flag package would stringify it. */
  def: string;
  usage: string;
  /** Assigns the parsed value onto args. */
  set: (args: HarnessWrapperArgs, value: string) => void;
}

const FLAG_DEFS: readonly FlagDef[] = [
  {
    name: "trace-file",
    type: "string",
    def: "",
    usage:
      "path to write trace events as NDJSON (default: trace events are dropped)",
    set: (a, v) => {
      a.traceFile = v;
    },
  },
  {
    name: "trace-stderr",
    type: "bool",
    def: "false",
    usage:
      "write trace events as NDJSON to stderr (mutually exclusive with --trace-file)",
    set: (a, v) => {
      a.traceStderr = v === "true";
    },
  },
  {
    name: "effort",
    type: "string",
    def: "",
    usage:
      "reasoning effort for supported harnesses (low, medium, high, xhigh, max)",
    set: (a, v) => {
      a.effort = v;
    },
  },
  {
    name: "model",
    type: "string",
    def: "",
    usage: "model id for supported harnesses (claude --model, codex -c model)",
    set: (a, v) => {
      a.model = v;
    },
  },
  {
    name: "tmux-session",
    type: "string",
    def: "",
    usage:
      "spawn the run inside a detached tmux session named mh-<value> and exit immediately",
    set: (a, v) => {
      a.tmuxSession = v;
    },
  },
  {
    name: "tmux-child",
    type: "string",
    def: "",
    usage: "internal: in-pane re-exec marker; do not set manually",
    set: (a, v) => {
      a.tmuxChild = v;
    },
  },
];

const FLAG_BY_NAME = new Map(FLAG_DEFS.map((f) => [f.name, f]));

/** Renders the frozen flag surface as `--name <type> = "default" : usage` lines, sorted. */
export function renderFlagSurface(): string {
  const lines = FLAG_DEFS.map(
    (f) => `--${f.name} <${f.type}> = ${JSON.stringify(f.def)} : ${f.usage}`,
  );
  lines.sort();
  return lines.join("\n") + "\n";
}

function emptyArgs(): HarnessWrapperArgs {
  return {
    traceFile: "",
    traceStderr: false,
    effort: "",
    model: "",
    tmuxSession: "",
    tmuxChild: "",
    harnessName: "",
    harnessArgs: [],
  };
}

/**
 * Splits argv at the required "--" separator, parses wrapper flags + the
 * harness name from the prefix, and returns the harness args verbatim.
 * Mirrors Go's parseHarnessWrapperArgs (flags.go:35-71).
 */
export function parseHarnessWrapperArgs(argv: string[]): {
  result: HarnessWrapperArgs | null;
  err: Error | null;
} {
  const sep = argv.indexOf("--");
  if (sep === -1) {
    return {
      result: null,
      err: new Error(
        "harness-wrapper: missing -- separator before harness args",
      ),
    };
  }
  const pre = argv.slice(0, sep);
  const harnessArgs = argv.slice(sep + 1);

  const args = emptyArgs();
  const positional: string[] = [];

  let i = 0;
  while (i < pre.length) {
    const tok = pre[i];
    const m = /^--?([^=]+)(?:=(.*))?$/.exec(tok);
    if (!m) {
      positional.push(tok);
      i++;
      continue;
    }
    const name = m[1];
    // m[2] is the optional `=value` group: typed `string` by RegExpExecArray
    // indexing, but genuinely absent (undefined) when the flag has no inline value.
    const inline = m[2] as string | undefined;
    const def = FLAG_BY_NAME.get(name);
    if (!def) {
      return {
        result: null,
        err: new Error(
          `harness-wrapper: flag provided but not defined: -${name}`,
        ),
      };
    }
    if (def.type === "bool") {
      def.set(args, inline ?? "true");
      i++;
      continue;
    }
    if (inline !== undefined) {
      def.set(args, inline);
      i++;
      continue;
    }
    const next = pre[i + 1] as string | undefined;
    if (next === undefined) {
      return {
        result: null,
        err: new Error(`harness-wrapper: flag needs an argument: -${name}`),
      };
    }
    def.set(args, next);
    i += 2;
  }

  if (args.traceFile !== "" && args.traceStderr) {
    return {
      result: null,
      err: new Error(
        "harness-wrapper: --trace-file and --trace-stderr are mutually exclusive",
      ),
    };
  }
  if (args.tmuxSession !== "" && args.tmuxChild !== "") {
    return {
      result: null,
      err: new Error(
        "harness-wrapper: --tmux-session and --tmux-child are mutually exclusive",
      ),
    };
  }
  if (positional.length === 0) {
    return {
      result: null,
      err: new Error("harness-wrapper: missing harness name before --"),
    };
  }
  if (positional.length !== 1) {
    return {
      result: null,
      err: new Error(
        `harness-wrapper: expected exactly one harness name before --, got ${String(positional.length)} args ` +
          `(${JSON.stringify(positional)}); wrapper flags like --trace-file must come BEFORE the harness name`,
      ),
    };
  }

  args.harnessName = positional[0];
  args.harnessArgs = harnessArgs;
  return { result: args, err: null };
}
