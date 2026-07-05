// The DURABLE serialization of events — distinct from Event's PUBLIC DTO
// (toPublicJSON), which omits source/nativeID/schemaVersion. The durable form
// MUST persist those fields: the authority filter keys on source and dedup keys
// on nativeID, so a round-trip dropping them would corrupt acquisition.
import { wrap } from "../internal/async/index.js";
function toWire(pe) {
    const e = pe.event;
    const w = {
        seq: e.seq ?? 0,
        timestamp: e.timestamp ? e.timestamp.toISOString() : null,
        role: e.role ?? "",
        type: e.type ?? "",
        schema_version: e.schemaVersion ?? 0,
    };
    if (e.text)
        w.text = e.text;
    if (e.toolName)
        w.tool_name = e.toolName;
    if (e.toolUseID)
        w.tool_use_id = e.toolUseID;
    if (e.toolInput)
        w.tool_input = JSON.parse(e.toolInput);
    if (e.output)
        w.output = e.output;
    if (e.uuid)
        w.uuid = e.uuid;
    if (e.source)
        w.source = e.source;
    if (e.nativeID)
        w.native_id = e.nativeID;
    const out = { harness_session_id: pe.harnessSessionID, event: w };
    if (pe.parentSessionID)
        out.parent_session_id = pe.parentSessionID;
    return out;
}
function fromWire(w) {
    const e = w.event;
    const ev = {
        seq: e.seq,
        timestamp: e.timestamp ? new Date(e.timestamp) : undefined,
        role: e.role,
        type: e.type,
        text: e.text,
        toolName: e.tool_name,
        toolUseID: e.tool_use_id,
        toolInput: e.tool_input !== undefined ? JSON.stringify(e.tool_input) : undefined,
        output: e.output,
        uuid: e.uuid,
        source: e.source,
        nativeID: e.native_id,
        schemaVersion: e.schema_version,
    };
    return {
        harnessSessionID: w.harness_session_id,
        parentSessionID: w.parent_session_id,
        event: ev,
    };
}
// marshalParsedEvents serializes events in the DURABLE form (all fields).
export function marshalParsedEvents(events) {
    return JSON.stringify(events.map(toWire));
}
// unmarshalParsedEvents parses the durable form, restoring all fields.
export function unmarshalParsedEvents(data) {
    let wire;
    try {
        wire = JSON.parse(data);
    }
    catch (err) {
        throw wrap("transcript: unmarshal parsed events", err);
    }
    return wire.map(fromWire);
}
//# sourceMappingURL=eventWire.js.map