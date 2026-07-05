// Consumed surfaces — the Phase-4 wrapper Session and the turns Adapter/Watcher
// the chat layer sits on top of, expressed as TS interfaces.
//
// The chat layer DOES NOT reimplement supervision: it consumes these surfaces.
// They are modeled structurally here so the Conversation can be wired against the
// real wrapper/turns implementations (when present) or against an in-process fake
// (the fakeharness test util) without change. Adapter capabilities are optional
// methods — the analogue of Go's optional-interface type assertions
// (turns.Quitter, turns.BusyDetector, turns.RawSessionIDExtractor, …).
export {};
//# sourceMappingURL=deps.js.map