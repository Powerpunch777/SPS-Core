import { constants, createHash, X509Certificate } from "node:crypto";
import { createServer as createHttpServer, request as httpRequest, type IncomingHttpHeaders,
  type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createSpsNativeIdentityRequestHandler, type SpsNativeIdentityInspection,
  type SpsNativeIdentityHttpOptions } from "../services/sps-native-identity-http.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import { createNativeEnrollmentTlsFixture, type NativeEnrollmentTlsFixture } from "./helpers/native-enrollment-tls.js";

const PATH = "/sps-native/v1/identity";
const FAILURE_CODE = "native_identity_unavailable";
const HOST_ID = "11111111-1111-4111-8111-111111111111";
const DEFAULT_OPTIONS: SpsNativeIdentityHttpOptions = Object.freeze({
  readTimeoutMs: 1000,
  operationTimeoutMs: 2000,
  maxConcurrentRequests: 2,
});

type Handler = ReturnType<typeof createSpsNativeIdentityRequestHandler>;
type ResponseResult = { status: number; headers: IncomingHttpHeaders; body: unknown; rawBody: string };
type RequestOptions = {
  path?: string;
  method?: string;
  headers?: Record<string, string | undefined>;
  port?: number;
  ca?: string;
  session?: Buffer;
  tlsVersion?: "TLSv1.2" | "TLSv1.3";
  onSession?: (session: Buffer) => void;
  onSecureConnect?: (reused: boolean) => void;
};

let serverFixture: MemberTlsFixture;
let issuerFixture: NativeEnrollmentTlsFixture;
let tlsServer: HttpsServer;
let plainServer: HttpServer;
let port: number;
let plainPort: number;
let mountedHandler: Handler | undefined;
const handlers = new Set<Handler>();
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

function inspection(overrides: Partial<SpsNativeIdentityInspection> = {}): SpsNativeIdentityInspection {
  return {
    hostId: HOST_ID,
    serverSpkiSha256: serverFixture.spkiSha256,
    issuerSpkiSha256: issuerFixture.issuerSpkiSha256,
    issuerCertificate: issuerFixture.issuerCertificate,
    ...overrides,
  };
}

function installHandler(
  action: () => Promise<unknown> = async () => inspection(),
  options: SpsNativeIdentityHttpOptions = DEFAULT_OPTIONS,
  currentGuard?: () => void,
) {
  const inspect = vi.fn(action);
  const handler = createSpsNativeIdentityRequestHandler(inspect as () => Promise<SpsNativeIdentityInspection>,
    { ...options }, currentGuard);
  mountedHandler = handler;
  handlers.add(handler);
  return { inspect, handler };
}

function parseResponse(status: number, headers: IncomingHttpHeaders, bytes: Buffer): ResponseResult {
  const rawBody = bytes.toString("utf8");
  let body: unknown = rawBody;
  try { body = JSON.parse(rawBody); } catch { /* Keep malformed output inspectable. */ }
  return { status, headers, body, rawBody };
}

