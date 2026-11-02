import { describe, expect, it } from "vitest";
import { observeSpsAgentSessionOutput } from "../services/sps-agent-session-output.js";

describe("observeSpsAgentSessionOutput", () => {
  it("keeps queued and running output unavailable", () => {
    for (const status of ["queued", "running"]) {
      expect(observeSpsAgentSessionOutput({ status, resultJson: { summary: "done" } })).toEqual({
        state: "not_ready",
        text: null,
      });
    }
  });

  it("exposes only a successful summary and withholds absent or blank summaries", () => {
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary: "finished" } })).toEqual({
      state: "available",
      text: "finished",
    });
    for (const resultJson of [{}, { summary: null }, { summary: " \n\t" }]) {
      expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson })).toEqual({
        state: "withheld",
        text: null,
        reason: "missing",
      });
    }
    expect(observeSpsAgentSessionOutput({ status: "failed", resultJson: { summary: "private" } })).toEqual({
      state: "withheld",
      text: null,
      reason: "not_successful",
    });
  });

  it("supports null-prototype objects and rejects non-plain result values", () => {
    const result = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(result, "summary", { value: "ok", enumerable: true });
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: result })).toEqual({
      state: "available",
      text: "ok",
    });
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: [] })).toMatchObject({
      state: "withheld",
      reason: "invalid",
    });
  });

  it("never invokes summary getters and ignores non-enumerable summaries", () => {
    let invoked = false;
    const withGetter = Object.defineProperty({}, "summary", {
      enumerable: true,
      get() {
        invoked = true;
        throw new Error("must not run");
      },
    });
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: withGetter })).toMatchObject({
      state: "withheld",
      reason: "invalid",
    });
    const hidden = Object.defineProperty({}, "summary", { value: "secret", enumerable: false });
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: hidden })).toMatchObject({
      state: "withheld",
      reason: "missing",
    });
    expect(invoked).toBe(false);
  });

  it("rejects UTF-8 oversize summaries without truncation", () => {
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary: "x".repeat(65_537) } })).toMatchObject({
      state: "withheld",
      reason: "too_large",
    });
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary: "한".repeat(21_846) } })).toMatchObject({
      state: "withheld",
      reason: "too_large",
    });
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary: "한".repeat(21_845) } })).toMatchObject({
      state: "available",
    });
  });

  it("rechecks the UTF-8 limit after redaction expands a known secret pattern", () => {
    const summary = `${"x\n".repeat(32_755)}Authorization: Bearer x`;
    expect(Buffer.byteLength(summary, "utf8")).toBeLessThanOrEqual(65_536);
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary } })).toMatchObject({
      state: "withheld",
      reason: "too_large",
    });
  });

  it("rejects malformed Unicode and disallowed controls", () => {
    for (const summary of ["lone \ud800", "lone \udc00", "nul\0", "control\u0001", "vertical\u000b", "form\u000c", "del\u007f", "replacement\ufffd"]) {
      expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary } })).toMatchObject({
        state: "withheld",
        reason: "invalid",
      });
    }
    expect(observeSpsAgentSessionOutput({ status: "succeeded", resultJson: { summary: "line 1\nline 2\ttab" } })).toMatchObject({
      state: "available",
    });
  });

  it("does not expose fields other than summary and applies known-pattern redaction", () => {
    const result = observeSpsAgentSessionOutput({
      status: "succeeded",
      resultJson: {
        summary: "Completed. Authorization: Bearer live-bearer-token-value",
        raw: "raw output must not leak",
        stdout: "stdout must not leak",
        stderr: "stderr must not leak",
        path: "C:\\private\\file",
        credentials: "credential must not leak",
        metadata: "metadata must not leak",
      },
    });
    expect(result).toEqual({ state: "available", text: "Completed. Authorization: Bearer ***REDACTED***" });
    expect(JSON.stringify(result)).not.toMatch(/raw output|stdout|stderr|private|credential|metadata|live-bearer-token-value/);
  });

  it("freezes a fresh output on every call", () => {
    const input = { status: "succeeded", resultJson: { summary: "ok" } };
    const first = observeSpsAgentSessionOutput(input);
    const second = observeSpsAgentSessionOutput(input);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(Reflect.set(first, "text", "mutated")).toBe(false);
  });
});
