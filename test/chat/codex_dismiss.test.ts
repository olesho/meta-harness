// Port of pkg/chat/codex_dismiss_test.go — Codex interstitial auto-dismiss.
import { describe, expect, test } from "vitest";
import { codex } from "../../src/turns/index.ts";
import type { InputRequest as TurnsInputRequest } from "../../src/turns/index.ts";
import { EventInputRequest } from "../../src/chat/index.ts";
import { KeyRecorder, newTestConv } from "./helpers.ts";

const enc = new TextEncoder();

function codexUpdateRequest(): TurnsInputRequest {
  return {
    id: "upd-1",
    kind: codex.KindUpdateNotice,
    prompt: "Update available!",
    options: [
      {
        id: "1",
        alias: "update",
        label: "Update now",
        keys: enc.encode("1\r"),
      },
      { id: "2", alias: "skip", label: "Skip", keys: enc.encode("2\r") },
      {
        id: "3",
        alias: "skip",
        label: "Skip until next version",
        keys: enc.encode("3\r"),
      },
    ],
  };
}

describe("codex auto-dismiss", () => {
  test("default: update menu surfaces to client, nothing written", () => {
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "codex" }, rec);
    c.handleInputRequested(codexUpdateRequest());
    expect(rec.text()).toBe("");
    expect(c.inputSurfaced).toBe(true);
    const ev = c.eventCh.tryReceive();
    expect(ev.ok).toBe(true);
    expect(ev.value?.type).toBe(EventInputRequest);
    expect(ev.value?.input?.kind).toBe(codex.KindUpdateNotice);
  });

  test("autoSkipCodexUpdateNotice: update menu cleared by Skip, nothing surfaced", () => {
    const rec = new KeyRecorder();
    const c = newTestConv(
      { harness: "codex", autoSkipCodexUpdateNotice: true },
      rec,
    );
    c.handleInputRequested(codexUpdateRequest());
    expect(rec.text()).toBe("2\r");
    expect(c.inputSurfaced).toBe(false);
    expect(c.eventCh.tryReceive().ok).toBe(false);
  });

  test("notice: multi-option 'Press enter to continue' cleared by bare Enter, nothing surfaced", () => {
    // a codex_notice whose parsed rows carry no safe-token alias used
    // to return [null,false] and surface, blocking the codex plan-critic's first
    // send with ErrInputPending. tryAutoDismissCodex now clears it with a bare CR.
    const rec = new KeyRecorder();
    const c = newTestConv({ harness: "codex" }, rec);
    c.handleInputRequested({
      id: "ntc-1",
      kind: codex.KindNotice,
      prompt: "Press enter to continue",
      options: [
        {
          id: "1",
          alias: "",
          label: "View changelog",
          keys: enc.encode("1\r"),
        },
        { id: "2", alias: "", label: "Learn more", keys: enc.encode("2\r") },
      ],
    });
    expect(rec.text()).toBe("\r");
    expect(c.inputSurfaced).toBe(false);
    expect(c.eventCh.tryReceive().ok).toBe(false);
  });

  test("disabled: interstitial surfaces to client", () => {
    const rec = new KeyRecorder();
    const c = newTestConv(
      { harness: "codex", disableCodexAutoDismiss: true },
      rec,
    );
    c.handleInputRequested(codexUpdateRequest());
    expect(rec.data.length).toBe(0);
    expect(c.inputSurfaced).toBe(true);
    expect(c.currentInput?.kind).toBe(codex.KindUpdateNotice);
  });

  test("never touches real approval prompts in either mode", () => {
    const approval = (): TurnsInputRequest => ({
      id: "ap-1",
      kind: "approval_prompt",
      prompt: "apply patch?",
      options: [
        { id: "1", alias: "proceed", label: "Yes", keys: enc.encode("1\r") },
        { id: "2", alias: "deny", label: "No", keys: enc.encode("2\r") },
      ],
    });
    for (const disable of [false, true]) {
      const rec = new KeyRecorder();
      const c = newTestConv(
        { harness: "codex", disableCodexAutoDismiss: disable },
        rec,
      );
      c.handleInputRequested(approval());
      expect(rec.data.length).toBe(0);
      expect(c.inputSurfaced).toBe(true);
    }
  });

  test("never touches the /permissions dialog in any mode", () => {
    // Enter (or any preset row) COMMITS a permission preset to
    // ~/.codex/config.toml, globally — this request must only ever be answered
    // by a human. The literal kind string is the client contract.
    const permissions = (): TurnsInputRequest => ({
      id: "perm-1",
      kind: "permissions_prompt",
      prompt: "Update Model Permissions",
      options: [
        {
          id: "1",
          alias: "ask-for-approval",
          label: "Ask for approval (current)",
          keys: enc.encode("1\r"),
          highlighted: true,
        },
        {
          id: "2",
          alias: "approve-for-me",
          label: "Approve for me",
          keys: enc.encode("2\r"),
        },
        {
          id: "3",
          alias: "full-access",
          label: "Full Access",
          keys: enc.encode("3\r"),
        },
      ],
    });
    expect(permissions().kind).toBe(codex.KindPermissions);
    for (const disable of [false, true]) {
      for (const autoSkip of [false, true]) {
        const rec = new KeyRecorder();
        const c = newTestConv(
          {
            harness: "codex",
            disableCodexAutoDismiss: disable,
            autoSkipCodexUpdateNotice: autoSkip,
          },
          rec,
        );
        c.handleInputRequested(permissions());
        expect(
          rec.data.length,
          `keys written with disable=${disable} autoSkip=${autoSkip}`,
        ).toBe(0);
        expect(c.inputSurfaced).toBe(true);
        expect(c.currentInput?.kind).toBe(codex.KindPermissions);
      }
    }
  });
});
