#!/usr/bin/env node
export declare const EnvConfigDir = "HW_CONFIG_DIR";
export declare const EnvSessionID = "HW_HARNESS_SESSION_ID";
export type Env = Record<string, string | undefined>;
export declare function handleHookEvent(harnessName: string, event: string, env: Env, stdin: string): number;
export declare function main(argv: string[]): Promise<number>;
//# sourceMappingURL=hooks.d.ts.map