// Shared helpers for translating per-harness CLI args (effort, model).

/** Normalize a harness name for switch matching ("claude-code" → matches "claude"). */
export function normHarness(h: string): string {
  return (h ?? "").trim().toLowerCase();
}

export function prependArgs(args: string[], ...prefix: string[]): string[] {
  return [...prefix, ...args];
}

export function argsContainFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function configArgHasKey(arg: string, key: string): boolean {
  const a = arg.trim();
  return a === key || a.startsWith(key + "=");
}

export function argsContainConfigKey(args: string[], key: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--config") {
      if (i + 1 < args.length && configArgHasKey(args[i + 1], key)) return true;
      continue;
    }
    if (
      arg.startsWith("-c") &&
      arg.length > 2 &&
      configArgHasKey(arg.slice(2), key)
    ) {
      return true;
    }
    if (
      arg.startsWith("--config=") &&
      configArgHasKey(arg.slice("--config=".length), key)
    ) {
      return true;
    }
  }
  return false;
}
