import { once } from "node:events";
import http, { type Server as HttpServer } from "node:http";
import https, { type Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMemberTlsFixture,
  type MemberTlsFixture,
} from "./helpers/member-tls.js";
import {
  createSpsMemberTransport,
  type SpsMemberTransportGrant,
} from "../services/sps-member-transport.js";

const HOST_ID = "2ac7496a-e0df-48b2-9bce-75d6fdfef841";
const COMPANY_ID = "649e76e1-b50b-4fbd-8716-b556eaece722";
const USER_ID = "member-transport-test-user";
const DEVICE_ID = "6ac36079-5164-4c75-8a89-e2a20674c888";
const RESOURCE_TIMEOUT_MS = 4_000;
let clientCertificate: MemberTlsFixture | undefined;
let serverCertificate: MemberTlsFixture | undefined;

type HttpsResult = {
  status: number;
  body: string;
  socket: TLSSocket;
};

type SecureServerOptions = {
  rejectUnauthorized?: boolean;
  onAuthorized?: (grant: SpsMemberTransportGrant) => void;
};

describe("SPS Member TLS transport", () => {
  const cleanupServers: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    clientCertificate = await createMemberTlsFixture({ purpose: "clientAuth" });
    try {
      serverCertificate = await createMemberTlsFixture({ purpose: "serverAuth" });
    } catch (error) {
      await clientCertificate.cleanup();
      clientCertificate = undefined;
      throw error;
    }
  }, 30_000);

  afterEach(async () => {
    await Promise.all(cleanupServers.splice(0).map((cleanup) => cleanup()));
  });

  afterAll(async () => {
    await clientCertificate?.cleanup();
    await serverCertificate?.cleanup();
  });

  function currentGrant(certificateSha256 = clientCertificate!.certificateSha256): SpsMemberTransportGrant {
    return {
      deviceId: DEVICE_ID,
      hostId: HOST_ID,
      userId: USER_ID,
      companyId: COMPANY_ID,
      revision: 7,
      certificateSha256,
      certificateNotAfter: new Date(Date.now() + 60 * 60_000),
    };
  }

  async function startSecureServer(
    transport: ReturnType<typeof createSpsMemberTransport>,
    options: SecureServerOptions = {},
  ) {
    const sockets = new Set<Socket>();
    const protocols: string[] = [];
    const server: HttpsServer = https.createServer({
      cert: serverCertificate!.certPem,
      key: serverCertificate!.keyPem,
      ca: clientCertificate!.certPem,
      requestCert: true,
      rejectUnauthorized: options.rejectUnauthorized ?? true,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    }, async (req, res) => {
      const socket = req.socket as TLSSocket;
      protocols.push(socket.getProtocol() ?? "unknown");
      try {
        const grant = await transport.authorize(req, { companyId: COMPANY_ID, userId: USER_ID });
        options.onAuthorized?.(grant);
        res.statusCode = 200;
        res.setHeader("Connection", "keep-alive");
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(grant));
      } catch (error) {
        res.statusCode = typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : 500;
        res.end(error instanceof Error ? error.message : "request failed");
      }
    });
    trackSockets(server, sockets);
    server.on("secureConnection", (socket) => trackSocket(socket, sockets));
    server.on("tlsClientError", () => {});
    server.listen(0, "127.0.0.1");
    await withTimeout(once(server, "listening"), RESOURCE_TIMEOUT_MS, "HTTPS listener startup");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback HTTPS listener did not bind a TCP port.");
    const cleanup = async () => closeServer(server, sockets);
    cleanupServers.push(cleanup);
    return { port: address.port, protocols, cleanup };
  }

  async function startPlainServer(transport: ReturnType<typeof createSpsMemberTransport>) {
    const sockets = new Set<Socket>();
    const server: HttpServer = http.createServer(async (req, res) => {
      try {
        await transport.authorize(req, { companyId: COMPANY_ID, userId: USER_ID });
        res.statusCode = 200;
        res.end("unexpected authorization");
      } catch (error) {
        res.statusCode = typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : 500;
        res.end(error instanceof Error ? error.message : "request failed");
      }
    });
    trackSockets(server, sockets);
    server.listen(0, "127.0.0.1");
    await withTimeout(once(server, "listening"), RESOURCE_TIMEOUT_MS, "HTTP listener startup");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback HTTP listener did not bind a TCP port.");
    const cleanup = async () => closeServer(server, sockets);
    cleanupServers.push(cleanup);
    return { port: address.port, cleanup };
  }

  it("uses verified TLS 1.3 peer DER, ignores forged identity headers, and returns only the safe grant DTO", async () => {
    const authorityInputs: Array<{ companyId: string; userId: string; certificateSha256: string }> = [];
    const rawGrant = currentGrant();
    let capturedGrant: SpsMemberTransportGrant | undefined;
    const transport = createSpsMemberTransport(HOST_ID, async (input) => {
      authorityInputs.push(input);
      return rawGrant;
    });
    const server = await startSecureServer(transport, {
      onAuthorized: (grant) => { capturedGrant = grant; },
    });

    const response = await requestHttps(server.port, {
      headers: {
        "x-sps-member-device-id": "00000000-0000-4000-8000-000000000000",
        "x-sps-member-user-id": "forged-user",
        "x-sps-member-certificate-sha256": "0".repeat(64),
      },
    });
    expect(response.status).toBe(200);
    expect(response.socket.getProtocol()).toBe("TLSv1.3");
    expect(server.protocols).toEqual(["TLSv1.3"]);
    expect(authorityInputs).toEqual([{
      companyId: COMPANY_ID,
      userId: USER_ID,
      certificateSha256: clientCertificate!.certificateSha256,
    }]);
    expect(capturedGrant).toBeDefined();
    expect(Object.isFrozen(capturedGrant)).toBe(true);
    expect(capturedGrant?.certificateNotAfter).toBeInstanceOf(Date);
    expect(capturedGrant?.certificateNotAfter).not.toBe(rawGrant.certificateNotAfter);
    expect(Object.keys(JSON.parse(response.body) as Record<string, unknown>).sort()).toEqual([
      "certificateNotAfter",
      "certificateSha256",
      "companyId",
      "deviceId",
      "hostId",
      "revision",
      "userId",
    ]);
    expect(response.body).not.toContain(clientCertificate!.keyPem);
    expect(response.body).not.toContain(clientCertificate!.certificate);
  });

  it("rechecks current authority for every request on a reused TLS socket", async () => {
    let calls = 0;
    const transport = createSpsMemberTransport(HOST_ID, async () => {
      calls += 1;
      const grant = currentGrant();
      return calls === 1
        ? grant
        : { ...grant, certificateNotAfter: new Date(Date.now() - 1_000) };
    });
    const server = await startSecureServer(transport);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await requestHttps(server.port, { agent });
      const second = await requestHttps(server.port, { agent });
      expect(first.status).toBe(200);
      expect(second.status).toBe(403);
      expect(first.socket).toBe(second.socket);
      expect(calls).toBe(2);
    } finally {
      agent.destroy();
    }
  });

  it("denies plain sockets with forged headers before consulting authority", async () => {
    const authorizeCurrent = vi.fn(async () => currentGrant());
    const transport = createSpsMemberTransport(HOST_ID, authorizeCurrent);
    const server = await startPlainServer(transport);
    const response = await requestHttp(server.port, {
      "x-sps-member-device-id": DEVICE_ID,
      "x-sps-member-user-id": USER_ID,
      "x-sps-member-certificate-sha256": clientCertificate!.certificateSha256,
    });

    expect(response.status).toBe(403);
    expect(authorizeCurrent).not.toHaveBeenCalled();
  });

  it("denies a TLS connection that presents no client certificate", async () => {
    const authorizeCurrent = vi.fn(async () => currentGrant());
    const transport = createSpsMemberTransport(HOST_ID, authorizeCurrent);
    const server = await startSecureServer(transport, { rejectUnauthorized: false });
    const response = await requestHttps(server.port, { client: null });

    expect(response.status).toBe(403);
    expect(server.protocols).toEqual(["TLSv1.3"]);
    expect(authorizeCurrent).not.toHaveBeenCalled();
  });

  it("denies wrong Host, user, Workspace, certificate identity, and expired grants", async () => {
    let override: Partial<SpsMemberTransportGrant> = {};
    const transport = createSpsMemberTransport(HOST_ID, async (input) => ({
      ...currentGrant(input.certificateSha256),
      ...override,
    }));
    const server = await startSecureServer(transport);
    const mismatches: Array<Partial<SpsMemberTransportGrant>> = [
      { hostId: "e214f78a-2803-46e5-af21-01f433bcebc7" },
      { userId: "different-user" },
      { companyId: "db51e252-4846-4b14-b100-4fd8785a6152" },
      { certificateSha256: "0".repeat(64) },
      { certificateNotAfter: new Date(Date.now() - 1_000) },
    ];

    for (const mismatch of mismatches) {
      override = mismatch;
      const response = await requestHttps(server.port);
      expect(response.status).toBe(403);
    }
  });

  it("closes an established socket when its device is revoked", async () => {
    const transport = createSpsMemberTransport(HOST_ID, async () => currentGrant());
    const server = await startSecureServer(transport);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const response = await requestHttps(server.port, { agent });
      expect(response.status).toBe(200);
      expect(response.socket.destroyed).toBe(false);
      const closed = waitForSocketClose(response.socket);
      transport.revokeDevice(DEVICE_ID);
      await withTimeout(closed, RESOURCE_TIMEOUT_MS, "revoked TLS socket close");
      expect(response.socket.destroyed).toBe(true);
    } finally {
      agent.destroy();
    }
  });

  it("fences an authorization callback already in flight when a device is revoked", async () => {
    let markStarted!: () => void;
    let releaseAuthorization!: (grant: SpsMemberTransportGrant) => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const authorizationResult = new Promise<SpsMemberTransportGrant>((resolve) => {
      releaseAuthorization = resolve;
    });
    const transport = createSpsMemberTransport(HOST_ID, async () => {
      markStarted();
      return authorizationResult;
    });
    const server = await startSecureServer(transport);
    const responsePromise = requestHttps(server.port);

    await withTimeout(started, RESOURCE_TIMEOUT_MS, "authority callback start");
    transport.revokeDevice(DEVICE_ID);
    releaseAuthorization(currentGrant());
    const response = await withTimeout(responsePromise, RESOURCE_TIMEOUT_MS, "in-flight request completion");
    expect(response.status).toBe(403);
  });

  it("dispose closes established sockets and denies subsequent authorizations", async () => {
    const transport = createSpsMemberTransport(HOST_ID, async () => currentGrant());
    const server = await startSecureServer(transport);
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const response = await requestHttps(server.port, { agent });
      expect(response.status).toBe(200);
      const closed = waitForSocketClose(response.socket);
      transport.dispose();
      await withTimeout(closed, RESOURCE_TIMEOUT_MS, "disposed TLS socket close");
      expect(response.socket.destroyed).toBe(true);
      const afterDispose = await requestHttps(server.port);
      expect(afterDispose.status).toBe(403);
    } finally {
      agent.destroy();
    }
  });
});

