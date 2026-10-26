import { constants } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders,
  type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { createSpsNativeSessionExchangeRequestHandler } from "../services/sps-native-session-exchange-http.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";

const PATH = "/sps-native/v1/session/exchange";
const FAILURE_CODE = "native_session_exchange_unavailable";
const ACCESS_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.Zml4dHVyZS1zaWduYXR1cmU";
const SESSION_TOKEN = "s".repeat(64);
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const EXCHANGE_RESULT = Object.freeze({
  profile: Object.freeze({ subject: "fixture-subject", email: "member@example.test", name: "Fixture Member", picture: null }),
  token: SESSION_TOKEN,
  expiresInSeconds: SESSION_TTL_SECONDS,
});
type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "exchangeSession">;
type Limits = { readTimeoutMs: number; operationTimeoutMs: number; maxConcurrentRequests: number };
type ResponseResult = { status: number; headers: IncomingHttpHeaders; body: unknown; rawBody: string };
type RequestOptions = { path?: string; method?: string; headers?: Record<string, string | undefined>; tlsVersion?: "TLSv1.2" | "TLSv1.3";
  port?: number; session?: Buffer; onSession?: (session: Buffer) => void; onSecureConnect?: (reused: boolean) => void };
const DEFAULT_LIMITS: Limits = Object.freeze({ readTimeoutMs: 1000, operationTimeoutMs: 2000, maxConcurrentRequests: 2 });

let fixture: MemberTlsFixture;
let tlsServer: HttpsServer;
let plainServer: HttpServer;
let port: number;
let plainPort: number;
let mountedHandler: ReturnType<typeof createSpsNativeSessionExchangeRequestHandler> | undefined;
const handlers = new Set<ReturnType<typeof createSpsNativeSessionExchangeRequestHandler>>();
const sockets = new Set<Socket>();

function trackSocket(socket: Socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
}

function listen(server: HttpServer | HttpsServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Loopback fixture did not bind a TCP port."));
      resolve(address.port);
    });
  });
}

function closed(server: HttpServer | HttpsServer): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function createIdentity(action?: Identity["exchangeSession"]) {
  const exchangeSession = vi.fn(action ?? (async (_token, _metadata, assertActive) => {
    assertActive?.();
    return EXCHANGE_RESULT;
  }));
  return { identity: { exchangeSession } as unknown as Identity, exchangeSession };
}

function installHandler(action?: Identity["exchangeSession"], limits: Limits = DEFAULT_LIMITS) {
  const mocks = createIdentity(action);
  const handler = createSpsNativeSessionExchangeRequestHandler(mocks.identity, { ...limits });
  mountedHandler = handler;
  handlers.add(handler);
  return { ...mocks, handler };
}

function parseResponse(status: number, headers: IncomingHttpHeaders, bytes: Buffer): ResponseResult {
  const rawBody = bytes.toString("utf8");
  let body: unknown = rawBody;
  try { body = JSON.parse(rawBody); } catch { /* Preserve malformed output for an assertion. */ }
  return { status, headers, body, rawBody };
}

function requestTls(options: RequestOptions = {}): Promise<ResponseResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Length": "0",
    Connection: "close",
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port: options.port ?? port, path: options.path ?? PATH,
      method: options.method ?? "POST", agent: false, ca: fixture.certPem,
      // HTTPS forwards this TLS option; the resumed-handshake assertion below
      // verifies that forwarding rather than relying on an untyped claim.
      ...(options.session ? { session: options.session } : {}),
      minVersion: options.tlsVersion ?? "TLSv1.3", maxVersion: options.tlsVersion ?? "TLSv1.3", headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve(parseResponse(response.statusCode ?? 0, response.headers, Buffer.concat(chunks))));
    });
    request.once("socket", socket => {
      trackSocket(socket);
      if (options.onSession) (socket as TLSSocket).on("session", options.onSession);
      if (options.onSecureConnect) socket.once("secureConnect", () => options.onSecureConnect!((socket as TLSSocket).isSessionReused()));
    });
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("TLS fixture request timed out.")));
    request.end();
  });
}

