export type SpsModelTextResponse = {
  status: "completed" | "incomplete";
  text: string;
  refusal: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
};

const INVALID_RESPONSE_MESSAGE = "Invalid model response";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function invalidResponse(): never {
  throw new Error(INVALID_RESPONSE_MESSAGE);
}

function parseUsage(value: unknown): SpsModelTextResponse["usage"] {
  if (value === null) return null;
  if (!isRecord(value)) return invalidResponse();

  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  const totalTokens = value.total_tokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0 ||
    !Number.isSafeInteger(totalTokens) ||
    (totalTokens as number) < 0
  ) {
    return invalidResponse();
  }

  const expectedTotal = (inputTokens as number) + (outputTokens as number);
  if (!Number.isSafeInteger(expectedTotal) || totalTokens !== expectedTotal) {
    return invalidResponse();
  }

  return {
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    totalTokens: totalTokens as number,
  };
}

function parseResponse(value: unknown): SpsModelTextResponse {
  if (!isRecord(value)) return invalidResponse();

  const status = value.status;
  if (status !== "completed" && status !== "incomplete") {
    return invalidResponse();
  }
  if (!Array.isArray(value.output)) return invalidResponse();

  let messageCount = 0;
  let text = "";
  let refusal: string | null = null;

  for (const outputItem of value.output) {
    if (!isRecord(outputItem) || typeof outputItem.type !== "string") {
      return invalidResponse();
    }

    if (outputItem.type === "reasoning") continue;
    if (outputItem.type !== "message" || outputItem.role !== "assistant") {
      return invalidResponse();
    }
    if (!Array.isArray(outputItem.content)) return invalidResponse();

    messageCount += 1;
    for (const contentPart of outputItem.content) {
      if (!isRecord(contentPart) || typeof contentPart.type !== "string") {
        return invalidResponse();
      }

      if (contentPart.type === "output_text") {
        if (typeof contentPart.text !== "string") return invalidResponse();
        text += contentPart.text;
      } else if (contentPart.type === "refusal") {
        if (typeof contentPart.refusal !== "string") return invalidResponse();
        refusal = (refusal ?? "") + contentPart.refusal;
      } else {
        return invalidResponse();
      }
    }
  }

  if (status === "completed" && messageCount === 0) return invalidResponse();

  let usage: SpsModelTextResponse["usage"] = null;
  if (hasOwn(value, "usage") && value.usage !== null) {
    usage = parseUsage(value.usage);
  }

  return { status, text, refusal, usage };
}

export function parseSpsModelTextResponse(value: unknown): SpsModelTextResponse {
  try {
    return parseResponse(value);
  } catch {
    return invalidResponse();
  }
}
