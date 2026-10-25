import { parseSpsModelTextResponse, type SpsModelTextResponse } from "./sps-model-response.js";

export interface SpsModelTextTransportConfiguration {
  /** Exact Host-selected endpoint, never a Plugin request parameter. */
  endpoint: string;
  model: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  maxConcurrentRequests?: number;
  /** Explicit Host opt-in for a loopback mock/local provider; never inferred from an environment variable. */
  allowLoopbackHttp?: boolean;
}

export type SpsModelTransportErrorCode =
  | "invalid_configuration" | "invalid_request" | "busy" | "cancelled" | "timed_out"
  | "network_error" | "http_error" | "invalid_response" | "response_too_large" | "credential_echo" | "credential_unavailable";

const errorMessages: Record<SpsModelTransportErrorCode, string> = {
  invalid_configuration: "Invalid Host model transport configuration",
  invalid_request: "Invalid model request",
  busy: "Model transport is at its concurrency limit",
  cancelled: "Model request was cancelled locally; upstream completion is not confirmed",
  timed_out: "Model request timed out; upstream completion is not confirmed",
  network_error: "Model transport failed; upstream completion is not confirmed",
  http_error: "Model endpoint rejected the request",
  invalid_response: "Invalid model response",
  response_too_large: "Model response exceeds the configured limit",
  credential_echo: "Model response contains credential material",
  credential_unavailable: "Bound model credential is unavailable",
};

export class SpsModelTransportError extends Error {
  constructor(
    readonly code: SpsModelTransportErrorCode,
    readonly externalEffects: "not_dispatched" | "unknown",
    readonly httpStatus: number | null = null,
  ) {
    super(errorMessages[code]);
    this.name = "SpsModelTransportError";
  }
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new SpsModelTransportError("invalid_configuration", "not_dispatched");
  }
  return result;
}

function readConfiguration(input: SpsModelTextTransportConfiguration) {
  let endpoint: URL;
  try { endpoint = new URL(input.endpoint); } catch {
    throw new SpsModelTransportError("invalid_configuration", "not_dispatched");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (typeof input.endpoint !== "string" || input.endpoint !== input.endpoint.trim()
    || /[\u0000-\u0020\u007f\\]/.test(input.endpoint)
    || endpoint.username || endpoint.password || endpoint.hash || endpoint.search
    || (endpoint.protocol !== "https:" && !(input.allowLoopbackHttp === true && endpoint.protocol === "http:" && loopback))
    || typeof input.model !== "string" || !input.model.trim() || input.model !== input.model.trim()
    || input.model.length > 160 || /[\u0000-\u001f\u007f]/.test(input.model)
    || (input.allowLoopbackHttp !== undefined && typeof input.allowLoopbackHttp !== "boolean")) {
    throw new SpsModelTransportError("invalid_configuration", "not_dispatched");
  }
  // The explicit HTTP localhost exception must not depend on external DNS/hosts-file resolution.
  if (endpoint.protocol === "http:" && endpoint.hostname === "localhost") endpoint.hostname = "127.0.0.1";
  const config = {
    endpoint: endpoint.href,
    model: input.model,
    timeoutMs: boundedInteger(input.timeoutMs, 30_000, 1_000, 120_000),
    maxOutputTokens: boundedInteger(input.maxOutputTokens, 1_024, 1, 32_768),
    maxRequestBytes: boundedInteger(input.maxRequestBytes, 65_536, 256, 1_048_576),
    maxResponseBytes: boundedInteger(input.maxResponseBytes, 1_048_576, 256, 4_194_304),
    maxConcurrentRequests: boundedInteger(input.maxConcurrentRequests, 1, 1, 16),
  };
  if ((config.maxRequestBytes + config.maxResponseBytes) * config.maxConcurrentRequests > 8_388_608) {
    throw new SpsModelTransportError("invalid_configuration", "not_dispatched");
  }
  return Object.freeze(config);
}

function awaitAbortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new Error("Model transport aborted")); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  });
}

async function discardBody(response: Response) {
  try { await response.body?.cancel(); } catch { /* Already consumed or locked. */ }
}

async function readBoundedJson(response: Response, limit: number, signal: AbortSignal) {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await discardBody(response);
    throw new SpsModelTransportError("response_too_large", "unknown");
  }
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers.get("content-type") ?? "") || !response.body) {
    await discardBody(response);
    throw new SpsModelTransportError("invalid_response", "unknown");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(limit);
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const part = await awaitAbortable(reader.read(), signal);
      if (part.done) { complete = true; break; }
      if (part.value.byteLength > limit - total) throw new SpsModelTransportError("response_too_large", "unknown");
      bytes.set(part.value, total);
      total += part.value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, total))) as unknown;
  } finally {
    if (!complete) { try { await reader.cancel(); } catch { /* Stream already failed. */ } }
    try { reader.releaseLock(); } catch { /* An aborted read can still be pending. */ }
  }
}

