// Daytona provisioner (design §3, §4).
//
// Provisions elastic remote sandboxes via the Daytona SDK (@daytonaio/sdk,
// optional peer dependency). The SDK is loaded lazily at preflight/create time
// so this module stays SDK-free and can be imported by consumers without the
// peer being installed.
//
// Ported from loomcli DaytonaSandboxApi (daytona-task-runner.ts:373-434).
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
export function daytona(config = {}) {
    return new DaytonaProvisioner(config);
}
class DaytonaProvisioner {
    config;
    constructor(config) {
        this.config = config;
    }
    name() {
        return "daytona";
    }
    async preflight(ctx) {
        // Load SDK dynamically; if it fails, the provisioner cannot be used
        await this.loadSdk();
    }
    async create(ctx, spec) {
        // The public npm package is @daytonaio/sdk, but allow override for testing
        const sdkImport = this.config.sdkImport || "@daytonaio/sdk";
        let DaytonaClass;
        try {
            const mod = await import(__rewriteRelativeImportExtension(sdkImport));
            DaytonaClass = mod.Daytona || (mod.default && mod.default.Daytona);
            if (typeof DaytonaClass !== "function") {
                throw new Error(`${sdkImport} did not expose Daytona as a constructor`);
            }
        }
        catch (error) {
            throw new Error(`Failed to load Daytona SDK from ${sdkImport}: ${error instanceof Error ? error.message : String(error)}`);
        }
        const clientConfig = {
            apiKey: this.config.apiKey,
        };
        if (this.config.apiUrl) {
            clientConfig.apiUrl = this.config.apiUrl;
        }
        if (this.config.target) {
            clientConfig.target = this.config.target;
        }
        const client = new DaytonaClass(clientConfig);
        const sandbox = await client.create({
            labels: spec.labels || {},
            autoStopInterval: spec.autoStopInterval ?? 15,
            autoDeleteInterval: spec.autoDeleteInterval ?? 0,
        });
        return new DaytonaWorkspace(sandbox, spec);
    }
    async loadSdk() {
        const sdkImport = this.config.sdkImport || "@daytonaio/sdk";
        try {
            await import(__rewriteRelativeImportExtension(sdkImport));
        }
        catch (error) {
            throw new Error(`Daytona SDK (@daytonaio/sdk) not available: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
class DaytonaWorkspace {
    sandbox;
    spec;
    constructor(sandbox, spec) {
        this.sandbox = sandbox;
        this.spec = spec;
    }
    async exec(ctx, argv, opts) {
        const command = argv.join(" ");
        const result = await this.sandbox.process.executeCommand(command, opts?.cwd, opts?.env, 
        /* timeout */ undefined);
        return {
            code: result.exitCode || 0,
            stdout: result.result || "",
            stderr: "",
        };
    }
    async upload(ctx, hostPath, guestPath) {
        const fs = await import("node:fs/promises");
        const buffer = await fs.readFile(hostPath);
        await this.sandbox.fs.uploadFile(buffer, guestPath);
    }
    async download(ctx, guestPath, hostPath) {
        const fs = await import("node:fs/promises");
        const buffer = await this.sandbox.fs.downloadFile(guestPath);
        await fs.writeFile(hostPath, buffer);
    }
    guestPath(kind) {
        switch (kind) {
            case "repo":
                return "/home/daytona/repo";
            case "home":
                return "/home/daytona/.home";
            case "tmp":
                return "/tmp";
        }
    }
    hostAlias(hostUrl) {
        // Daytona sandboxes can reach the host via localhost without special handling
        return hostUrl;
    }
    async destroy(ctx, outcome) {
        try {
            if (this.sandbox.delete) {
                await this.sandbox.delete(60);
            }
        }
        catch (error) {
            // Best-effort cleanup; errors are logged by the caller
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`Warning: failed to delete Daytona sandbox: ${msg}`);
        }
    }
}
//# sourceMappingURL=daytona.js.map