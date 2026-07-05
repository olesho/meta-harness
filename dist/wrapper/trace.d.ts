/** A single observation emitted by the wrapper. */
export interface Event {
    /** When the observation was made. */
    at?: Date;
    /** The event kind (e.g. "pty_opened"). */
    kind: string;
    /** Optional structured fields. */
    fields?: Record<string, unknown>;
}
/** Receives events. Implementations must be safe for concurrent use. */
export interface Emitter {
    emit(e: Event): void;
}
/** A minimal sink the writer emitter appends newline-framed JSON to. */
export interface Writer {
    write(chunk: string): void;
}
/** A structured-log record, the TS analogue of Go's slog.Record. */
export interface LogRecord {
    time: Date;
    message: string;
    attrs: Record<string, unknown>;
}
/** A handler for structured log records. */
export interface LogHandler {
    handle(record: LogRecord): void;
}
/** An Emitter that drops every event it receives. */
export declare const Discard: Emitter;
/**
 * Return an Emitter that writes one JSON-encoded event per line to w. Encoding
 * errors are silently dropped.
 */
export declare function newWriterEmitter(w: Writer): Emitter;
/**
 * Return an Emitter that forwards events to a structured-log handler as
 * records: the event's `at` becomes the record time, `kind` the message, and
 * `fields` the record attributes.
 */
export declare function newLogAdapter(handler: LogHandler): Emitter;
//# sourceMappingURL=trace.d.ts.map