#!/usr/bin/env node
import type { HookContext } from "../hooks/provider.ts";
export declare const EnvConfigDir = "HW_HARNESS_CONFIG_DIR";
export declare const EnvConfigDirDeprecated = "HW_CONFIG_DIR";
export declare const EnvSessionID = "HW_HARNESS_SESSION_ID";
export type Env = Record<string, string | undefined>;
export declare function contextFromEnv(env: Env): HookContext;
export declare function handleHookEvent(harnessName: string, event: string, env: Env, stdin: string): number;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=hooks.d.ts.map