import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentApiKeys, companyMemberships, instanceUserRoles } from "@paperclipai/db";
import { WebSocket, WebSocketServer } from "ws";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

const activeWebSocketServers: WebSocketServer[] = [];
const activeHttpServers: HttpServer[] = [];
const activeClients: WebSocket[] = [];

type LiveEventsOptions = Parameters<typeof setupLiveEventsWebSocketServer>[2];

function setupTrackedWebSocketServer(server: EventEmitter, db: unknown, opts: LiveEventsOptions) {
  const wss = setupLiveEventsWebSocketServer(server as never, db as never, opts) as unknown as WebSocketServer;
  activeWebSocketServers.push(wss);
  return wss;
}

function createAuthDb(seed: {
  memberships?: Array<{ companyId: string }>;
  roles?: Array<{ id: string }>;
  keys?: unknown[];
} = {}) {
  const selectedTables: unknown[] = [];
  const db = {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => {
          selectedTables.push(table);
          if (table === companyMemberships) return Promise.resolve(seed.memberships ?? []);
          if (table === instanceUserRoles) return Promise.resolve(seed.roles ?? []);
          if (table === agentApiKeys) return Promise.resolve(seed.keys ?? []);
          return Promise.resolve([]);
        },
      }),
    })),
    update: vi.fn(),
  };
  return { db, selectedTables };
}

async function listen(server: HttpServer) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not listen on a TCP port");
  return address.port;
}

