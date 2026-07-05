// Store — persists chat-level session metadata and turn records. The TS port of
// pkg/chat/store.go. Implementations must be safe for concurrent use.
//
// Store does NOT store transcript bodies; harnesses persist their own logs and
// the transcript layer reads them for History reconstruction.
export {};
//# sourceMappingURL=store.js.map