function requestTls(options: RequestOptions = {}): Promise<ResponseResult> {
  const headers: Record<string, string> = { "Content-Length": "0", Connection: "close" };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
  return new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: "127.0.0.1", port: options.port ?? port,
      path: options.path ?? PATH, method: options.method ?? "POST", agent: false,
      ca: options.ca ?? serverFixture.certPem, minVersion: options.tlsVersion ?? "TLSv1.3",
      maxVersion: options.tlsVersion ?? "TLSv1.3",
      ...(options.session ? { session: options.session } : {}), headers }, response => {
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
      headers: { "Content-Length": "0", Connection: "close" } }, response => {
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

function rawTlsRequest(path: string, headerLines: string[], body = Buffer.alloc(0), options: Pick<RequestOptions, "port" | "ca"> = {})
  : Promise<ResponseResult> {
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({ host: "127.0.0.1", port: options.port ?? port, servername: "localhost",
      ca: options.ca ?? serverFixture.certPem, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true });
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
  expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(response.rawBody)));
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("SPS Native public identity HTTP handler (inactive TLS ingress)", () => {
  beforeAll(async () => {
    serverFixture = await createMemberTlsFixture({ purpose: "serverAuth" });
    issuerFixture = await createNativeEnrollmentTlsFixture({ hostId: HOST_ID,
      deviceKeyId: "22222222-2222-4222-8222-222222222222" });
    tlsServer = createHttpsServer({ key: serverFixture.keyPem, cert: serverFixture.certPem,
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
  }, 30_000);

  afterEach(() => {
    for (const handler of handlers) handler.dispose();
    handlers.clear();
    mountedHandler = undefined;
    for (const socket of sockets) socket.destroy();
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([closed(tlsServer), closed(plainServer)]);
    await Promise.all([serverFixture?.cleanup(), issuerFixture?.cleanup()]);
  });

  it("returns only the four public fields without an account or Plugin credential", async () => {
    const harness = installHandler();
    const response = await requestTls();
    expect(response.status).toBe(200);
    expect(response.body).toEqual(inspection());
    expect(Object.keys(response.body as object).sort()).toEqual([
      "hostId", "issuerCertificate", "issuerSpkiSha256", "serverSpkiSha256",
    ]);
    expect(response.rawBody).not.toContain("private");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expectCommonHeaders(response);
    expect(harness.inspect).toHaveBeenCalledTimes(1);
    expect(harness.inspect).toHaveBeenCalledWith();
  });

  it("requires the exact route, POST, empty framing, fresh TLS 1.3, and no credential or proxy metadata", async () => {
    const harness = installHandler();
    expectFailure(await requestTls({ path: `${PATH}?extra=1` }), 404);
    expectFailure(await requestTls({ path: "/unknown" }), 404);
    expectFailure(await requestTls({ method: "GET" }), 403);
    expectFailure(await rawTlsRequest(PATH, ["Content-Length: 00"]), 400);
    expectFailure(await rawTlsRequest(PATH, ["Content-Length: 1"], Buffer.from("x")), 400);
    expectFailure(await rawTlsRequest(PATH, ["Content-Length: 0", "X-Repeat: first", "x-repeat: second"]), 400);

    for (const header of ["Authorization: Bearer fixture", "Cookie: session=fixture", "Origin: https://fixture.test",
      "Referer: https://fixture.test/", "Sec-Fetch-Site: same-origin", "Proxy-Authorization: Basic fixture",
      "Proxy-Authenticate: Basic", "Proxy-Connection: keep-alive", "Forwarded: for=127.0.0.1",
      "X-Forwarded-For: 127.0.0.1", "Content-Encoding: gzip", "Trailer: Digest"]) {
      expectFailure(await rawTlsRequest(PATH, ["Content-Length: 0", header]), 403);
    }
    expectFailure(await rawTlsRequest(PATH, ["Transfer-Encoding: chunked"], Buffer.from("0\r\n\r\n")), 403);
    expectFailure(await requestPlainHttp(), 403);
    expectFailure(await requestTls({ tlsVersion: "TLSv1.2" }), 403);
    expect(harness.inspect).not.toHaveBeenCalled();
  });

  it("rejects extra inspection fields, malformed pins, invalid issuer certificates, and untrusted guards", async () => {
    const extra = installHandler(async () => ({ ...inspection(), privateValue: "must-not-leak" }));
    const extraResponse = await requestTls();
    expectFailure(extraResponse, 503);
    expect(extraResponse.rawBody).not.toContain("must-not-leak");
    extra.handler.dispose();

    const badIssuerPin = installHandler(async () => inspection({ issuerSpkiSha256: "a".repeat(64) }));
    expectFailure(await requestTls(), 503);
    badIssuerPin.handler.dispose();

    const nonCaCertificate = new X509Certificate(Buffer.from(serverFixture.certificate, "base64url"));
    const nonCa = installHandler(async () => inspection({
      issuerCertificate: serverFixture.certificate,
      issuerSpkiSha256: createHash("sha256").update(nonCaCertificate.publicKey.export({ format: "der", type: "spki" })).digest("hex"),
    }));
    expectFailure(await requestTls(), 503);
    nonCa.handler.dispose();

    const appendedDer = Buffer.concat([Buffer.from(issuerFixture.issuerCertificate, "base64url"), Buffer.from([0])])
      .toString("base64url");
    const trailingDer = installHandler(async () => inspection({ issuerCertificate: appendedDer }));
    expectFailure(await requestTls(), 503);
    trailingDer.handler.dispose();

    const expiry = vi.spyOn(Date, "now").mockReturnValue(Date.parse(
      new X509Certificate(Buffer.from(issuerFixture.issuerCertificate, "base64url")).validTo,
    ));
    const expiredAtBoundary = installHandler();
    try { expectFailure(await requestTls(), 503); }
    finally { expiry.mockRestore(); expiredAtBoundary.handler.dispose(); }

    const wrongServerPin = installHandler(async () => inspection({ serverSpkiSha256: "b".repeat(64) }));
    expectFailure(await requestTls(), 503);
    wrongServerPin.handler.dispose();

    const denied = installHandler(async () => inspection(), DEFAULT_OPTIONS, () => { throw new Error("private guard detail"); });
    const deniedResponse = await requestTls();
    expectFailure(deniedResponse, 503);
    expect(deniedResponse.rawBody).not.toContain("private guard detail");
    expect(denied.inspect).not.toHaveBeenCalled();

    const asyncGuard = installHandler(async () => inspection(), DEFAULT_OPTIONS,
      (() => Promise.reject(new Error("late guard rejection"))) as unknown as () => void);
    expectFailure(await requestTls(), 503);
    expect(asyncGuard.inspect).not.toHaveBeenCalled();
    await new Promise<void>(resolve => setImmediate(resolve));

    let disposingHandler: Handler | undefined;
    const disposedInsideGuard = vi.fn(async () => inspection());
    disposingHandler = createSpsNativeIdentityRequestHandler(disposedInsideGuard,
      { ...DEFAULT_OPTIONS, maxConcurrentRequests: 1 }, () => disposingHandler?.dispose());
    mountedHandler = disposingHandler;
    handlers.add(disposingHandler);
    expectFailure(await requestTls(), 503);
    expect(disposedInsideGuard).not.toHaveBeenCalled();
  });

  it("compares the trusted server pin to the actual local TLS certificate", async () => {
    const otherServer = await createMemberTlsFixture({ purpose: "serverAuth" });
    const handler = createSpsNativeIdentityRequestHandler(async () => inspection(), { ...DEFAULT_OPTIONS });
    handlers.add(handler);
    const alternate = createHttpsServer({ key: otherServer.keyPem, cert: otherServer.certPem,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, handler.handle);
    alternate.on("connection", trackSocket);
    alternate.on("tlsClientError", () => {});
    const alternatePort = await listen(alternate);
    try {
      expectFailure(await requestTls({ port: alternatePort, ca: otherServer.certPem }), 503);
    } finally {
      handler.dispose();
      await closed(alternate);
      await otherServer.cleanup();
    }
  });

  it("rejects an issuer certificate that reuses the actual server TLS key", async () => {
    const certificate = await createIssuerCertificateFromServerKey();
    const harness = installHandler(async () => inspection({
      issuerSpkiSha256: serverFixture.spkiSha256,
      issuerCertificate: certificate,
    }));
    expectFailure(await requestTls(), 503);
    expect(harness.inspect).toHaveBeenCalledTimes(1);
  });

  it("rejects an actually resumed TLS 1.3 connection before inspection", async () => {
    const harness = installHandler();
    const resumable = createHttpsServer({ key: serverFixture.keyPem, cert: serverFixture.certPem,
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, harness.handler.handle);
    resumable.on("connection", trackSocket);
    resumable.on("tlsClientError", () => {});
    const resumablePort = await listen(resumable);
    let ticket: Buffer | undefined;
    try {
      expect((await requestTls({ port: resumablePort, onSession(value) { ticket = value; } })).status).toBe(200);
      expect(ticket?.length).toBeGreaterThan(0);
      let reused = false;
      expectFailure(await requestTls({ port: resumablePort, session: ticket,
        onSecureConnect(value) { reused = value; } }), 403);
      expect(reused).toBe(true);
      expect(harness.inspect).toHaveBeenCalledTimes(1);
    } finally { await closed(resumable); }
  });

  it("validates exact limit ranges and times out without freeing an unsettled inspect slot", async () => {
    const harness = installHandler();
    for (const invalid of [
      { readTimeoutMs: 99, operationTimeoutMs: 500, maxConcurrentRequests: 1 },
      { readTimeoutMs: 10_001, operationTimeoutMs: 500, maxConcurrentRequests: 1 },
      { readTimeoutMs: 100, operationTimeoutMs: 499, maxConcurrentRequests: 1 },
      { readTimeoutMs: 100, operationTimeoutMs: 60_001, maxConcurrentRequests: 1 },
      { readTimeoutMs: 100, operationTimeoutMs: 500, maxConcurrentRequests: 0 },
      { readTimeoutMs: 100, operationTimeoutMs: 500, maxConcurrentRequests: 1.5 },
      { readTimeoutMs: 100, operationTimeoutMs: 500, maxConcurrentRequests: 1, extra: true },
    ]) {
      expect(() => createSpsNativeIdentityRequestHandler(async () => inspection(), invalid)).toThrow(TypeError);
    }

    const held = deferred<void>(), started = deferred<void>();
    let calls = 0;
    const bounded = installHandler(async () => {
      calls++;
      started.resolve();
      if (calls === 1) await held.promise;
      return inspection();
    }, { ...DEFAULT_OPTIONS, operationTimeoutMs: 500, maxConcurrentRequests: 1 });
    const pending = requestTls();
    try {
      await started.promise;
      expectFailure(await pending, 408);
      expectFailure(await requestTls(), 429);
      expect(calls).toBe(1);
      held.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect((await requestTls()).status).toBe(200);
      expect(calls).toBe(2);
    } finally { held.resolve(); }
    expect(bounded.inspect).toHaveBeenCalledTimes(2);
  });

  it("disposal fences late metadata and retains capacity until inspect settles", async () => {
    const held = deferred<void>(), started = deferred<void>();
    let calls = 0;
    const harness = installHandler(async () => {
      calls++;
      started.resolve();
      if (calls === 1) await held.promise;
      return inspection();
    }, { ...DEFAULT_OPTIONS, maxConcurrentRequests: 1 });
    const pending = requestTls();
    try {
      await started.promise;
      harness.handler.dispose();
      expectFailure(await pending, 503);
      expectFailure(await requestTls(), 503);
      held.resolve();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(calls).toBe(1);
    } finally { held.resolve(); }
  });
});

async function createIssuerCertificateFromServerKey(): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  const directory = await mkdtemp(path.join(os.tmpdir(), "sps-native-identity-ca-"));
  try {
    const keyPath = path.join(directory, "fixture.key");
    const certificatePath = path.join(directory, "fixture.crt");
    await writeFile(keyPath, serverFixture.keyPem, { encoding: "utf8", mode: 0o600 });
    const candidates = ["openssl"];
    if (process.platform === "win32") {
      const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
        .filter((value): value is string => Boolean(value));
      candidates.push(...programFiles.map(directoryPath => path.join(directoryPath, "Git", "usr", "bin", "openssl.exe")));
    }
    let generated = false;
    for (const executable of candidates) {
      try {
        await execFileAsync(executable, ["req", "-x509", "-new", "-key", keyPath, "-sha256", "-days", "2",
          "-subj", `/CN=SPS Member Issuer ${HOST_ID}`,
          "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
          "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-out", certificatePath],
        { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
        generated = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (!generated) throw new Error("OpenSSL is required for the Native identity key-separation fixture.");
    return new X509Certificate(await readFile(certificatePath)).raw.toString("base64url");
  } finally { await rm(directory, { recursive: true, force: true }); }
}
