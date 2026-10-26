import { constants } from "node:crypto";
import { IncomingMessage, ServerResponse, createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SpsNativeEnrollmentError } from "../services/sps-native-enrollments.js";
import { SpsNativeSessionEnrollmentError } from "../services/sps-native-session-enrollment.js";
import { createSpsNativeEnrollmentRequestHandler } from "../services/sps-native-enrollment-http.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";

const ISSUE_PATH = "/sps-native/v1/enrollment/issue";
const COMPLETE_PATH = "/sps-native/v1/enrollment/complete";
const FAILURE_CODE = "native_enrollment_request_unavailable";
const COOKIE = "sps_identity_session=fixture-session";
const ISSUE_BODY = Object.freeze({
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingSecret: "fixture-pairing-secret",
  deviceKeyId: "22222222-2222-4222-8222-222222222222",
  requestPem: "fixture-csr",
});
const COMPLETE_BODY = Object.freeze({
  pairingId: ISSUE_BODY.pairingId,
  pairingSecret: ISSUE_BODY.pairingSecret,
  enrollmentId: "33333333-3333-4333-8333-333333333333",
  displayName: "Fixture device",
});
const ISSUE_RESULT = Object.freeze({
  enrollmentId: COMPLETE_BODY.enrollmentId,
  certificate: Buffer.from("fixture-cert").toString("base64url"),
  issuerCertificate: Buffer.from("fixture-issuer").toString("base64url"),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
type HandlerOptions = { maxBodyBytes: number; readTimeoutMs: number; operationTimeoutMs: number; maxConcurrentRequests: number };
const DEFAULT_OPTIONS: HandlerOptions = Object.freeze({
  maxBodyBytes: 8192,
  readTimeoutMs: 1000,
  operationTimeoutMs: 3000,
  maxConcurrentRequests: 2,
});

type RequestHandler = ReturnType<typeof createSpsNativeEnrollmentRequestHandler>;
type Adapter = Parameters<typeof createSpsNativeEnrollmentRequestHandler>[0];
type AdapterCall = (request: import("node:http").IncomingMessage, input: unknown, assertRequestActive?: () => void) => unknown | Promise<unknown>;
type ResponseResult = { status: number; headers: IncomingHttpHeaders; body: unknown; rawBody: string };
type RequestOptions = {
  method?: string;
  headers?: Record<string, string | undefined>;
  bodyBytes?: Buffer;
  body?: unknown;
};

let fixture: MemberTlsFixture;
let tlsServer: HttpsServer;
let plainServer: HttpServer;
let port: number;
let plainPort: number;
let mountedHandler: RequestHandler | undefined;
const handlers = new Set<RequestHandler>();
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

function createAdapter(actions: { issue?: AdapterCall; complete?: AdapterCall; reconcile?: AdapterCall } = {}) {
  const issue = vi.fn(async (request: import("node:http").IncomingMessage, input: unknown, active?: () => void) => {
    return actions.issue ? actions.issue(request, input, active) : ISSUE_RESULT;
  });
  const complete = vi.fn(async (request: import("node:http").IncomingMessage, input: unknown, active?: () => void) => {
    return actions.complete ? actions.complete(request, input, active) : {
      id: "44444444-4444-4444-8444-444444444444",
      status: "pending",
      ownerUserId: "must-not-project",
      certificate: "must-not-project",
      secret: "must-not-project",
    };
  });
  return {
    adapter: { issue, completeFromTlsRequest: complete,
      ...(actions.reconcile ? { reconcileFromTlsRequest: vi.fn(actions.reconcile) } : {}) } as unknown as Adapter,
    issue,
    complete,
  };
}

function installHandler(
  actions: { issue?: AdapterCall; complete?: AdapterCall; reconcile?: AdapterCall } = {},
  options: HandlerOptions = DEFAULT_OPTIONS,
) {
  const mocks = createAdapter(actions);
  const handler = createSpsNativeEnrollmentRequestHandler(mocks.adapter, { ...options });
  mountedHandler = handler;
  handlers.add(handler);
  return { ...mocks, handler };
}

function parseResponse(status: number, headers: IncomingHttpHeaders, bytes: Buffer): ResponseResult {
  const rawBody = bytes.toString("utf8");
  let body: unknown = rawBody;
  try { body = JSON.parse(rawBody); } catch { /* Keep malformed server output inspectable. */ }
  return { status, headers, body, rawBody };
}

function requestTls(path: string, options: RequestOptions = {}): Promise<ResponseResult> {
  const bytes = options.bodyBytes ?? Buffer.from(JSON.stringify(options.body ?? ISSUE_BODY), "utf8");
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(bytes.length),
    Cookie: COOKIE,
    Connection: "close",
  };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: "127.0.0.1",
      port,
      path,
      method: options.method ?? "POST",
      agent: false,
      ca: fixture.certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      headers,
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve(parseResponse(response.statusCode ?? 0, response.headers, Buffer.concat(chunks))));
    });
    request.once("socket", trackSocket);
    request.once("error", reject);
    request.setTimeout(8000, () => request.destroy(new Error("TLS fixture request timed out.")));
    request.end(bytes);
  });
}

