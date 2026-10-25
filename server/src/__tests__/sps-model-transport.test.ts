import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsModelTextTransport, SpsModelTransportError, type SpsModelTextTransportConfiguration } from "../services/sps-model-transport.js";

const credential = "fake-model-credential-for-transport-tests-only";
const success = { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Mock result" }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } };
const configuration: SpsModelTextTransportConfiguration = { endpoint: "https://provider.example/v1/responses", model: "host-selected-test-model" };
const request = { input: "Inspect this mock text", credential };
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  }
});
async function mockProvider(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/responses`;
}
function jsonResponse(value = success) { return Response.json(value); }
function mockTransport(fetch: typeof globalThis.fetch, overrides: Partial<SpsModelTextTransportConfiguration> = {}) {
  return createSpsModelTextTransport({ ...configuration, ...overrides }, { fetch });
}
async function expectSafeError(pending: Promise<unknown>, code: string, effects = "unknown") {
  try { await pending; throw new Error("Expected transport rejection"); } catch (error) {
    expect(error).toBeInstanceOf(SpsModelTransportError);
    expect(error).toMatchObject({ code, externalEffects: effects });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(String(error)).not.toMatch(/private-provider|private-body|provider\.example|fake-model-credential/);
  }
}

describe("Host-only bounded model text transport", () => {
  it("performs a real local HTTP request with an explicit opt-in, minimal output and no provider storage/tools", async () => {
    const observed: { url?: string; method?: string; auth?: string; body?: Record<string, unknown> } = {};
    const endpoint = await mockProvider(async (req, res) => {
      observed.url = req.url; observed.method = req.method; observed.auth = req.headers.authorization;
      let body = ""; for await (const chunk of req) body += chunk;
      observed.body = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...success, id: "not-returned", metadata: { secret: "private-provider-metadata" } }));
    });
    const transport = createSpsModelTextTransport({ ...configuration, endpoint, allowLoopbackHttp: true, maxOutputTokens: 128 });
    expect(await transport.request(request)).toEqual({ status: "completed", text: "Mock result", refusal: null, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    expect(observed).toEqual({ url: "/v1/responses", method: "POST", auth: `Bearer ${credential}`, body: {
      model: configuration.model, input: request.input, max_output_tokens: 128, store: false, stream: false,
      background: false, tools: [], tool_choice: "none", parallel_tool_calls: false,
    } });
    expect(JSON.stringify(observed.body)).not.toContain(credential);
  });

  it.each([
    "http://provider.example/v1/responses", "http://127.0.0.1/v1/responses", "file:///private-provider",
    "https://user:password@provider.example/v1/responses", "https://provider.example/v1/responses?key=private-body",
    "https://provider.example/v1/responses#private-body", " https://provider.example/v1/responses",
    "https://provider.example/\nresponses", "https://provider.example\\private-provider", "not-a-url",
  ])("rejects invalid or unauthenticated endpoint configuration before fetch: %s", endpoint => {
    const fetch = vi.fn();
    expect(() => mockTransport(fetch, { endpoint })).toThrow("Invalid Host model transport configuration");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("limits the HTTP exception to explicitly configured loopback destinations", () => {
    for (const endpoint of ["http://provider.example/v1/responses", "http://127.0.0.2/v1/responses", "http://localhost.evil.example/v1/responses"]) {
      expect(() => mockTransport(vi.fn(), { endpoint, allowLoopbackHttp: true })).toThrow(SpsModelTransportError);
    }
    for (const endpoint of ["http://127.0.0.1/v1/responses", "http://localhost/v1/responses", "http://[::1]/v1/responses"]) {
      expect(() => mockTransport(vi.fn(), { endpoint, allowLoopbackHttp: true })).not.toThrow();
    }
  });
  it.each([
    { timeoutMs: Infinity }, { timeoutMs: 999 }, { timeoutMs: 120_001 }, { timeoutMs: 1_000.5 },
    { maxOutputTokens: 0 }, { maxOutputTokens: NaN }, { maxResponseBytes: 4_194_305 }, { maxRequestBytes: -1 },
    { maxConcurrentRequests: 0 }, { maxConcurrentRequests: 17 }, { model: "" }, { model: "test\nsecret" },
  ])("rejects unbounded limits or malformed model configuration: %j", overrides => {
    expect(() => mockTransport(vi.fn(), overrides)).toThrow(SpsModelTransportError);
  });
  it("limits the aggregate request/response buffer budget, not just each individual response", () => {
    expect(() => mockTransport(vi.fn(), { maxResponseBytes: 4_194_304, maxConcurrentRequests: 16 })).toThrow(SpsModelTransportError);
    expect(() => mockTransport(vi.fn(), { maxRequestBytes: 262_144, maxResponseBytes: 262_144, maxConcurrentRequests: 16 })).not.toThrow();
    expect(() => mockTransport(vi.fn(), { maxRequestBytes: 262_145, maxResponseBytes: 262_144, maxConcurrentRequests: 16 })).toThrow(SpsModelTransportError);
  });
  it("snapshots Host configuration rather than taking endpoint or model overrides on a request", async () => {
    const input = { ...configuration };
    const fetch = vi.fn(async () => jsonResponse());
    const transport = createSpsModelTextTransport(input, { fetch });
    input.endpoint = "https://private-provider.invalid"; input.model = "changed";
    await transport.request({ ...request, endpoint: input.endpoint, model: input.model } as typeof request);
    expect(fetch.mock.calls[0]?.[0]).toBe(configuration.endpoint);
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string).model).toBe(configuration.model);
  });
  it("pins an explicitly allowed HTTP localhost destination to numeric loopback", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());
    await mockTransport(fetch, { endpoint: "http://localhost:12345/v1/responses", allowLoopbackHttp: true }).request(request);
    expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:12345/v1/responses");
  });
  it("rejects empty, oversized, multibyte oversized input and malformed credentials without dispatch", async () => {
    const fetch = vi.fn(); const transport = mockTransport(fetch, { maxRequestBytes: 256 });
    for (const value of [{ ...request, input: " " }, { ...request, input: "a".repeat(257) }, { ...request, input: "한".repeat(85) },
      { ...request, credential: "" }, { ...request, credential: "secret\r\ninjected" }, { ...request, credential: "contains spaces" }]) {
      await expectSafeError(transport.request(value), "invalid_request", "not_dispatched");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not dispatch a pre-cancelled request or propagate its abort reason", async () => {
    const fetch = vi.fn(); const controller = new AbortController(); controller.abort(new Error(credential));
    await expectSafeError(mockTransport(fetch).request({ ...request, signal: controller.signal }), "cancelled", "not_dispatched");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never follows a real HTTP redirect carrying credentials", async () => {
    let calls = 0;
    const endpoint = await mockProvider((_req, res) => { calls += 1; res.writeHead(307, { location: "/private-provider" }); res.end(credential); });
    const transport = createSpsModelTextTransport({ ...configuration, endpoint, allowLoopbackHttp: true });
    await expectSafeError(transport.request(request), "http_error");
    expect(calls).toBe(1);
  });
  it.each([401, 403, 429, 500, 503])("does not retry or disclose the provider error body (%i)", async status => {
    const fetch = vi.fn(async () => new Response(`${credential}: private-body`, { status }));
    await expectSafeError(mockTransport(fetch).request(request), "http_error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry a network failure after possible provider effects", async () => {
    const fetch = vi.fn(async () => { throw new Error(`https://private-provider/${credential}`); });
    await expectSafeError(mockTransport(fetch).request(request), "network_error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not retry a lost body after provider completion", async () => {
    let calls = 0;
    const endpoint = await mockProvider((_req, res) => {
      calls += 1; res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.flushHeaders(); res.write('{"status":"completed","output":');
      setTimeout(() => res.destroy(), 10);
    });
    await expectSafeError(createSpsModelTextTransport({ ...configuration, endpoint, allowLoopbackHttp: true }).request(request), "invalid_response");
    expect(calls).toBe(1);
  });
  it("rejects an oversized declared or chunked body", async () => {
    const oversized = "x".repeat(257);
    for (const headers of [{ "content-type": "application/json", "content-length": "257" }, { "content-type": "application/json" }]) {
      const fetch = vi.fn(async () => new Response(oversized, { headers }));
      await expectSafeError(mockTransport(fetch, { maxResponseBytes: 256 }).request(request), "response_too_large");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });
  it("enforces the body limit after network content decoding", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new Uint8Array(256)); controller.enqueue(new Uint8Array(1));
    }, cancel }), { headers: { "content-type": "application/json" } }));
    await expectSafeError(mockTransport(fetch, { maxResponseBytes: 256 }).request(request), "response_too_large");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([
    new Response("private-body", { headers: { "content-type": "text/plain" } }),
    new Response('{"status":', { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { "content-type": "application/json" } }),
    Response.json({ ...success, output: [{ type: "function_call", arguments: credential }] }),
  ])("sanitizes invalid MIME, JSON, UTF-8 and unsupported tool output", async response => {
    await expectSafeError(mockTransport(vi.fn(async () => response)).request(request), "invalid_response");
  });
  it("rejects a credential echoed in text or refusal rather than returning it", async () => {
    for (const part of [{ type: "output_text", text: credential }, { type: "refusal", refusal: credential }]) {
      const payload = { ...success, output: [{ type: "message", role: "assistant", content: [part] }] };
      await expectSafeError(mockTransport(vi.fn(async () => Response.json(payload))).request(request), "credential_echo");
    }
  });
  it("keeps absent usage unknown instead of inventing zero tokens or a price", async () => {
    const { usage: _usage, ...payload } = success;
    const result = await mockTransport(vi.fn(async () => Response.json(payload))).request(request);
    expect(result.usage).toBeNull(); expect(result).not.toHaveProperty("cost");
  });
  it("caps local concurrency and frees the slot after a cancelled fetch that ignores AbortSignal", async () => {
    const controller = new AbortController();
    let finish: ((value: Response) => void) | undefined;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const transport = mockTransport(fetch);
    const pending = transport.request({ ...request, signal: controller.signal });
    await expectSafeError(transport.request(request), "busy", "not_dispatched");
    controller.abort(new Error(credential));
    await expectSafeError(pending, "cancelled");
    const lateCancel = vi.fn();
    finish!(new Response(new ReadableStream({ cancel: lateCancel }), { headers: { "content-type": "application/json" } }));
    await new Promise(resolve => setTimeout(resolve, 0)); expect(lateCancel).toHaveBeenCalledOnce();
    fetch.mockImplementationOnce(async () => jsonResponse());
    await expect(transport.request(request)).resolves.toMatchObject({ text: "Mock result" });
  });
  it("bounds a hanging fetch and does not retry it", async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => undefined));
    await expectSafeError(mockTransport(fetch, { timeoutMs: 1_000 }).request(request), "timed_out");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("bounds credential resolution before dispatch and prevents a late resolution from starting a request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());
    let finish: ((value: string) => void) | undefined;
    const resolver = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const transport = mockTransport(fetch, { timeoutMs: 1_000 });
    const pending = transport.request({ ...request, credential: resolver });
    await expectSafeError(pending, "timed_out", "not_dispatched");
    await expectSafeError(transport.request(request), "busy", "not_dispatched");
    finish!(credential); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled(); expect(resolver).toHaveBeenCalledOnce();
    expect(resolver.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
    await expect(transport.request(request)).resolves.toMatchObject({ text: "Mock result" });
  });
  it("cancels credential resolution locally and blocks concurrent resolution at the same limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse()); const controller = new AbortController();
    const resolver = vi.fn(() => new Promise<string>(() => undefined)); const transport = mockTransport(fetch);
    const pending = transport.request({ ...request, credential: resolver, signal: controller.signal });
    await expectSafeError(transport.request({ ...request, credential: resolver }), "busy", "not_dispatched");
    controller.abort(); await expectSafeError(pending, "cancelled", "not_dispatched");
    expect(resolver).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it("scopes concurrency to one Host-created instance, without claiming a process-wide or distributed quota", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse()); const controller = new AbortController();
    let fail: ((reason: Error) => void) | undefined;
    const resolver = () => new Promise<string>((_resolve, reject) => { fail = reject; });
    const first = mockTransport(fetch), second = mockTransport(fetch);
    const pending = first.request({ ...request, credential: resolver, signal: controller.signal });
    controller.abort(); await expectSafeError(pending, "cancelled", "not_dispatched");
    await expectSafeError(first.request(request), "busy", "not_dispatched");
    await expect(second.request(request)).resolves.toMatchObject({ text: "Mock result" });
    fail!(new Error(credential)); await new Promise(resolve => setTimeout(resolve, 0));
    await expect(first.request(request)).resolves.toMatchObject({ text: "Mock result" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("sanitizes resolver exceptions and rejects invalid resolved credentials before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse()); const transport = mockTransport(fetch);
    for (const resolver of [async () => { throw new Error(`private-provider-${credential}`); }, async () => "", async () => "injected\r\nheader"]) {
      await expectSafeError(transport.request({ ...request, credential: resolver }), "credential_unavailable", "not_dispatched");
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("bounds a stalled body and records only local cancellation, not upstream termination", async () => {
    const controller = new AbortController(); const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { "content-type": "application/json" } }));
    const pending = mockTransport(fetch).request({ ...request, signal: controller.signal });
    await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    await expectSafeError(pending, "cancelled");
    expect(cancel).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  });
});
