import express from "express";
import { get as httpGet, type IncomingMessage, type Server } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginRoutes } from "../routes/plugins.js";

const fixture = vi.hoisted(() => ({
  plugin: null as any,
  membershipStatus: "active" as string,
  policy: { workspaceId: "22222222-2222-4222-8222-222222222222", catalogRevision: "catalog-1", workspaceRevision: "workspace-1" },
  execution: { state: "running" as string, epoch: "1", revision: 1, updatedAt: null as string | null },
  registry: {
    getById: vi.fn(), getByKey: vi.fn(), listInstalled: vi.fn(), listByStatus: vi.fn(),
    getCompanySettings: vi.fn(), upsertCompanySettings: vi.fn(), upsertConfig: vi.fn(),
  },
  access: { getMembership: vi.fn(), canUser: vi.fn(), hasPermission: vi.fn() },
  lifecycle: { load: vi.fn(), upgrade: vi.fn(), unload: vi.fn(), enable: vi.fn(), disable: vi.fn(), restartWorker: vi.fn() },
  surfaces: { deleteInboxSummariesBySourcePluginKey: vi.fn() },
  authority: { read: vi.fn(), same: vi.fn() },
  executionControl: { get: vi.fn(), assertActive: vi.fn() },
  logActivity: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({ pluginRegistryService: () => fixture.registry }));
vi.mock("../services/plugin-lifecycle.js", () => ({ pluginLifecycleManager: () => fixture.lifecycle }));
vi.mock("../services/activity-log.js", () => ({ logActivity: fixture.logActivity }));
vi.mock("../services/sps-workspace-surfaces.js", () => ({ spsWorkspaceSurfaceService: () => fixture.surfaces }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/access.js", () => ({ accessService: () => fixture.access }));
vi.mock("../services/sps-plugin-authority-revision.js", () => ({
  readSpsPluginAuthorityRevision: fixture.authority.read,
  sameSpsPluginAuthorityRevision: fixture.authority.same,
}));
vi.mock("../services/sps-workspace-execution-control.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/sps-workspace-execution-control.js")>();
  return {
    ...actual,
    getSpsWorkspaceExecutionControl: fixture.executionControl.get,
    assertSpsWorkspaceExecutionActive: fixture.executionControl.assertActive,
  };
});

const workspaceId = "22222222-2222-4222-8222-222222222222";
const pluginId = "11111111-1111-4111-8111-111111111111";
const userId = "workspace-member";

function makePlugin() {
  return {
    id: pluginId,
    pluginKey: "paperclip.stream-fixture",
    packageName: "@example/stream-fixture",
    version: "1.0.0",
    apiVersion: 1,
    categories: [],
    status: "ready",
    installOrder: 1,
    packagePath: null,
    lastError: null,
    installedAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    manifestJson: {
      id: "paperclip.stream-fixture", apiVersion: 1, version: "1.0.0",
      displayName: "Stream fixture", description: "SSE auth fixture", author: "Tests",
      categories: [], capabilities: [], entrypoints: { worker: "./worker.js", workspaceWorker: "./workspace-worker.js" },
      companyActivation: { defaultEnabled: true },
    },
  };
}

type Listener = (event: unknown, eventType: "message" | "open" | "close" | "error") => void;

function makeBus(afterSubscribe: (listener: Listener) => void) {
  let listener: ((event: unknown, eventType: "message" | "open" | "close" | "error") => void) | undefined;
  let onShutdown: (() => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  return {
    subscribe: vi.fn((_pluginId: string, _channel: string, _companyId: string, next: typeof listener, shutdown?: () => void) => {
      listener = next;
      onShutdown = shutdown;
      queueMicrotask(() => { if (listener) afterSubscribe(listener); });
      return unsubscribe;
    }),
    publish(event: unknown, eventType: "message" | "open" | "close" | "error" = "message") {
      listener?.(event, eventType);
    },
    shutdown() { onShutdown?.(); },
    unsubscribe,
  };
}

async function openStream(app: express.Express, bus: ReturnType<typeof makeBus>) {
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const outgoing = httpGet(`http://127.0.0.1:${address.port}/api/plugins/${pluginId}/bridge/stream/workspace?companyId=${workspaceId}`);
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
  });
  response.setEncoding("utf8");
  let text = "";
  response.on("data", chunk => { text += chunk; });
  const ended = new Promise<void>(resolve => {
    response.once("end", resolve);
    response.once("close", resolve);
  });
  let closePromise: Promise<void> | undefined;
  return {
    statusCode: response.statusCode,
    text: () => text,
    ended,
    abort: () => outgoing.destroy(),
    close: () => closePromise ??= (async () => {
      outgoing.destroy();
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    })(),
  };
}

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 2_000;
  while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

async function createApp(bus: ReturnType<typeof makeBus>, resolveSession: (req: express.Request) => Promise<{ user: { id: string } | null } | null>,
  actorOverrides: Record<string, unknown> = {}, beforeRoute?: (response: express.Response) => void) {
  const app = express();
  app.use((req, res, next) => {
    beforeRoute?.(res);
    req.actor = {
      type: "board", source: "session", userId, isInstanceAdmin: false,
      companyIds: [workspaceId], memberships: [{ companyId: workspaceId, membershipRole: "member", status: "active" }],
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", pluginRoutes({} as never, {} as never, undefined, undefined, undefined, {
    workerManager: {} as never,
    streamBus: bus as never,
    resolveSession: resolveSession as never,
  }));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error.message });
  });
  return app;
}

