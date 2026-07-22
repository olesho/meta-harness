// Per-harness model override translation (Claude Code --model, Codex
// -c model="…"). The caller picks the model (Config.model, applied by
// start() in run.ts); this only translates it to harness CLI args. An
// explicit model flag already in args wins.

import {
  argsContainConfigKey,
  argsContainFlag,
  normHarness,
  prependArgs,
} from "./harnessargs.ts";

/** Prepend a per-harness model override. Empty leaves the harness default. */
export function argsWithHarnessModel(
  harness: string,
  args: string[],
  model: string,
): string[] {
  if (model === "") return args;
  switch (normHarness(harness)) {
    case "claude":
    case "claude-code":
      if (argsContainFlag(args, "--model")) return args;
      return prependArgs(args, "--model", model);
    case "codex":
      if (argsContainConfigKey(args, "model")) return args;
      return prependArgs(args, "-c", `model="${model}"`);
    default:
      return args;
  }
}
