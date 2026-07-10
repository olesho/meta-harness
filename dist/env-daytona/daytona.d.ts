import type { Provisioner } from "../env/types.ts";
export interface DaytonaConfig {
    /** Daytona API key (from environment or credential store). */
    apiKey?: string;
    /** Daytona API URL override (default: public Daytona SaaS endpoint). */
    apiUrl?: string;
    /** Daytona region/target override (default: auto-selected by Daytona). */
    target?: string;
    /** Optional SDK import override for testing (defaults to @daytonaio/sdk). */
    sdkImport?: string;
}
/** The subset of the real @daytonaio/sdk `Daytona` client surface this module
 *  depends on (verified against node_modules/@daytonaio/sdk@0.196.0 typings). */
export interface DaytonaSdkClient {
    create(opts: {
        image?: string;
        labels?: Record<string, string>;
        autoStopInterval?: number;
        autoDeleteInterval?: number;
    }): Promise<DaytonaSandbox>;
    /** Auto-paginating async iterator — consuming it to exhaustion visits every
     *  sandbox, no manual page-looping required. */
    list(query?: {
        labels?: Record<string, string>;
    }): AsyncIterableIterator<DaytonaSandbox>;
}
/** The subset of the real @daytonaio/sdk `Sandbox` surface this module depends
 *  on. `id` is always populated on a real SDK Sandbox (verified: Sandbox.d.ts
 *  declares `id: string`, not optional) — `sandboxId` never appears on the real
 *  type; kept optional here only as defensive fallback for older shapes. */
export interface DaytonaSandbox {
    id: string;
    sandboxId?: string;
    labels?: Record<string, string>;
    process: {
        executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeout?: number): Promise<{
            result?: string;
            exitCode: number;
        }>;
    };
    fs: {
        uploadFile(buffer: Buffer, filePath: string): Promise<void>;
        downloadFile(filePath: string): Promise<Buffer>;
    };
    /** Directly callable on a listed sandbox — verified against the real SDK. */
    delete(timeoutSeconds: number): Promise<void>;
}
export type DaytonaClientCtor = new (config: Record<string, unknown>) => DaytonaSdkClient;
/** Dynamically imports the configured SDK module and returns its `Daytona`
 *  constructor. Shared by preflight (existence check), create() (instantiation)
 *  and sweep() (listing/deleting) so there is exactly one SDK-loading path. */
export declare function loadDaytonaClass(config: DaytonaConfig): Promise<DaytonaClientCtor>;
export declare function daytona(config?: DaytonaConfig): Provisioner;
/** Marker used to split the merged stdout+stderr stream back into its two
 *  parts (gap #2: the SDK's executeCommand merges stdout/stderr into a single
 *  `result` string). Envelope layout:
 *    <stdout><\n><marker><\n><stderr>
 *  The marker is 32 random hex chars per call — collision is negligible and
 *  the risk is noted in the design's Risks section. */
export declare function buildExecCommand(argv: string[], marker: string, stdin?: string): string;
export declare function parseExecEnvelope(raw: string, marker: string): {
    stdout: string;
    stderr: string;
};
//# sourceMappingURL=daytona.d.ts.map