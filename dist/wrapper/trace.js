// The diagnostic event vocabulary for the harness wrapper. Implementations of
// Emitter receive events describing the wrapper's internal lifecycle and can
// route them to stderr, log files, structured loggers, or test recorders.
//
// Trace events are observability, not control flow. Callers should not make
// decisions based on event kinds, fields, or ordering.
class DiscardEmitter {
    emit(_e) { }
}
/** An Emitter that drops every event it receives. */
export const Discard = new DiscardEmitter();
// serialize encodes an event the way Go's JSON encoder does: `at` as an RFC3339
// timestamp, and `fields` omitted entirely when empty.
function serialize(e) {
    const obj = {
        at: (e.at ?? new Date(0)).toISOString(),
        kind: e.kind,
    };
    if (e.fields && Object.keys(e.fields).length > 0) {
        obj.fields = e.fields;
    }
    return JSON.stringify(obj);
}
class WriterEmitter {
    w;
    constructor(w) {
        this.w = w;
    }
    emit(e) {
        // Trace failures must not affect wrapper correctness.
        try {
            this.w.write(serialize(e) + "\n");
        }
        catch {
            // dropped on purpose
        }
    }
}
/**
 * Return an Emitter that writes one JSON-encoded event per line to w. Encoding
 * errors are silently dropped.
 */
export function newWriterEmitter(w) {
    return new WriterEmitter(w);
}
class LogAdapter {
    handler;
    constructor(handler) {
        this.handler = handler;
    }
    emit(e) {
        this.handler.handle({
            time: e.at ?? new Date(0),
            message: e.kind,
            attrs: e.fields ?? {},
        });
    }
}
/**
 * Return an Emitter that forwards events to a structured-log handler as
 * records: the event's `at` becomes the record time, `kind` the message, and
 * `fields` the record attributes.
 */
export function newLogAdapter(handler) {
    return new LogAdapter(handler);
}
//# sourceMappingURL=trace.js.map