describe("Workspace plugin stream authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.plugin = makePlugin();
    fixture.membershipStatus = "active";
    fixture.policy = { workspaceId, catalogRevision: "catalog-1", workspaceRevision: "workspace-1" };
    fixture.execution = { state: "running", epoch: "1", revision: 1, updatedAt: null };
    fixture.registry.getById.mockImplementation(async () => fixture.plugin);
    fixture.registry.getByKey.mockImplementation(async () => fixture.plugin);
    fixture.registry.listInstalled.mockImplementation(async () => [fixture.plugin]);
    fixture.registry.getCompanySettings.mockResolvedValue(null);
    fixture.access.getMembership.mockImplementation(async () => ({ status: fixture.membershipStatus }));
    fixture.access.canUser.mockResolvedValue(true);
    fixture.authority.read.mockImplementation(async (_db: unknown, id: string) => ({ ...fixture.policy, workspaceId: id }));
    fixture.authority.same.mockImplementation((left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right));
    fixture.executionControl.get.mockImplementation(async () => ({ ...fixture.execution }));
    fixture.executionControl.assertActive.mockImplementation(async (_db: unknown, _id: string, epoch: string) => {
      if (fixture.execution.state === "stopped" || fixture.execution.epoch !== epoch) throw new Error("stopped");
    });
  });

  it("rechecks the current session and membership before sending each event", async () => {
    const bus = makeBus(listener => {
      fixture.membershipStatus = "removed";
      listener({ marker: "secret-after-revoke" }, "message");
    });
    const resolveSession = vi.fn(async () => ({ user: { id: userId } }));
    const app = await createApp(bus, resolveSession);
    const stream = await openStream(app, bus);
    expect(stream.statusCode).toBe(200);
    await stream.ended;
    expect(stream.text()).toContain("event: close\ndata: {}");
    expect(stream.text()).not.toContain("secret-after-revoke");
    expect(resolveSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.access.getMembership).toHaveBeenCalledWith(workspaceId, "user", userId);
    expect(bus.unsubscribe).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("closes when the session resolver no longer returns the connected user", async () => {
    const bus = makeBus(listener => {
      sessionLive = false;
      listener({ marker: "secret-after-session-revoke" }, "message");
    });
    let sessionLive = true;
    const resolveSession = vi.fn(async () => sessionLive ? { user: { id: userId } } : null);
    const app = await createApp(bus, resolveSession);
    const stream = await openStream(app, bus);
    expect(stream.statusCode).toBe(200);
    await stream.ended;
    expect(stream.text()).not.toContain("secret-after-session-revoke");
    expect(bus.unsubscribe).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("ends synchronously on terminal bus shutdown without another authority lookup", async () => {
    const bus = makeBus(() => undefined);
    const resolveSession = vi.fn(async () => ({ user: { id: userId } }));
    const app = await createApp(bus, resolveSession);
    const stream = await openStream(app, bus);
    expect(stream.statusCode).toBe(200);
    const checksBeforeShutdown = resolveSession.mock.calls.length;

    bus.shutdown();
    await stream.ended;

    expect(stream.text()).toContain("event: close\ndata: {}");
    expect(resolveSession).toHaveBeenCalledTimes(checksBeforeShutdown);
    expect(bus.unsubscribe).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("closes on private policy changes without requiring a running worker to subscribe", async () => {
    const bus = makeBus(listener => {
      fixture.policy = { ...fixture.policy, workspaceRevision: "workspace-2" };
      listener({ marker: "secret-after-policy-change" }, "message");
    });
    const resolveSession = vi.fn(async () => ({ user: { id: userId } }));
    const app = await createApp(bus, resolveSession);
    const stream = await openStream(app, bus);
    expect(stream.statusCode).toBe(200);
    await stream.ended;
    expect(stream.text()).not.toContain("secret-after-policy-change");
    expect(bus.unsubscribe).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("closes when the Workspace execution epoch changes", async () => {
    const bus = makeBus(listener => {
      fixture.execution = { ...fixture.execution, state: "stopped", epoch: "2" };
      listener({ marker: "secret-after-stop" }, "message");
    });
    const resolveSession = vi.fn(async () => ({ user: { id: userId } }));
    const app = await createApp(bus, resolveSession);
    const stream = await openStream(app, bus);
    expect(stream.statusCode).toBe(200);
    await stream.ended;
    expect(stream.text()).not.toContain("secret-after-stop");
    expect(bus.unsubscribe).toHaveBeenCalledOnce();
    await stream.close();
  });

  it("keeps a current Host session stream open without requiring a membership row", async () => {
    const previousBaseline = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "false";
    try {
      const bus = makeBus(listener => listener({ marker: "host-session-event" }, "close"));
      const resolveSession = vi.fn(async () => ({ user: { id: userId } }));
      const app = await createApp(bus, resolveSession, { isInstanceAdmin: true, memberships: [] });
      const stream = await openStream(app, bus);
      expect(stream.statusCode).toBe(200);
      await stream.ended;
      expect(stream.text()).toContain("host-session-event");
      expect(resolveSession).toHaveBeenCalled();
      expect(fixture.access.getMembership).not.toHaveBeenCalled();
      await stream.close();
    } finally {
      if (previousBaseline === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previousBaseline;
    }
  });

  it("closes a Host session stream when the session resolver revokes the user", async () => {
    const previousBaseline = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "false";
    try {
      const bus = makeBus(listener => listener({ marker: "must-not-deliver" }, "message"));
      const resolveSession = vi.fn(async () => null);
      const app = await createApp(bus, resolveSession, { isInstanceAdmin: true, memberships: [] });
      const stream = await openStream(app, bus);
      await stream.ended;
      expect(stream.statusCode).not.toBe(200);
      expect(stream.text()).not.toContain("must-not-deliver");
      expect(bus.subscribe).not.toHaveBeenCalled();
      await stream.close();
    } finally {
      if (previousBaseline === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previousBaseline;
    }
  });

  it("drops a queued event when reauthentication is still pending after the client aborts", async () => {
    const bus = makeBus(() => {});
    let releaseReauth!: (result: { user: { id: string } }) => void;
    let signalSecondCall!: () => void;
    const secondCall = new Promise<void>(resolve => { signalSecondCall = resolve; });
    let callCount = 0;
    const resolveSession = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return { user: { id: userId } };
      signalSecondCall();
      return await new Promise<{ user: { id: string } }>(resolve => { releaseReauth = resolve; });
    });
    let serverResponse!: express.Response;
    let serverResponseClosed!: Promise<void>;
    const app = await createApp(bus, resolveSession, {}, response => {
      serverResponse = response;
      serverResponseClosed = new Promise(resolve => response.once("close", resolve));
    });
    const stream = await openStream(app, bus);
    try {
      expect(stream.statusCode).toBe(200);
      expect(bus.subscribe).toHaveBeenCalledOnce();
      bus.publish({ marker: "late-after-abort" });
      await secondCall;
      stream.abort();
      serverResponse.destroy();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          serverResponseClosed,
          new Promise<never>((_resolve, reject) => {
            closeTimer = setTimeout(() => reject(new Error("server response did not close")), 2_000);
          }),
        ]);
      } finally {
        if (closeTimer) clearTimeout(closeTimer);
      }
      await stream.close();
      releaseReauth({ user: { id: userId } });
      await Promise.resolve();
      expect(stream.text()).not.toContain("late-after-abort");
      expect(bus.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      releaseReauth?.({ user: { id: userId } });
      await stream.close();
    }
  });

  it("closes a backpressured stream when its bounded drain wait expires", async () => {
    const bus = makeBus(() => {});
    let signalBackpressure!: () => void;
    const backpressured = new Promise<void>(resolve => { signalBackpressure = resolve; });
    const resolveSession = vi.fn(async () => ({ user: { id: userId } }));
    const app = await createApp(bus, resolveSession, {}, response => {
      const originalWrite = response.write.bind(response);
      response.write = ((chunk: any, ...args: any[]) => {
        if (typeof chunk === "string" && chunk.startsWith("data: ")) {
          signalBackpressure();
          return false;
        }
        return originalWrite(chunk, ...args);
      }) as typeof response.write;
    });
    const stream = await openStream(app, bus);
    vi.useFakeTimers();
    try {
      bus.publish({ marker: "blocked-frame" });
      await backpressured;
      await vi.advanceTimersByTimeAsync(5_000);
      await stream.ended;
      expect(stream.text()).not.toContain("blocked-frame");
      expect(bus.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      await stream.close();
    }
  });
});
