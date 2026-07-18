// The diagnostic event vocabulary for the harness wrapper. Implementations of
// Emitter receive events describing the wrapper's internal lifecycle and can
// route them to stderr, log files, structured loggers, or test recorders.
//
// Trace events are observability, not control flow. Callers should not make
// decisions based on event kinds, fields, or ordering.

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

class DiscardEmitter implements Emitter {
  emit(_e: Event): void {}
}

/** An Emitter that drops every event it receives. */
export const Discard: Emitter = new DiscardEmitter();

// serialize encodes an event the way Go's JSON encoder does: `at` as an RFC3339
// timestamp, and `fields` omitted entirely when empty.
function serialize(e: Event): string {
  const obj: Record<string, unknown> = {
    at: (e.at ?? new Date(0)).toISOString(),
    kind: e.kind,
  };
  if (e.fields && Object.keys(e.fields).length > 0) {
    obj.fields = e.fields;
  }
  return JSON.stringify(obj);
}

class WriterEmitter implements Emitter {
  private readonly w: Writer;

  constructor(w: Writer) {
    this.w = w;
  }

  emit(e: Event): void {
    // Trace failures must not affect wrapper correctness.
    try {
      this.w.write(serialize(e) + "\n");
    } catch {
      // dropped on purpose
    }
  }
}

/**
 * Return an Emitter that writes one JSON-encoded event per line to w. Encoding
 * errors are silently dropped.
 */
export function newWriterEmitter(w: Writer): Emitter {
  return new WriterEmitter(w);
}

class LogAdapter implements Emitter {
  private readonly handler: LogHandler;

  constructor(handler: LogHandler) {
    this.handler = handler;
  }

  emit(e: Event): void {
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
export function newLogAdapter(handler: LogHandler): Emitter {
  return new LogAdapter(handler);
}
