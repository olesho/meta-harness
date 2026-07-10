import type { Context } from "../internal/async/index.ts";
import type { ExecOpts, ExecResult, Workspace, WorkspaceSpec } from "./types.ts";
/**
 * Check if docker or podman is available on the system.
 * Returns the command name ("docker" or "podman"), or null if neither is found.
 */
export declare function detectContainerRuntime(): "docker" | "podman" | null;
/**
 * ContainerWorkspace is a test-only Workspace implementation that drives
 * a container via docker run/exec/cp.
 */
export declare class ContainerWorkspace implements Workspace {
    private readonly runtime;
    private readonly containerId;
    private readonly tmpDir;
    constructor(runtime: "docker" | "podman", containerId: string, tmpDir: string);
    exec(_ctx: Context, argv: string[], opts?: ExecOpts): Promise<ExecResult>;
    upload(_ctx: Context, hostPath: string, guestPath: string): Promise<void>;
    download(_ctx: Context, guestPath: string, hostPath: string): Promise<void>;
    guestPath(kind: "repo" | "home" | "tmp"): string;
    hostAlias(hostUrl: string): string;
    destroy(_ctx: Context, _outcome?: string): Promise<void>;
    static create(spec: WorkspaceSpec): Promise<ContainerWorkspace>;
}
//# sourceMappingURL=container.d.ts.map