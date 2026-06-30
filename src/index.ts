// meta-harness — library root.
//
// This barrel is intentional: it exports only the package VERSION and curated,
// public re-exports. Nothing private is surfaced here. In particular, the
// async toolkit and everything else under `src/internal/**` is NEVER exported
// from this file or any public subpath barrel (./screen, ./wrapper, ./turns,
// ./transcript, ./chat, ./discovery, ./versions).

export const VERSION = "0.0.0"