function trackSocket(socket: Socket, sockets: Set<Socket>) {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

function trackSockets(server: HttpServer, sockets: Set<Socket>) {
  server.on("connection", (socket) => trackSocket(socket, sockets));
}

async function closeServer(server: HttpServer, sockets: Set<Socket>) {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await withTimeout(new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }), RESOURCE_TIMEOUT_MS, "loopback listener shutdown");
}

function requestHttps(
  port: number,
  options: {
    client?: MemberTlsFixture | null;
    agent?: https.Agent | false;
    headers?: Record<string, string>;
  } = {},
): Promise<HttpsResult> {
  const client = options.client === undefined ? clientCertificate! : options.client;
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "localhost",
      family: 4,
      port,
      path: "/",
      method: "GET",
      servername: "localhost",
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      ca: serverCertificate!.certPem,
      cert: client?.certPem,
      key: client?.keyPem,
      agent: options.agent ?? false,
      headers: options.headers,
      timeout: RESOURCE_TIMEOUT_MS,
    }, (response) => {
      let body = "";
      const socket = response.socket;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => {
        if (!(socket instanceof TLSSocket)) {
          reject(new Error("HTTPS response did not use a TLS socket."));
          return;
        }
        resolve({ status: response.statusCode ?? 0, body, socket });
      });
    });
    request.once("timeout", () => request.destroy(new Error("HTTPS test request timed out.")));
    request.once("error", reject);
    request.end();
  });
}

function requestHttp(port: number, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/",
      method: "GET",
      headers,
      timeout: RESOURCE_TIMEOUT_MS,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; });
      response.once("error", reject);
      response.once("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.once("timeout", () => request.destroy(new Error("HTTP test request timed out.")));
    request.once("error", reject);
    request.end();
  });
}

function waitForSocketClose(socket: TLSSocket): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