function requestPlainHttp(): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: plainPort, path: PATH, method: "POST",
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Length": "0", Connection: "close" } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve(parseResponse(response.statusCode ?? 0, response.headers, Buffer.concat(chunks))));
    });
    request.once("socket", trackSocket);
    request.once("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Plain HTTP fixture request timed out.")));
    request.end();
  });
}

function rawTlsRequest(path: string, headerLines: string[], body = Buffer.alloc(0)):
Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({ host: "127.0.0.1", port, servername: "localhost", ca: fixture.certPem,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true });
    trackSocket(socket);
    const chunks: Buffer[] = [];
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks), split = raw.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`TLS fixture returned no complete response: ${raw.toString("utf8")}`));
      const head = raw.subarray(0, split).toString("latin1");
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
      const headers: IncomingHttpHeaders = {};
      for (const line of head.split("\r\n").slice(1)) {
        const separator = line.indexOf(":");
        if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve(parseResponse(status, headers, raw.subarray(split + 4)));
    };
    const timeout = setTimeout(() => socket.destroy(new Error("Raw TLS fixture request timed out.")), 8000);
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("end", finish);
    socket.once("close", () => { if (chunks.length) finish(); });
    socket.once("error", error => {
      if (chunks.length) finish();
      else if (!completed) { completed = true; clearTimeout(timeout); reject(error); }
    });
    socket.once("secureConnect", () => {
      const head = [`POST ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", ...headerLines, "", ""].join("\r\n");
      socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
    });
  });
}

function expectFailure(response: ResponseResult, status: number) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ code: FAILURE_CODE });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.connection?.toLowerCase()).toBe("close");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["set-cookie"]).toBeUndefined();
}

function expectCommonHeaders(response: ResponseResult) {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers.connection?.toLowerCase()).toBe("close");
  expect(response.headers["x-content-type-options"]).toBe("nosniff");
  expect(response.headers["content-type"]).toMatch(/^application\/json; charset=utf-8$/i);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("SPS Native session exchange HTTP handler (inactive TLS ingress)", () => {
  beforeAll(async () => {
    fixture = await createMemberTlsFixture({ purpose: "serverAuth" });
    tlsServer = createHttpsServer({ key: fixture.keyPem, cert: fixture.certPem,
      minVersion: "TLSv1.2", maxVersion: "TLSv1.3", secureOptions: constants.SSL_OP_NO_TICKET,
      maxHeaderSize: 64 * 1024 }, (request, response) => {
      if (!mountedHandler) { response.destroy(); return; }
      mountedHandler.handle(request, response);
    });
    plainServer = createHttpServer((request, response) => {
      if (!mountedHandler) { response.destroy(); return; }
      mountedHandler.handle(request, response);
    });
    tlsServer.on("connection", trackSocket);
    plainServer.on("connection", trackSocket);
    tlsServer.on("tlsClientError", () => {});
    port = await listen(tlsServer);
    plainPort = await listen(plainServer);
  }, 20_000);

  afterEach(() => {
    for (const handler of handlers) handler.dispose();
    handlers.clear();
    mountedHandler = undefined;
    for (const socket of sockets) socket.destroy();
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([closed(tlsServer), closed(plainServer)]);
    await fixture?.cleanup();
  });

  it("creates only the existing cookie session projection over fresh TLS 1.3", async () => {
    const harness = installHandler();
    const response = await requestTls({ headers: { "Content-Type": "application/json; charset=utf-8",
      "User-Agent": "Fixture Native Client" } });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ expiresInSeconds: SESSION_TTL_SECONDS });
    expect(response.rawBody).not.toContain(SESSION_TOKEN);
    expect(response.rawBody).not.toContain("member@example.test");
    expect(response.headers["set-cookie"]).toEqual([
      `sps_identity_session=${SESSION_TOKEN}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expectCommonHeaders(response);
    expect(harness.exchangeSession).toHaveBeenCalledTimes(1);
    expect(harness.exchangeSession.mock.calls[0]?.[0]).toBe(ACCESS_TOKEN);
    expect(harness.exchangeSession.mock.calls[0]?.[1]).toEqual({ ipAddress: expect.any(String), userAgent: null });
    expect(harness.exchangeSession.mock.calls[0]?.[2]).toEqual(expect.any(Function));
  });

  it("accepts only the exact path, POST, empty body framing, and a single bounded bearer JWT", async () => {
    const harness = installHandler();
    expectFailure(await requestTls({ path: `${PATH}?extra=1` }), 404);
    expectFailure(await requestTls({ path: "/unknown" }), 404);
    expectFailure(await requestTls({ method: "GET" }), 403);
    expectFailure(await requestTls({ headers: { Authorization: undefined } }), 401);
    expectFailure(await requestTls({ headers: { Authorization: "Bearer one.two" } }), 401);
    expectFailure(await requestTls({ headers: { Authorization: `Bearer ${"a".repeat(8192)}.b.c` } }), 401);
    expectFailure(await rawTlsRequest(PATH, ["Authorization: Bearer one.two.three", "Authorization: Bearer four.five.six",
      "Content-Length: 0"]), 401);
    expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Content-Length: 00"]), 400);
    expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`]), 400);
    expectFailure(await requestTls({ headers: { "Content-Type": "text/plain" } }), 400);
    expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Content-Length: 1"], Buffer.from("x")), 400);
    expect(harness.exchangeSession).not.toHaveBeenCalled();
  });

  it("rejects browser, cookie, proxy-auth, transfer and content-encoding metadata before identity", async () => {
    const harness = installHandler();
    for (const header of ["Origin: https://fixture.example.test", "Referer: https://fixture.example.test/",
      "Sec-Fetch-Site: same-origin", "Sec-Fetch-Mode: cors", "Cookie: sps_identity_session=old",
      "Proxy-Authorization: Basic fixture", "Proxy-Authenticate: Basic", "Content-Encoding: gzip"]) {
      expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Content-Length: 0", header]), 403);
    }
    expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Transfer-Encoding: chunked"],
      Buffer.from("0\r\n\r\n")), 403);
    expectFailure(await requestPlainHttp(), 403);
    expectFailure(await requestTls({ tlsVersion: "TLSv1.2" }), 403);
    expect(harness.exchangeSession).not.toHaveBeenCalled();
  });

  it("rejects an actually resumed TLS 1.3 connection before identity exchange", async () => {
    const harness = installHandler();
    // This separate fixture deliberately enables tickets; the ordinary fixture
    // disables them and therefore cannot exercise an actual resumed handshake.
    const resumable = createHttpsServer({ key: fixture.keyPem, cert: fixture.certPem,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, harness.handler.handle);
    resumable.on("connection", trackSocket);
    resumable.on("tlsClientError", () => {});
    const resumedPort = await listen(resumable);
    let ticket: Buffer | undefined;
    try {
      const first = await requestTls({ port: resumedPort, onSession(value) { ticket = value; } });
      expect(first.status).toBe(201);
      expect(ticket?.length).toBeGreaterThan(0);
      let reused = false;
      expectFailure(await requestTls({ port: resumedPort, session: ticket, onSecureConnect(value) { reused = value; } }), 403);
      expect(reused).toBe(true);
      expect(harness.exchangeSession).toHaveBeenCalledTimes(1);
    } finally { await closed(resumable); }
  });

  it("bounds raw headers and validates explicit constructor limits", async () => {
    const harness = installHandler();
    const many = Array.from({ length: 64 }, (_, index) => `X-Fill-${index}: x`);
    expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Content-Length: 0", ...many]), 400);
    expectFailure(await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Content-Length: 0",
      `X-Fill: ${"x".repeat(16_300)}`]), 400);
    expect(harness.exchangeSession).not.toHaveBeenCalled();

    for (const invalid of [
      { readTimeoutMs: 99, operationTimeoutMs: 500, maxConcurrentRequests: 1 },
      { readTimeoutMs: 10_001, operationTimeoutMs: 500, maxConcurrentRequests: 1 },
      { readTimeoutMs: 100, operationTimeoutMs: 499, maxConcurrentRequests: 1 },
      { readTimeoutMs: 100, operationTimeoutMs: 60_001, maxConcurrentRequests: 1 },
      { readTimeoutMs: 100, operationTimeoutMs: 500, maxConcurrentRequests: 0 },
      { readTimeoutMs: 100, operationTimeoutMs: 500, maxConcurrentRequests: 1.5 },
      { readTimeoutMs: 100, operationTimeoutMs: 500, maxConcurrentRequests: 1, extra: true },
    ]) {
      expect(() => createSpsNativeSessionExchangeRequestHandler(harness.identity, invalid)).toThrow(TypeError);
    }
  });

  it("maps identity failures to a fixed 401 without returning token, profile or cookie", async () => {
    const harness = installHandler(async () => { throw new Error("sensitive account and token detail"); });
    const response = await requestTls();
    expectFailure(response, 401);
    expect(response.rawBody).not.toContain("sensitive");
    expect(harness.exchangeSession).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed identity results without projecting profile or credentials", async () => {
    const harness = installHandler(async (_token, _metadata, assertActive) => {
      assertActive?.();
      return { ...EXCHANGE_RESULT, token: "not-a-session-token" };
    });
    const response = await requestTls();
    expectFailure(response, 503);
    expect(response.rawBody).not.toContain("fixture-subject");
    expect(response.rawBody).not.toContain("not-a-session-token");
  });

  it("times out without releasing capacity until ignored identity work settles", async () => {
    const held = deferred<void>(), started = deferred<void>();
    let calls = 0;
    const harness = installHandler(async (_token, _metadata, assertActive) => {
      calls++;
      assertActive?.();
      started.resolve();
      if (calls === 1) await held.promise;
      assertActive?.();
      return EXCHANGE_RESULT;
    }, { ...DEFAULT_LIMITS, operationTimeoutMs: 500, maxConcurrentRequests: 1 });
    const pending = requestTls();
    try {
      await started.promise;
      expectFailure(await pending, 408);
      expectFailure(await requestTls(), 429);
      expect(calls).toBe(1);
      held.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      const next = await requestTls();
      expect(next.status).toBe(201);
      expect(calls).toBe(2);
    } finally { held.resolve(); }
    expect(harness.exchangeSession).toHaveBeenCalledTimes(2);
  });

  it("disposal fences guards and suppresses late cookies while retaining the active slot", async () => {
    const held = deferred<void>(), started = deferred<void>();
    let lateGuard: (() => void) | undefined;
    const harness = installHandler(async (_token, _metadata, assertActive) => {
      lateGuard = assertActive;
      started.resolve();
      await held.promise;
      assertActive?.();
      return EXCHANGE_RESULT;
    }, { ...DEFAULT_LIMITS, maxConcurrentRequests: 1 });
    const pending = requestTls();
    try {
      await started.promise;
      harness.handler.dispose();
      expectFailure(await pending, 503);
      expect(lateGuard).toEqual(expect.any(Function));
      expect(() => lateGuard?.()).toThrow();
      expectFailure(await requestTls(), 503);
      held.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(harness.exchangeSession).toHaveBeenCalledTimes(1);
    } finally { held.resolve(); }
  });

  it("accepts an empty framed request without waiting for TLS socket EOF", async () => {
    const harness = installHandler(undefined, { ...DEFAULT_LIMITS, readTimeoutMs: 100 });
    const response = await rawTlsRequest(PATH, [`Authorization: Bearer ${ACCESS_TOKEN}`, "Content-Length: 0"]);
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ expiresInSeconds: SESSION_TTL_SECONDS });
    expectCommonHeaders(response);
    expect(harness.exchangeSession).toHaveBeenCalledTimes(1);
  });
});
