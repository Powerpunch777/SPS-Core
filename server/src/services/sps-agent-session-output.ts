import { redactSensitiveText } from "../redaction.js";

const MAX_SUMMARY_BYTES = 65_536;

export type SpsAgentSessionOutput =
  | { state: "available"; text: string }
  | { state: "not_ready"; text: null }
  | { state: "withheld"; text: null; reason: "missing" | "invalid" | "too_large" | "not_successful" };

function output<T extends SpsAgentSessionOutput>(value: T): T {
  return Object.freeze(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readSummary(value: unknown): { found: false } | { found: true; value: unknown } | null {
  if (!isPlainObject(value)) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "summary");
    if (!descriptor || !descriptor.enumerable) return { found: false };
    if (!("value" in descriptor)) return null;
    return { found: true, value: descriptor.value };
  } catch {
    return null;
  }
}

function hasInvalidUnicodeOrControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0xfffd || code === 0x7f) return true;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function observeSpsAgentSessionOutput(input: {
  status: string;
  resultJson: unknown;
}): SpsAgentSessionOutput {
  if (input.status === "queued" || input.status === "running") {
    return output({ state: "not_ready", text: null });
  }
  if (input.status !== "succeeded") {
    return output({ state: "withheld", text: null, reason: "not_successful" });
  }

  const summary = readSummary(input.resultJson);
  if (!summary) return output({ state: "withheld", text: null, reason: "invalid" });
  if (!summary.found || summary.value === null) {
    return output({ state: "withheld", text: null, reason: "missing" });
  }
  if (typeof summary.value !== "string") {
    return output({ state: "withheld", text: null, reason: "invalid" });
  }
  if (!summary.value.trim()) return output({ state: "withheld", text: null, reason: "missing" });
  if (hasInvalidUnicodeOrControls(summary.value)) {
    return output({ state: "withheld", text: null, reason: "invalid" });
  }
  if (byteLength(summary.value) > MAX_SUMMARY_BYTES) {
    return output({ state: "withheld", text: null, reason: "too_large" });
  }

  const text = redactSensitiveText(summary.value);
  if (byteLength(text) > MAX_SUMMARY_BYTES) {
    return output({ state: "withheld", text: null, reason: "too_large" });
  }
  return output({ state: "available", text });
}
