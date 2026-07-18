// Daytona provisioner (design §3, §4).
//
// Provisions elastic remote sandboxes via the Daytona SDK (@daytonaio/sdk,
// optional peer dependency). The SDK is loaded lazily at preflight/create time
// so this module stays SDK-free and can be imported by consumers without the
// peer being installed.
//
// Ported from loomcli DaytonaSandboxApi (daytona-task-runner.ts:373-434), then
// adjusted against the REAL @daytonaio/sdk@0.196.0 typings (verified during
// META-HARNESS-45): `process.executeCommand` merges stdout+stderr into
// `result`/`artifacts.stdout` (no separate stderr stream) — hence the marker
// envelope below; `Sandbox.delete(timeout)` is directly callable on a listed
// sandbox; `Daytona.list()` returns an AsyncIterableIterator that already
// paginates internally (no manual page-looping needed).
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argvToShell, shQuote } from "../env/argv.js";
import { shouldKeep } from "../env/retention.js";
const execFileAsync = promisify(execFile);
/** Dynamically imports the configured SDK module and returns its `Daytona`
 *  constructor. Shared by preflight (existence check), create() (instantiation)
 *  and sweep() (listing/deleting) so there is exactly one SDK-loading path. */
export async function loadDaytonaClass(config) {
    const sdkImport = config.sdkImport || "@daytonaio/sdk";
    try {
        const mod = await import(__rewriteRelativeImportExtension(sdkImport));
        const DaytonaClass = mod.Daytona || mod.default?.Daytona;
        if (typeof DaytonaClass !== "function") {
            throw new Error(`${sdkImport} did not expose Daytona as a constructor`);
        }
        return DaytonaClass;
    }
    catch (error) {
        throw new Error(`Failed to load Daytona SDK from ${sdkImport}: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function clientConfigFor(config) {
    const clientConfig = { apiKey: config.apiKey };
    if (config.apiUrl)
        clientConfig.apiUrl = config.apiUrl;
    if (config.target)
        clientConfig.target = config.target;
    return clientConfig;
}
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
        // Load SDK dynamically; if it fails, the provisioner cannot be used.
        await loadDaytonaClass(this.config);
    }
    async create(ctx, spec) {
        const DaytonaClass = await loadDaytonaClass(this.config);
        const client = new DaytonaClass(clientConfigFor(this.config));
        const sandbox = await client.create({
            image: spec.image,
            labels: spec.labels || {},
            autoStopInterval: spec.autoStopInterval ?? 15,
            autoDeleteInterval: spec.autoDeleteInterval ?? 0,
        });
        return new DaytonaWorkspace(sandbox, spec);
    }
}
/** Marker used to split the merged stdout+stderr stream back into its two
 *  parts (gap #2: the SDK's executeCommand merges stdout/stderr into a single
 *  `result` string). Envelope layout:
 *    <stdout><\n><marker><\n><stderr>
 *  The marker is 32 random hex chars per call — collision is negligible and
 *  the risk is noted in the design's Risks section. */
export function buildExecCommand(argv, marker, stdin) {
    const body = argvToShell(argv);
    const stdinPrefix = stdin !== undefined ? `printf %s ${shQuote(stdin)} | ` : "";
    return (`__e=$(mktemp); { ${stdinPrefix}${body}; } 2>"$__e"; ` +
        `__c=$?; printf '\\n%s\\n' '${marker}'; cat "$__e"; rm -f "$__e"; exit $__c`);
}
export function parseExecEnvelope(raw, marker) {
    const sep = `\n${marker}\n`;
    const idx = raw.indexOf(sep);
    if (idx === -1) {
        // Defensive: marker absent (e.g. truncated/odd SDK behavior) → treat the
        // whole payload as stdout rather than losing output.
        return { stdout: raw, stderr: "" };
    }
    return { stdout: raw.slice(0, idx), stderr: raw.slice(idx + sep.length) };
}
class DaytonaWorkspace {
    sandbox;
    spec;
    destroyed = false;
    constructor(sandbox, spec) {
        this.sandbox = sandbox;
        this.spec = spec;
    }
    async exec(ctx, argv, opts) {
        const marker = `__MH_${randomBytes(16).toString("hex")}__`;
        const command = buildExecCommand(argv, marker, opts?.stdin);
        const result = await this.sandbox.process.executeCommand(command, opts?.cwd, opts?.env, 
        /* timeout */ undefined);
        const { stdout, stderr } = parseExecEnvelope(result.result ?? "", marker);
        return {
            code: result.exitCode ?? 0,
            stdout,
            stderr,
        };
    }
    async upload(ctx, hostPath, guestPath) {
        const stat = await (await import("node:fs/promises")).stat(hostPath);
        if (stat.isDirectory()) {
            await this.uploadDir(ctx, hostPath, guestPath);
        }
        else {
            // Mirror local.ts's mkParent(guestPath): the guest parent directory is
            // not guaranteed to pre-exist (e.g. fileCredentialInjector's
            // ~/.tokens/daytona).
            await this.execChecked(ctx, ["mkdir", "-p", dirname(guestPath)]);
            const buffer = await readFile(hostPath);
            await this.sandbox.fs.uploadFile(buffer, guestPath);
        }
    }
    async uploadDir(ctx, hostPath, guestPath) {
        const hostTmp = await mkdtemp(join(tmpdir(), "mh-daytona-up-"));
        const tarPath = join(hostTmp, "up.tar");
        try {
            await execFileAsync("tar", ["-C", hostPath, "-cf", tarPath, "."]);
            const guestTar = `${this.guestPath("tmp")}/mh-up-${randomBytes(8).toString("hex")}.tar`;
            const buffer = await readFile(tarPath);
            await this.execChecked(ctx, ["mkdir", "-p", this.guestPath("tmp")]);
            await this.sandbox.fs.uploadFile(buffer, guestTar);
            await this.execChecked(ctx, ["mkdir", "-p", guestPath]);
            await this.execChecked(ctx, ["tar", "-xf", guestTar, "-C", guestPath]);
            await this.execChecked(ctx, ["rm", "-f", guestTar]);
        }
        finally {
            await rm(hostTmp, { recursive: true, force: true });
        }
    }
    async download(ctx, guestPath, hostPath) {
        const isDir = await this.execIsDir(ctx, guestPath);
        if (isDir) {
            await this.downloadDir(ctx, guestPath, hostPath);
        }
        else {
            // Mirror local.ts's mkParent(hostPath) — covers turn.ts's
            // retrieveTranscriptTo, an arbitrarily-nested host path.
            await mkdir(dirname(hostPath), { recursive: true });
            const buffer = await this.sandbox.fs.downloadFile(guestPath);
            await writeFile(hostPath, buffer);
        }
    }
    async execIsDir(ctx, guestPath) {
        const r = await this.exec(ctx, ["test", "-d", guestPath]);
        return r.code === 0;
    }
    async downloadDir(ctx, guestPath, hostPath) {
        const guestTar = `${this.guestPath("tmp")}/mh-down-${randomBytes(8).toString("hex")}.tar`;
        await this.execChecked(ctx, ["tar", "-cf", guestTar, "-C", guestPath, "."]);
        const buffer = await this.sandbox.fs.downloadFile(guestTar);
        await this.execChecked(ctx, ["rm", "-f", guestTar]);
        await mkdir(hostPath, { recursive: true });
        const hostTmp = await mkdtemp(join(tmpdir(), "mh-daytona-down-"));
        const tarPath = join(hostTmp, "down.tar");
        try {
            await writeFile(tarPath, buffer);
            await execFileAsync("tar", ["-xf", tarPath, "-C", hostPath]);
        }
        finally {
            await rm(hostTmp, { recursive: true, force: true });
        }
    }
    async execChecked(ctx, argv) {
        const r = await this.exec(ctx, argv);
        if (r.code !== 0) {
            throw new Error(`daytona: ${argv.join(" ")} failed (code ${r.code}): ${r.stderr || r.stdout}`);
        }
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
    async destroy(ctx, outcome = "success") {
        if (this.destroyed)
            return; // idempotent: double-destroy is a no-op.
        this.destroyed = true; // set BEFORE the shouldKeep check — see design note.
        if (shouldKeep(this.spec.retention, outcome))
            return; // kept for debugging.
        try {
            await this.sandbox.delete(60);
        }
        catch (error) {
            // Best-effort cleanup; errors are logged by the caller.
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`Warning: failed to delete Daytona sandbox: ${msg}`);
        }
    }
}
//# sourceMappingURL=daytona.js.map