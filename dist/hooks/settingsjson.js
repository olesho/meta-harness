// settings.json editor (Go analogue: pkg/harness/settingsjson.go).
//
// Models Claude Code's settings.json 2-level hook format:
//
//   { "hooks": { "<Event>": [ { "matcher": "<glob>",
//                               "hooks": [ { "type": "command",
//                                            "command": "<cmd>" } ] } ] } }
//
// ensureSettingsJSONHooks is idempotent and co-tenant-safe: re-running leaves
// exactly one managed block per event and preserves any block we do not own.
// removeManagedHooks is the explicit teardown path (ordinary shutdown does NOT
// strip hooks — installs are cheap and re-ensured each session).
import { readFileSync } from "node:fs";
import { atomicWriteFileSync, withLockedFile } from "./lock.js";
import { isManagedHookCommand } from "./command.js";
// readSettings loads and parses the config, tolerating an absent or empty file
// (both yield `{}`). A malformed file is a hard error — we refuse to clobber it.
function readSettings(configPath) {
    let raw;
    try {
        raw = readFileSync(configPath, "utf8");
    }
    catch (err) {
        if (err.code === "ENOENT")
            return {};
        throw err;
    }
    if (raw.trim() === "")
        return {};
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`settings.json is not a JSON object: ${configPath}`);
    }
    return parsed;
}
// stripManaged drops every marker-tagged command from the given matcher list,
// preserving co-tenant commands. A matcher left with no commands is removed.
function stripManaged(matchers) {
    const out = [];
    for (const m of matchers) {
        const kept = (m.hooks ?? []).filter((h) => !isManagedHookCommand(h.command));
        if (kept.length > 0)
            out.push({ ...m, hooks: kept });
    }
    return out;
}
function serialize(settings) {
    return `${JSON.stringify(settings, null, 2)}\n`;
}
// ensureSettingsJSONHooks installs `managed` into `configPath` under the O_EXCL
// lock, atomically. For each event it strips any previously-managed block and
// appends the desired managed matchers, so the result is exactly-once and
// leaves co-tenant blocks intact.
export function ensureSettingsJSONHooks(configPath, managed) {
    withLockedFile(configPath, () => {
        const settings = readSettings(configPath);
        const hooks = settings.hooks ?? {};
        for (const [event, desired] of Object.entries(managed)) {
            const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
            const preserved = stripManaged(existing);
            const next = [...preserved, ...desired];
            if (next.length > 0)
                hooks[event] = next;
            else
                delete hooks[event];
        }
        if (Object.keys(hooks).length > 0)
            settings.hooks = hooks;
        else
            delete settings.hooks;
        atomicWriteFileSync(configPath, serialize(settings));
    });
}
// removeManagedHooks strips meta-harness's managed blocks from `configPath`,
// leaving co-tenant blocks untouched. When `events` is omitted every event is
// swept; the file is rewritten atomically under the lock.
export function removeManagedHooks(configPath, events) {
    withLockedFile(configPath, () => {
        const settings = readSettings(configPath);
        const hooks = settings.hooks;
        if (!hooks)
            return;
        const targets = events ?? Object.keys(hooks);
        for (const event of targets) {
            const existing = hooks[event];
            if (!Array.isArray(existing))
                continue;
            const preserved = stripManaged(existing);
            if (preserved.length > 0)
                hooks[event] = preserved;
            else
                delete hooks[event];
        }
        if (Object.keys(hooks).length > 0)
            settings.hooks = hooks;
        else
            delete settings.hooks;
        atomicWriteFileSync(configPath, serialize(settings));
    });
}
//# sourceMappingURL=settingsjson.js.map