function requestPlainHttp(path: string): Promise<ResponseResult> {
  const bytes = Buffer.from(JSON.stringify(ISSUE_BODY), "utf8");
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: plainPort,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": String(bytes.length), Cookie: COOKIE, Connection: "close" },
    }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => resolve(parseResponse(response.statusCode ?? 0, response.headers, Buffer.concat(chunks))));
    });
    request.once("socket", trackSocket);
    request.once("error", reject);
    request.setTimeout(8000, () => request.destroy(new Error("Plain HTTP fixture request timed out.")));
    request.end(bytes);
  });
}

function rawTlsRequest(path: string, headerLines: string[], body: Buffer): Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: fixture.certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
    });
    trackSocket(socket);
    const chunks: Buffer[] = [];
    let completed = false;
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`TLS fixture returned no complete HTTP response: ${raw.toString("utf8")}`));
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
      const head = [
        `POST ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: close",
        ...headerLines,
        "",
        "",
      ].join("\r\n");
      socket.write(Buffer.concat([Buffer.from(head, "latin1"), body]));
    });
  });
}

function expectFailure(response: ResponseResult, status: number) {
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ code: FAILURE_CODE });
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["content-type"]).toMatch(/^application\/json(?:;|$)/i);
  expect(response.headers.connection?.toLowerCase()).toBe("close");
  expect(Object.keys(response.headers).some(name => name.toLowerCase().startsWith("access-control-"))).toBe(false);
}

function expectResponseHeaders(response: ResponseResult) {
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers["content-type"]).toMatch(/^application\/json(?:;|$)/i);
  expect(response.headers.connection?.toLowerCase()).toBe("close");
  expect(Object.keys(response.headers).some(name => name.toLowerCase().startsWith("access-control-"))).toBe(false);
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("SPS Native enrollment HTTP request handler (inactive TLS ingress)", () => {
  it("exposes only an explicit read-only reconciliation DTO and rejects widened input/results", async () => {
    const route = "/sps-native/v1/enrollment/reconcile";
    const body = { enrollmentId: COMPLETE_BODY.enrollmentId };
    installHandler();
    expectFailure(await requestTls(route, { body }), 404);
    for (const status of ["pending", "approved", "revoked"] as const) {
      const mocks = installHandler({ reconcile: async (_request, input, active) => {
        active?.();
        expect(input).toEqual(body);
        return { deviceId: "44444444-4444-4444-8444-444444444444", status };
      } });
      const result = await requestTls(route, { body });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ deviceId: "44444444-4444-4444-8444-444444444444", status });
      expectResponseHeaders(result);
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    }
    const reconcile = vi.fn(async () => ({ deviceId: "44444444-4444-4444-8444-444444444444", status: "pending" }));
    installHandler({ reconcile });
    for (const widened of [{ ...body, userId: "body-selected" }, { ...body, pairingSecret: "old-secret" }, {}]) {
      expectFailure(await requestTls(route, { body: widened }), 400);
    }
    expect(reconcile).not.toHaveBeenCalled();
    for (const result of [{ deviceId: "invalid", status: "pending" },
      { deviceId: "44444444-4444-4444-8444-444444444444", status: "ready" },
      { deviceId: "44444444-4444-4444-8444-444444444444", status: "pending", private: "must-not-project" }]) {
      installHandler({ reconcile: async () => result });
      expectFailure(await requestTls(route, { body }), 503);
    }
  });

  beforeAll(async () => {
    fixture = await createMemberTlsFixture({ purpose: "serverAuth" });
    tlsServer = createHttpsServer({
      key: fixture.keyPem,
      cert: fixture.certPem,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      secureOptions: constants.SSL_OP_NO_TICKET,
      maxHeaderSize: 64 * 1024,
    }, (request, response) => {
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

  it("serves the exact issue DTO over a fresh TLS 1.3 request and passes the active guard", async () => {
    let capturedProtocol: string | null | undefined;
    let capturedReused: boolean | undefined;
    let capturedGuard: (() => void) | undefined;
    const harness = installHandler({
      issue: async (request, input, assertRequestActive) => {
        capturedProtocol = (request.socket as TLSSocket).getProtocol();
        capturedReused = (request.socket as TLSSocket).isSessionReused();
        capturedGuard = assertRequestActive;
        assertRequestActive?.();
        expect(request.method).toBe("POST");
        expect(input).toEqual(ISSUE_BODY);
        return ISSUE_RESULT;
      },
    });

    const response = await requestTls(ISSUE_PATH);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(ISSUE_RESULT);
    expect(Object.keys(response.body as object).sort()).toEqual(["certificate", "enrollmentId", "expiresAt", "issuerCertificate"]);
    expect(capturedProtocol).toBe("TLSv1.3");
    expect(capturedReused).toBe(false);
    expect(capturedGuard).toEqual(expect.any(Function));
    expect(harness.issue).toHaveBeenCalledTimes(1);
    expectResponseHeaders(response);
  });

  it("projects completion to only deviceId and pending status", async () => {
    const harness = installHandler();
    const response = await requestTls(COMPLETE_PATH, { body: COMPLETE_BODY });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deviceId: "44444444-4444-4444-8444-444444444444", status: "pending" });
    expect(Object.keys(response.body as object).sort()).toEqual(["deviceId", "status"]);
    expect(harness.complete).toHaveBeenCalledTimes(1);
    expect(harness.complete.mock.calls[0]?.[1]).toEqual(COMPLETE_BODY);
    expectResponseHeaders(response);
  });

  it("rejects malformed, duplicate-key, noncompact, UTF-16, and malformed UTF-8 JSON", async () => {
    installHandler();
    const invalidBodies = [
      Buffer.from("{\"pairingId\":}", "utf8"),
      Buffer.from('{"pairingId":"a","pairingId":"b","pairingSecret":"x","deviceKeyId":"y","requestPem":"z"}', "utf8"),
      Buffer.from(JSON.stringify(ISSUE_BODY).replace(":", ": "), "utf8"),
      Buffer.from(JSON.stringify(ISSUE_BODY), "utf16le"),
      Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
      Buffer.from(JSON.stringify({ ...ISSUE_BODY, unexpected: "field" }), "utf8"),
    ];

    for (const bodyBytes of invalidBodies) {
      expectFailure(await requestTls(ISSUE_PATH, { bodyBytes }), 400);
    }
  });

  it("requires exact routes, a canonical positive Content-Length, and bounded raw headers", async () => {
    installHandler();
    expectFailure(await requestTls("/unknown"), 404);
    expectFailure(await requestTls(`${ISSUE_PATH}?extra=1`), 404);
    expectFailure(await requestTls(ISSUE_PATH, { bodyBytes: Buffer.alloc(0) }), 400);

    const oneByte = Buffer.from("x");
    expectFailure(await rawTlsRequest(ISSUE_PATH, [
      "Content-Type: application/json",
      "Content-Length: 01",
      `Cookie: ${COOKIE}`,
    ], oneByte), 400);
    expectFailure(await rawTlsRequest(ISSUE_PATH, [
      "Content-Type: application/json",
      `Cookie: ${COOKIE}`,
    ], Buffer.alloc(0)), 400);

    const manyHeaders = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`X-Fill-${index}`, "x"]));
    expectFailure(await requestTls(ISSUE_PATH, { headers: manyHeaders }), 400);
    expectFailure(await requestTls(ISSUE_PATH, { headers: { "X-Fill": "x".repeat(16_500) } }), 400);
  });

  it("rejects browser, credential, cookie, transfer, and content-encoding headers without invoking the adapter", async () => {
    const harness = installHandler();
    for (const headers of [
      { Origin: "https://fixture.example.test" },
      { Referer: "https://fixture.example.test/" },
      { Authorization: "Bearer fixture-secret" },
      { "Sec-Fetch-Site": "same-origin" },
      { Cookie: undefined },
      { "Content-Type": "text/plain" },
      { "Content-Encoding": "gzip" },
    ]) {
      const hasContentEncoding = headers["Content-Encoding"] !== undefined;
      const response = await requestTls(ISSUE_PATH, { headers });
      expectFailure(response, hasContentEncoding ? 400 : 403);
      expect(response.rawBody).not.toContain("fixture-secret");
    }
    expectFailure(await rawTlsRequest(ISSUE_PATH, [
      "Content-Type: application/json",
      "Transfer-Encoding: chunked",
      `Cookie: ${COOKIE}`,
    ], Buffer.from("0\r\n\r\n")), 400);
    expectFailure(await rawTlsRequest(ISSUE_PATH, [
      "Content-Type: application/json",
      `Content-Length: ${Buffer.byteLength(JSON.stringify(ISSUE_BODY))}`,
      `Cookie: ${COOKIE}`,
      "Cookie: sps_identity_session=second",
    ], Buffer.from(JSON.stringify(ISSUE_BODY))), 403);
    expectFailure(await requestTls(ISSUE_PATH, { method: "GET" }), 403);
    expectFailure(await requestPlainHttp(ISSUE_PATH), 403);
    expect(harness.issue).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before parsing and validates constructor bounds", async () => {
    const small = installHandler({}, { ...DEFAULT_OPTIONS, maxBodyBytes: 512 });
    const oversized = Buffer.from(JSON.stringify({ ...ISSUE_BODY, padding: "x".repeat(600) }), "utf8");
    expectFailure(await requestTls(ISSUE_PATH, { bodyBytes: oversized }), 413);
    expect(small.issue).not.toHaveBeenCalled();

    const adapter = createAdapter().adapter;
    const invalidOptions = [
      { ...DEFAULT_OPTIONS, maxBodyBytes: 511 },
      { ...DEFAULT_OPTIONS, maxBodyBytes: 8193 },
      { ...DEFAULT_OPTIONS, maxBodyBytes: 512.5 },
      { ...DEFAULT_OPTIONS, maxBodyBytes: Number.MAX_SAFE_INTEGER + 1 },
      { ...DEFAULT_OPTIONS, readTimeoutMs: 99 },
      { ...DEFAULT_OPTIONS, readTimeoutMs: 10_001 },
      { ...DEFAULT_OPTIONS, readTimeoutMs: 100.5 },
      { ...DEFAULT_OPTIONS, operationTimeoutMs: 499 },
      { ...DEFAULT_OPTIONS, operationTimeoutMs: 60_001 },
      { ...DEFAULT_OPTIONS, operationTimeoutMs: 500.5 },
      { ...DEFAULT_OPTIONS, maxConcurrentRequests: 0 },
      { ...DEFAULT_OPTIONS, maxConcurrentRequests: 9 },
      { ...DEFAULT_OPTIONS, maxConcurrentRequests: 1.5 },
    ];
    for (const options of invalidOptions) {
      expect(() => createSpsNativeEnrollmentRequestHandler(adapter, options)).toThrow(TypeError);
    }
  });

  it("returns fixed errors for known failures, unexpected failures, and malformed adapter results", async () => {
    const session = installHandler({ issue: async () => { throw new SpsNativeSessionEnrollmentError(); } });
    const sessionFailure = await requestTls(ISSUE_PATH);
    expectFailure(sessionFailure, 403);
    expect(sessionFailure.rawBody).not.toContain("session");
    session.handler.dispose();

    const enrollment = installHandler({ issue: async () => { throw new SpsNativeEnrollmentError(); } });
    expectFailure(await requestTls(ISSUE_PATH), 409);
    enrollment.handler.dispose();

    const unexpected = installHandler({ issue: async () => { throw new Error("fixture-secret-must-not-leak"); } });
    const unavailable = await requestTls(ISSUE_PATH);
    expectFailure(unavailable, 503);
    expect(unavailable.rawBody).not.toContain("fixture-secret-must-not-leak");
    unexpected.handler.dispose();

    const malformedResult = installHandler({ issue: async () => ({ ...ISSUE_RESULT, extra: "not-allowed" }) });
    expectFailure(await requestTls(ISSUE_PATH), 503);
    malformedResult.handler.dispose();

    const invalidCertificate = installHandler({ issue: async () => ({ ...ISSUE_RESULT, certificate: "fixture-cert=" }) });
    expectFailure(await requestTls(ISSUE_PATH), 503);
    invalidCertificate.handler.dispose();

    const invalidExpiry = installHandler({ issue: async () => ({ ...ISSUE_RESULT, expiresAt: "2026-01-01T00:00:00Z" }) });
    expectFailure(await requestTls(ISSUE_PATH), 503);
  });

  it("contains late stream errors on incomplete requests rejected before body parsing", () => {
    const harness = installHandler();
    for (const path of ["/not-an-enrollment-route", ISSUE_PATH]) {
      const socket = new Socket();
      const incoming = new IncomingMessage(socket);
      incoming.method = "POST";
      incoming.url = path;
      incoming.push(Buffer.from('{"pa'));
      const response = new ServerResponse(incoming);
      try {
        harness.handler.handle(incoming, response);
        expect(incoming.complete).toBe(false);
        expect(incoming.readableLength).toBe(4);
        expect(() => incoming.emit("error", new Error("private late request error"))).not.toThrow();
        expect(() => response.emit("error", new Error("private late response error"))).not.toThrow();
        expect(() => incoming.emit("error", new Error("private second request error"))).not.toThrow();
      } finally {
        response.destroy(); incoming.destroy(); socket.destroy();
      }
    }
    expect(harness.issue).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("returns 408 on a partial body read timeout", async () => {
    installHandler({}, { ...DEFAULT_OPTIONS, readTimeoutMs: 100 });
    const bytes = Buffer.from(JSON.stringify(ISSUE_BODY), "utf8");
    const response = await new Promise<ResponseResult>((resolve, reject) => {
      const socket = tlsConnect({
        host: "127.0.0.1",
        port,
        servername: "localhost",
        ca: fixture.certPem,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
      });
      trackSocket(socket);
      const chunks: Buffer[] = [];
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        const raw = Buffer.concat(chunks);
        const split = raw.indexOf("\r\n\r\n");
        if (split < 0) return reject(new Error(`Read timeout returned no HTTP response: ${raw.toString("utf8")}`));
        const head = raw.subarray(0, split).toString("latin1");
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
        const headers: IncomingHttpHeaders = {};
        for (const line of head.split("\r\n").slice(1)) {
          const separator = line.indexOf(":");
          if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
        }
        resolve(parseResponse(status, headers, raw.subarray(split + 4)));
      };
      const timeout = setTimeout(() => socket.destroy(new Error("Partial body fixture request timed out.")), 8000);
      socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
      socket.once("end", finish);
      socket.once("close", () => { if (chunks.length) finish(); });
      socket.once("error", error => {
        if (chunks.length) finish();
        else if (!finished) { finished = true; clearTimeout(timeout); reject(error); }
      });
      socket.once("secureConnect", () => {
        const head = [
          `POST ${ISSUE_PATH} HTTP/1.1`,
          "Host: 127.0.0.1",
          "Connection: close",
          "Content-Type: application/json",
          `Content-Length: ${bytes.length}`,
          `Cookie: ${COOKIE}`,
          "",
          "",
        ].join("\r\n");
        socket.write(Buffer.concat([Buffer.from(head, "latin1"), bytes.subarray(0, 4)]));
      });
    });
    expectFailure(response, 408);
  });

  it("keeps a timed-out operation slot occupied until its adapter promise actually settles", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const settled = deferred<void>();
    let calls = 0;
    const harness = installHandler({
      issue: async (_request, _input, assertRequestActive) => {
        calls++;
        if (calls !== 1) return ISSUE_RESULT;
        assertRequestActive?.();
        started.resolve();
        try { await release.promise; return ISSUE_RESULT; }
        finally { settled.resolve(); }
      },
    }, { ...DEFAULT_OPTIONS, operationTimeoutMs: 500, maxConcurrentRequests: 1 });

    const timedOutPromise = requestTls(ISSUE_PATH);
    await started.promise;
    expectFailure(await timedOutPromise, 408);
    expectFailure(await requestTls(ISSUE_PATH), 429);
    expect(calls).toBe(1);

    release.resolve();
    await settled.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect((await requestTls(ISSUE_PATH)).status).toBe(200);
    expect(calls).toBe(2);
    harness.handler.dispose();
  });

  it("disposal fences the adapter guard, rejects new calls, and suppresses a late result", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let lateGuard: (() => void) | undefined;
    const harness = installHandler({
      issue: async (_request, _input, assertRequestActive) => {
        lateGuard = assertRequestActive;
        assertRequestActive?.();
        started.resolve();
        await release.promise;
        assertRequestActive?.();
        return ISSUE_RESULT;
      },
    }, { ...DEFAULT_OPTIONS, maxConcurrentRequests: 1 });

    const pending = requestTls(ISSUE_PATH);
    await started.promise;
    harness.handler.dispose();
    expect(lateGuard).toEqual(expect.any(Function));
    expect(() => lateGuard?.()).toThrow();
    expectFailure(await requestTls(ISSUE_PATH), 503);

    release.resolve();
    expectFailure(await pending, 503);
    expect(harness.issue).toHaveBeenCalledTimes(1);
  });
});
