// Test-only container workspace — a minimal docker/podman-based Workspace
// implementation for Tier-3 in-guest e2e testing. Uses plain docker run/exec/cp
// over node:child_process (no SDK, hermetic, suitable for CI).
import { execSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Check if docker or podman is available on the system.
 * Returns the command name ("docker" or "podman"), or null if neither is found.
 */
export function detectContainerRuntime() {
    try {
        execSync("docker --version", { stdio: ["pipe", "pipe", "pipe"] });
        return "docker";
    }
    catch {
        try {
            execSync("podman --version", { stdio: ["pipe", "pipe", "pipe"] });
            return "podman";
        }
        catch {
            return null;
        }
    }
}
/**
 * ContainerWorkspace is a test-only Workspace implementation that drives
 * a container via docker run/exec/cp.
 */
export class ContainerWorkspace {
    runtime;
    containerId;
    tmpDir;
    constructor(runtime, containerId, tmpDir) {
        this.runtime = runtime;
        this.containerId = containerId;
        this.tmpDir = tmpDir;
    }
    async exec(_ctx, argv, opts) {
        const env = opts?.env || {};
        const cwd = opts?.cwd || "/repo";
        // Build the docker/podman exec command with env vars
        const cmd = [this.runtime, "exec"];
        // Set working directory
        cmd.push("-w", cwd);
        // Add environment variables
        for (const [k, v] of Object.entries(env)) {
            cmd.push("-e", `${k}=${v}`);
        }
        cmd.push(this.containerId);
        cmd.push(...argv);
        return new Promise((resolve) => {
            let stdout = "";
            let stderr = "";
            const proc = spawn(cmd[0], cmd.slice(1), {
                stdio: ["ignore", "pipe", "pipe"],
            });
            if (proc.stdout) {
                proc.stdout.on("data", (chunk) => {
                    stdout += chunk.toString();
                });
            }
            if (proc.stderr) {
                proc.stderr.on("data", (chunk) => {
                    stderr += chunk.toString();
                });
            }
            proc.on("close", (code) => {
                resolve({
                    code: code ?? 1,
                    stdout,
                    stderr,
                });
            });
        });
    }
    async upload(_ctx, hostPath, guestPath) {
        // Use docker/podman cp to copy the file
        execSync(`${this.runtime} cp "${hostPath}" ${this.containerId}:"${guestPath}"`);
    }
    async download(_ctx, guestPath, hostPath) {
        // Use docker/podman cp to copy the file back
        execSync(`${this.runtime} cp ${this.containerId}:"${guestPath}" "${hostPath}"`);
    }
    guestPath(kind) {
        switch (kind) {
            case "repo":
                return "/repo";
            case "home":
                return "/home";
            case "tmp":
                return "/tmp";
        }
    }
    hostAlias(hostUrl) {
        // In docker/podman, use host.docker.internal / host.containers.internal
        // For simplicity in tests, just rewrite localhost
        return hostUrl.replace("localhost", "host.docker.internal");
    }
    async destroy(_ctx, _outcome) {
        // Stop and remove the container
        try {
            execSync(`${this.runtime} stop ${this.containerId}`, { stdio: "ignore" });
        }
        catch {
            /* already stopped */
        }
        try {
            execSync(`${this.runtime} rm ${this.containerId}`, { stdio: "ignore" });
        }
        catch {
            /* already removed */
        }
        // Clean up temp dir
        try {
            rmSync(this.tmpDir, { recursive: true, force: true });
        }
        catch {
            /* best effort */
        }
    }
    static async create(spec) {
        const runtime = detectContainerRuntime();
        if (!runtime) {
            throw new Error("container-workspace: docker or podman is not available");
        }
        const tmpDir = mkdtempSync(join(tmpdir(), "mh-container-"));
        const name = spec.name || "meta-harness-test-" + Date.now();
        // Run the container
        const cmd = [
            runtime,
            "run",
            "-d",
            "-i",
            "--name",
            name,
            "--rm",
            spec.image || "node:latest",
            "tail",
            "-f",
            "/dev/null",
        ];
        const output = execSync(cmd.join(" ")).toString().trim();
        const containerId = output.split("\n")[0];
        return new ContainerWorkspace(runtime, containerId, tmpDir);
    }
}
//# sourceMappingURL=container.js.map