async function createWsHarness(db: unknown, opts: LiveEventsOptions) {
  const server = createServer();
  activeHttpServers.push(server);
  setupTrackedWebSocketServer(server, db, opts);
  const port = await listen(server);
  return {
    connect(headers?: Record<string, string>) {
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/companies/company-1/events/ws`, { headers });
      activeClients.push(client);
      client.on("error", () => undefined);
      return client;
    },
  };
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(assertion: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await flushPromises();
  }
  throw new Error("Timed out waiting for websocket state");
}

function waitForOpen(client: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    client.once("open", resolve);
    client.once("error", reject);
  });
}

function waitForClose(client: WebSocket) {
  return new Promise<void>((resolve) => client.once("close", () => resolve()));
}

function waitForUnexpectedStatus(client: WebSocket) {
  return new Promise<number>((resolve, reject) => {
    client.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    client.once("open", () => reject(new Error("websocket unexpectedly upgraded")));
    client.once("error", reject);
  });
}

async function closeClient(client: WebSocket) {
  if (client.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    const finish = () => {
      clearTimeout(timeout);
      client.off("close", finish);
      resolve();
    };
    timeout = setTimeout(finish, 1_000);
    client.once("close", finish);
    client.terminate();
  });
}

async function closeWebSocketServer(wss: WebSocketServer) {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}

async function closeHttpServer(server: HttpServer) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await Promise.all(activeClients.splice(0).map(closeClient));
    await Promise.all(activeWebSocketServers.splice(0).map(closeWebSocketServer));
    await Promise.all(activeHttpServers.splice(0).map(closeHttpServer));
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupTrackedWebSocketServer(server, {}, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupTrackedWebSocketServer(server, {}, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupTrackedWebSocketServer(server, {}, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });

  it("authorizes a session only after current membership and the member-device guard pass", async () => {
    const { db, selectedTables } = createAuthDb({ memberships: [{ companyId: "company-1" }] });
    const guard = vi.fn(async () => undefined);
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "member-1" } }) as never);
    const harness = await createWsHarness(db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      authorizeMemberDevice: guard,
    });
    const client = harness.connect();
    await waitForOpen(client);

    expect(resolveSessionFromHeaders).toHaveBeenCalledOnce();
    expect(selectedTables).toContain(companyMemberships);
    expect(selectedTables).toContain(instanceUserRoles);
    expect(guard).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ url: "/api/companies/company-1/events/ws" }),
      "company-1",
      "member-1",
    );
  });

  it("does not upgrade when the member-device guard denies the session", async () => {
    const { db } = createAuthDb({ memberships: [{ companyId: "company-1" }] });
    const guard = vi.fn(async () => { throw new Error("member device revoked"); });
    const harness = await createWsHarness(db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async () => ({ user: { id: "member-1" } }) as never,
      authorizeMemberDevice: guard,
    });
    const client = harness.connect();

    await expect(waitForUnexpectedStatus(client)).resolves.toBe(403);
    expect(guard).toHaveBeenCalledOnce();
  });

  it("does not let an instance-admin session bypass the guard without current membership", async () => {
    const { db } = createAuthDb({ roles: [{ id: "admin-role" }] });
    const guard = vi.fn(async () => undefined);
    const harness = await createWsHarness(db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: async () => ({ user: { id: "admin-1" } }) as never,
      authorizeMemberDevice: guard,
    });
    const client = harness.connect();

    await expect(waitForUnexpectedStatus(client)).resolves.toBe(403);
    expect(guard).not.toHaveBeenCalled();
  });

  it("does not let local-trusted implicit board access bypass the guard", async () => {
    const { db } = createAuthDb();
    const guard = vi.fn(async () => undefined);
    const harness = await createWsHarness(db, {
      deploymentMode: "local_trusted",
      authorizeMemberDevice: guard,
    });
    const client = harness.connect();

    await expect(waitForUnexpectedStatus(client)).resolves.toBe(403);
    expect(guard).not.toHaveBeenCalled();
  });

  it("does not let an agent bearer token bypass the guard", async () => {
    const { db, selectedTables } = createAuthDb({
      keys: [{ id: "agent-key", companyId: "company-1", agentId: "agent-1" }],
    });
    const guard = vi.fn(async () => undefined);
    const harness = await createWsHarness(db, {
      deploymentMode: "authenticated",
      authorizeMemberDevice: guard,
    });
    const client = harness.connect({ authorization: "Bearer legacy-agent-token" });

    await expect(waitForUnexpectedStatus(client)).resolves.toBe(403);
    expect(guard).not.toHaveBeenCalled();
    expect(selectedTables).toEqual([]);
  });

  it("revalidates before each event and terminates the socket after device revocation", async () => {
    const { db } = createAuthDb({ memberships: [{ companyId: "company-1" }] });
    let revoked = false;
    const guard = vi.fn(async () => {
      if (revoked) throw new Error("member device revoked");
    });
    const resolveSessionFromHeaders = vi.fn(async () => ({ user: { id: "member-1" } }) as never);
    const harness = await createWsHarness(db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      authorizeMemberDevice: guard,
    });
    const client = harness.connect();
    const received: Array<{ payload: Record<string, unknown> }> = [];
    client.on("message", (data) => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : data.toString("utf8");
      received.push(JSON.parse(text) as { payload: Record<string, unknown> });
    });
    await waitForOpen(client);
    expect(guard).toHaveBeenCalledOnce();

    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: { marker: "before-revocation" } });
    await waitFor(() => received.length === 1 && guard.mock.calls.length === 2);
    expect(received[0]?.payload.marker).toBe("before-revocation");

    revoked = true;
    const closed = waitForClose(client);
    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: { marker: "after-revocation" } });
    await closed;

    expect(guard).toHaveBeenCalledTimes(3);
    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(3);
    expect(received).toHaveLength(1);
    expect(received[0]?.payload.marker).toBe("before-revocation");
  });

  it.each([
    { name: "logged-out session", currentSession: null },
    { name: "changed session user", currentSession: { user: { id: "other-member" } } },
  ])("does not deliver events or retain the socket when the session is $name", async ({ currentSession }) => {
    const { db } = createAuthDb({ memberships: [{ companyId: "company-1" }] });
    let sessionReads = 0;
    const resolveSessionFromHeaders = vi.fn(async () => {
      sessionReads += 1;
      return (sessionReads === 1 ? { user: { id: "member-1" } } : currentSession) as never;
    });
    const guard = vi.fn(async () => undefined);
    const harness = await createWsHarness(db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      authorizeMemberDevice: guard,
    });
    const client = harness.connect();
    const received: string[] = [];
    client.on("message", () => received.push("message"));
    await waitForOpen(client);
    expect(guard).toHaveBeenCalledOnce();

    const closed = waitForClose(client);
    publishLiveEvent({ companyId: "company-1", type: "heartbeat.run.status", payload: { marker: "must-not-arrive" } });
    await closed;

    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(2);
    expect(guard).toHaveBeenCalledOnce();
    expect(received).toEqual([]);
  });
});
