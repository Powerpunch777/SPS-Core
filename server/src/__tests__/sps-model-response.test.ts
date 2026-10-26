import { describe, expect, it } from "vitest";
import { parseSpsModelTextResponse } from "../services/sps-model-response.js";

describe("parseSpsModelTextResponse", () => {
  it("concatenates assistant text and returns only the bounded usage projection", () => {
    const response = parseSpsModelTextResponse({
      id: "provider-response-id",
      status: "completed",
      output: [
        {
          id: "provider-message-id",
          type: "message",
          role: "assistant",
          metadata: { private: "must not escape" },
          content: [
            {
              type: "output_text",
              text: "Hello",
              annotations: [{ type: "url_citation", url: "https://private.invalid" }],
            },
            { type: "output_text", text: ", world!" },
          ],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: " Next." }],
        },
      ],
      usage: {
        input_tokens: 4,
        output_tokens: 3,
        total_tokens: 7,
        provider_detail: "must not escape",
      },
      provider_detail: "must not escape",
    });

    expect(response).toEqual({
      status: "completed",
      text: "Hello, world! Next.",
      refusal: null,
      usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
    });
  });

  it("aggregates refusal parts without exposing provider fields", () => {
    expect(
      parseSpsModelTextResponse({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "refusal", refusal: "I cannot " },
              { type: "refusal", refusal: "help with that." },
            ],
          },
        ],
      }),
    ).toEqual({ status: "completed", text: "", refusal: "I cannot help with that.", usage: null });
  });

  it("ignores reasoning summaries and encrypted fields", () => {
    expect(
      parseSpsModelTextResponse({
        status: "completed",
        output: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "private reasoning" }],
            encrypted_content: "private encrypted reasoning",
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Answer" }],
          },
        ],
      }),
    ).toEqual({ status: "completed", text: "Answer", refusal: null, usage: null });
  });

  it("allows an incomplete response with no messages", () => {
    expect(parseSpsModelTextResponse({ status: "incomplete", output: [] })).toEqual({
      status: "incomplete",
      text: "",
      refusal: null,
      usage: null,
    });
  });

  it("treats explicit null usage as unavailable", () => {
    expect(
      parseSpsModelTextResponse({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [] }],
        usage: null,
      }),
    ).toEqual({ status: "completed", text: "", refusal: null, usage: null });
  });

  it("rejects completed responses with no assistant message", () => {
    expect(() => parseSpsModelTextResponse({ status: "completed", output: [] })).toThrow(
      "Invalid model response",
    );
  });

  it("rejects tool and unknown output items", () => {
    for (const type of ["function_call", "web_search_call", "unknown"]) {
      expect(() =>
        parseSpsModelTextResponse({ status: "incomplete", output: [{ type }] }),
      ).toThrow("Invalid model response");
    }
  });

  it.each([
    [null, "root must be an object"],
    [[], "root must not be an array"],
    [{ status: "failed", output: [] }, "status must be supported"],
    [{ status: "incomplete", output: {} }, "output must be an array"],
    [{ status: "incomplete", output: [null] }, "output item must be an object"],
    [{ status: "incomplete", output: [{}] }, "output item type is required"],
    [{ status: "incomplete", output: [{ type: "message", role: "user", content: [] }] }, "role must be assistant"],
    [{ status: "incomplete", output: [{ type: "message", role: "assistant" }] }, "message content is required"],
    [{ status: "incomplete", output: [{ type: "message", role: "assistant", content: {} }] }, "content must be an array"],
    [{ status: "incomplete", output: [{ type: "message", role: "assistant", content: [null] }] }, "content part must be an object"],
    [{ status: "incomplete", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: 1 }] }] }, "text must be a string"],
    [{ status: "incomplete", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: null }] }] }, "refusal must be a string"],
  ])("rejects malformed response data (%s)", (value) => {
    expect(() => parseSpsModelTextResponse(value)).toThrow("Invalid model response");
  });

  it.each([
    [{ input_tokens: 0, output_tokens: 0 }, "missing total"],
    ["usage details", "usage must be an object"],
    [{ input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0, total_tokens: 0 }, "unsafe input"],
    [{ input_tokens: 0, output_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: 0 }, "unsafe output"],
    [{ input_tokens: 1, output_tokens: 2, total_tokens: 4 }, "mismatched total"],
    [{ input_tokens: -1, output_tokens: 2, total_tokens: 1 }, "negative count"],
    [{ input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 }, "fractional count"],
    [{ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER }, "unsafe sum"],
  ])("rejects invalid usage (%s)", (usage) => {
    expect(() =>
      parseSpsModelTextResponse({
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [] }],
        usage,
      }),
    ).toThrow("Invalid model response");
  });

  it("does not include malformed input in its error", () => {
    const secret = "do-not-echo-this-secret";
    try {
      parseSpsModelTextResponse({
        status: "completed",
        output: [{ type: "message", role: "user", content: [secret] }],
      });
      throw new Error("Expected response parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Invalid model response");
      expect((error as Error).message).not.toContain(secret);
    }
  });
});