/**
 * Host-internal, text-only transport foundation. Not a Plugin capability or credential broker.
 * The caller must authorize every call and provide a bound credential or resolver. No retries, tools,
 * sessions, routing fallback, usage pricing or upstream termination claims are implemented here.
 */
export function createSpsModelTextTransport(
  configuration: SpsModelTextTransportConfiguration,
  dependencies: { fetch?: typeof globalThis.fetch } = {},
) {
  const config = readConfiguration(configuration);
  const fetchResponse = dependencies.fetch ?? globalThis.fetch;
  let active = 0;
  return Object.freeze({
    async request(input: { input: string; credential: string | ((signal: AbortSignal) => Promise<string>); signal?: AbortSignal }): Promise<SpsModelTextResponse> {
      if (typeof input.input !== "string" || input.input.length > config.maxRequestBytes || !input.input.trim()
        || (typeof input.credential !== "function" && (typeof input.credential !== "string" || !/^[!-~]{1,8192}$/.test(input.credential)))
        || (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
        throw new SpsModelTransportError("invalid_request", "not_dispatched");
      }
      const body = JSON.stringify({
        model: config.model, input: input.input, max_output_tokens: config.maxOutputTokens,
        store: false, stream: false, background: false, tools: [], tool_choice: "none", parallel_tool_calls: false,
      });
      if (Buffer.byteLength(body, "utf8") > config.maxRequestBytes) {
        throw new SpsModelTransportError("invalid_request", "not_dispatched");
      }
      if (input.signal?.aborted) throw new SpsModelTransportError("cancelled", "not_dispatched");
      if (active >= config.maxConcurrentRequests) throw new SpsModelTransportError("busy", "not_dispatched");
      active += 1;
      const controller = new AbortController();
      let abortCode: "cancelled" | "timed_out" | null = null;
      let dispatched = false;
      let receivedHeaders = false;
      const pendingOperations = new Set<Promise<unknown>>();
      const track = <T>(pending: Promise<T>) => {
        pendingOperations.add(pending);
        const settled = () => { pendingOperations.delete(pending); };
        void pending.then(settled, settled);
        return pending;
      };
      const abort = (code: "cancelled" | "timed_out") => {
        if (abortCode === null) { abortCode = code; controller.abort(); }
      };
      const cancel = () => abort("cancelled");
      input.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => abort("timed_out"), config.timeoutMs);
      try {
        if (input.signal?.aborted) abort("cancelled");
        if (controller.signal.aborted) throw new Error("Model transport aborted");
        let credential: string;
        try {
          credential = typeof input.credential === "function"
            ? await awaitAbortable(track(input.credential(controller.signal)), controller.signal) : input.credential;
          if (typeof credential !== "string" || !/^[!-~]{1,8192}$/.test(credential)) throw new Error("Invalid credential");
        } catch {
          throw new SpsModelTransportError("credential_unavailable", "not_dispatched");
        }
        if (controller.signal.aborted) throw new Error("Model transport aborted");
        dispatched = true;
        const pending = track(fetchResponse(config.endpoint, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${credential}` },
          body, signal: controller.signal, redirect: "manual", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
        }).then(async response => {
          // Keep a late response and its cleanup accounted for if an instrumented fetch ignores abort.
          if (controller.signal.aborted) await discardBody(response);
          return response;
        }));
        const response = await awaitAbortable(pending, controller.signal);
        receivedHeaders = true;
        if (!response.ok) {
          await awaitAbortable(track(discardBody(response)), controller.signal);
          throw new SpsModelTransportError("http_error", "unknown", response.status);
        }
        const payload = await awaitAbortable(track(readBoundedJson(response, config.maxResponseBytes, controller.signal)), controller.signal);
        const result = parseSpsModelTextResponse(payload);
        if (controller.signal.aborted) throw new Error("Model transport aborted");
        if (result.text.includes(credential) || result.refusal?.includes(credential)) {
          throw new SpsModelTransportError("credential_echo", "unknown");
        }
        return result;
      } catch (error) {
        const effects = dispatched ? "unknown" : "not_dispatched";
        if (abortCode !== null) throw new SpsModelTransportError(abortCode, effects);
        if (error instanceof SpsModelTransportError) throw error;
        // Never propagate fetch URLs, provider bodies, credential resolver errors or Error.cause.
        throw new SpsModelTransportError(receivedHeaders ? "invalid_response" : "network_error", effects);
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", cancel);
        // Cancellation bounds the caller's wait, not a resolver/transport that ignores AbortSignal.
        // Such work keeps its slot until it and its cleanup actually settle (fail closed if it never does).
        if (pendingOperations.size > 0) void Promise.allSettled([...pendingOperations]).then(() => { active -= 1; });
        else active -= 1;
      }
    },
  });
}
