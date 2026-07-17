// Registry-drift sentry — compares each harness's pinned upstream version (from
// versions.json, read via src/versions) against the npm registry's published
// `latest`. This is the SECOND drift axis; the first (install-drift, pin vs the
// locally-installed binary's --version) lives in src/discovery and is untouched
// here.
//
// TOOLING-ONLY: this module is deliberately NOT wired into the package `exports`
// map — there is no public subpath consumer. It is imported by the thin CLI bin
// (src/cli/check-versions.ts) via a relative path.
//
// Design constraints (mirrored from the task contract):
//   - Pins are read via `all()` from src/versions — the embedded catalog, zero
//     binary probing. Never routed through discovery, which SPAWNS the local
//     binary and fails/stalls when nothing is installed.
//   - Comparison is EXACT STRING EQUALITY (version === entry.pinned), exactly as
//     discovery.ts:334 compares — never a semver-range compare.
//   - No new dependencies: uses the Node global `fetch`, no HTTP client, no
//     `semver`.
//   - A network/parse failure is a DISTINCT outcome (errFetch / errParse),
//     never collapsed into `match` or `drift`.
import { all } from "../versions/index.js";
import { defineSentinel, wrap } from "../internal/async/index.js";
/** Network / fetch failure reaching the npm registry. */
export const errFetch = defineSentinel("drift/fetch", "drift: fetch");
/** Response body could not be parsed / lacked the expected version field. */
export const errParse = defineSentinel("drift/parse", "drift: parse");
const REGISTRY = "https://registry.npmjs.org";
/**
 * Fetch the npm registry `latest` version for a package. Uses ONE code path for
 * both scoped (`@openai/codex`) and bare (`opencode-ai`) names by
 * percent-encoding the whole name — so the `/` in a scope never lands raw in the
 * URL path (which the registry resolves inconsistently and can silently 404,
 * the exact failure that would let a probe error masquerade as match/drift).
 *
 *   PRIMARY  : GET /${encodeURIComponent(pkg)}          → body["dist-tags"].latest
 *   FALLBACK : GET /${encodeURIComponent(pkg)}/latest   → body.version
 *
 * Throws a wrapped `errFetch` on network failure / non-OK status, or a wrapped
 * `errParse` when neither response shape yields a usable version string.
 */
export async function fetchLatest(pkg) {
    const enc = encodeURIComponent(pkg);
    // PRIMARY: abbreviated packument — latest lives under dist-tags.
    const primary = await fetchJson(`${REGISTRY}/${enc}`);
    const distTags = primary["dist-tags"];
    const primaryLatest = distTags?.latest;
    if (typeof primaryLatest === "string" && primaryLatest !== "") {
        return primaryLatest;
    }
    // FALLBACK: the /latest document — version lives at body.version (NOT dist-tags).
    const fallback = await fetchJson(`${REGISTRY}/${enc}/latest`);
    const fallbackVersion = fallback.version;
    if (typeof fallbackVersion === "string" && fallbackVersion !== "") {
        return fallbackVersion;
    }
    throw wrap(`drift: parse: no latest version for ${pkg}`, errParse);
}
/** GET a URL and parse JSON, mapping transport vs body failures to sentinels. */
async function fetchJson(url) {
    let res;
    try {
        res = await fetch(url);
    }
    catch (err) {
        throw wrap(`drift: fetch ${url}: ${String(err)}`, errFetch);
    }
    if (!res.ok) {
        throw wrap(`drift: fetch ${url}: status ${res.status}`, errFetch);
    }
    try {
        return await res.json();
    }
    catch (err) {
        throw wrap(`drift: parse ${url}: ${String(err)}`, errParse);
    }
}
/**
 * Build one Row for a single harness. Unpinned entries (`pinned === ""`) are
 * reported as `unpinned` WITHOUT ever hitting the network — never as drift.
 */
export async function checkEntry(name, pkg, pinned) {
    if (pinned === "") {
        return { name, package: pkg, pinned, status: "unpinned" };
    }
    const latest = await fetchLatest(pkg);
    // EXACT string equality, exactly as discovery.ts:334 (version === entry.pinned).
    const status = latest === pinned ? "match" : "drift";
    return { name, package: pkg, pinned, latest, status };
}
/**
 * Check every harness in the embedded catalog against the npm registry.
 *
 * Returns a Row per harness on success. A fetch/parse failure for ANY package
 * throws the underlying sentinel (errFetch / errParse) — the CLI maps that to
 * exit 1, so a registry outage can never silently read as all-match.
 */
export async function checkAll() {
    const rows = [];
    for (const [name, entry] of all()) {
        rows.push(await checkEntry(name, entry.package, entry.pinned));
    }
    return rows;
}
/** True when any row is in the `drift` state. */
export function hasDrift(rows) {
    return rows.some((r) => r.status === "drift");
}
//# sourceMappingURL=sentry.js.map