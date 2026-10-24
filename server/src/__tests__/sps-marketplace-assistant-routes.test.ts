import express from "express";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { spsMarketplaceRoutes } from "../routes/sps-marketplace.js";

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const userId = "user-owner";
const otherUserId = "user-other";
const assistantAgentId = "11111111-1111-4111-8111-111111111111";
const noInvokeAgentId = "44444444-4444-4444-8444-444444444444";
const noToolsAgentId = "55555555-5555-4555-8555-555555555555";
const pausedAgentId = "66666666-6666-4666-8666-666666666666";
const otherAgentId = "77777777-7777-4777-8777-777777777777";
const sessionId = "88888888-8888-4888-8888-888888888888";

const mockAccess = vi.hoisted(() => ({
  decide: vi.fn(),
}));

const mockHeartbeat = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockAssistant = vi.hoisted(() => ({
  getSession: vi.fn(),
  listMessages: vi.fn(),
  getOrCreateSession: vi.fn(),
  appendMessage: vi.fn(),
  closeSession: vi.fn(),
}));

vi.mock("../compat/paperclip/control-plane.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../compat/paperclip/control-plane.js")>();
  return {
    ...actual,
    accessService: () => mockAccess,
    heartbeatService: () => mockHeartbeat,
    logActivity: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../services/sps-marketplace-assistant.js", () => ({
  createSpsMarketplaceAssistantService: () => mockAssistant,
}));

vi.mock("../adapters/index.js", () => ({
  getServerAdapter: (adapterType: string) => ({
    supportsLocalAgentJwt: adapterType !== "no-jwt",
    supportsExternalTools: adapterType !== "no-tools",
    acp: adapterType !== "no-acp" ? { supportsMcpStdio: true } : null,
  }),
}));

type TestActor = Record<string, unknown>;

const agents = [
  {
    id: assistantAgentId,
    companyId,
    name: "Marketplace Assistant",
    title: "Plugin Guide",
    icon: "search",
    adapterType: "codex_local",
    status: "idle",
  },
  {
    id: noInvokeAgentId,
    companyId,
    name: "Restricted Assistant",
    title: "No invoke grant",
    icon: null,
    adapterType: "codex_local",
    status: "idle",
  },
  {
    id: noToolsAgentId,
    companyId,
    name: "CLI Only",
    title: "No external tools",
    icon: null,
    adapterType: "no-tools",
    status: "idle",
  },
  {
    id: pausedAgentId,
    companyId,
    name: "Paused Assistant",
    title: "Paused",
    icon: null,
    adapterType: "codex_local",
    status: "paused",
  },
];

function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: async () => agents,
      }),
    }),
  } as any;
}

function boardActor(overrides: TestActor = {}): TestActor {
  return {
    type: "board",
    userId,
    source: "session",
    companyIds: [companyId],
    onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }],
    ...overrides,
  };
}

function assistantAgentActor(overrides: TestActor = {}): TestActor {
  return {
    type: "agent",
    agentId: assistantAgentId,
    companyId,
    runId: "run-1",
    onBehalfOfUserId: userId,
    onBehalfOfMemberships: [{ companyId, membershipRole: "member", status: "active" }],
    keyScope: { kind: "marketplace_assistant", sessionId },
    ...overrides,
  };
}

function createApp(actor: TestActor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Express.Request & { actor: unknown }).actor = actor;
    next();
  });
  app.use("/api", spsMarketplaceRoutes(fakeDb()));
  app.use(errorHandler);
  return app;
}

let catalogDirectory: string | undefined;

beforeEach(async () => {
  catalogDirectory = await mkdtemp(path.join(os.tmpdir(), "sps-marketplace-assistant-route-"));
  await writeFile(path.join(catalogDirectory, "catalog.json"), JSON.stringify({
    schemaVersion: 1,
    source: { id: "io.sps.official", displayName: "SPS Marketplace" },
    releases: [{
      pluginId: "plugin.one",
      version: "1.0.0",
      catalog: { displayName: "Plugin One", summary: "A plugin", categories: ["tools"] },
      capabilities: ["search"],
      publisherProfile: { displayName: "SPS" },
      compatibility: {},
    }],
  }), "utf8");
  process.env.SPS_MARKETPLACE_CATALOG_PATH = path.join(catalogDirectory, "catalog.json");
  vi.clearAllMocks();
  mockAccess.decide.mockImplementation(async ({ scope }: { scope?: { targetAgentId?: string } }) => ({
    allowed: scope?.targetAgentId === assistantAgentId,
    explanation: "Agent invoke grant is scoped to the selected Agent.",
  }));
  mockAssistant.getSession.mockImplementation(async ({ sessionId: requestedSessionId, userId: requestedUserId }: { sessionId: string; userId: string }) => {
    if (requestedSessionId !== sessionId || requestedUserId !== userId) return null;
    return { id: sessionId, companyId, userId, agentId: assistantAgentId, adapterType: "codex_local", status: "active" };
  });
  mockAssistant.listMessages.mockResolvedValue({ messages: [], nextCursor: null });
  mockAssistant.appendMessage.mockResolvedValue({ id: "message-1", role: "user", content: "find a plugin" });
  mockHeartbeat.wakeup.mockResolvedValue({ id: "run-1", status: "queued" });
});

afterEach(async () => {
  delete process.env.SPS_MARKETPLACE_CATALOG_PATH;
  if (catalogDirectory) await rm(catalogDirectory, { recursive: true, force: true });
  catalogDirectory = undefined;
});

describe("SPS Marketplace Assistant routes", () => {
  it("serves ordinary Marketplace search without invoking an AI Agent", async () => {
    const response = await request(createApp(boardActor({ memberships: [{ companyId, membershipRole: "viewer", status: "active" }] })))
      .get(`/api/companies/${companyId}/marketplace/plugins?q=plugin`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.plugins).toHaveLength(1);
    expect(mockHeartbeat.wakeup).not.toHaveBeenCalled();
    expect(mockAssistant.getSession).not.toHaveBeenCalled();
  });

  it("lists only ready Agents with agent:invoke and Marketplace Assistant adapter capability", async () => {
    const response = await request(createApp(boardActor()))
      .get(`/api/companies/${companyId}/marketplace/assistant/agents`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.agents.map((agent: { id: string }) => agent.id)).toEqual([assistantAgentId]);
    expect(mockAccess.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent:invoke",
      resource: { type: "agent", companyId, agentId: assistantAgentId },
      scope: { targetAgentId: assistantAgentId },
    }));
  });

  it("does not expose another user's session transcript", async () => {
    const response = await request(createApp(boardActor({ userId: otherUserId })))
      .get(`/api/companies/${companyId}/marketplace/assistant/sessions/${sessionId}/messages`);

    expect(response.status, JSON.stringify(response.body)).toBe(404);
    expect(mockAssistant.listMessages).not.toHaveBeenCalled();
  });

  it("rejects internal tool calls from an Agent without marketplace_assistant scope", async () => {
    const response = await request(createApp(assistantAgentActor({
      keyScope: { kind: "standard" },
    })))
      .post(`/api/companies/${companyId}/marketplace/assistant/tools/search_marketplace_plugins`)
      .send({ input: { q: "plugin" } });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it.each([
    {
      label: "different user",
      actor: assistantAgentActor({ onBehalfOfUserId: otherUserId }),
    },
    {
      label: "different Agent",
      actor: assistantAgentActor({ agentId: otherAgentId }),
    },
  ])("rejects a correctly scoped token when the session identity does not match ($label)", async ({ actor }) => {
    const response = await request(createApp(actor))
      .post(`/api/companies/${companyId}/marketplace/assistant/tools/search_marketplace_plugins`)
      .send({ input: { q: "plugin" } });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });

  it("allows exactly the two read-only tools and rejects unknown tools", async () => {
    const app = createApp(assistantAgentActor());
    const search = await request(app)
      .post(`/api/companies/${companyId}/marketplace/assistant/tools/search_marketplace_plugins`)
      .send({ input: { q: "plugin" } });
    const detail = await request(app)
      .post(`/api/companies/${companyId}/marketplace/assistant/tools/get_marketplace_plugin`)
      .send({ input: { pluginId: "plugin.one" } });
    const unknown = await request(app)
      .post(`/api/companies/${companyId}/marketplace/assistant/tools/install_plugin`)
      .send({ input: { pluginId: "plugin.one" } });

    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(search.body.plugins[0]).toMatchObject({ pluginId: "plugin.one" });
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.plugin).toMatchObject({ pluginId: "plugin.one" });
    expect(unknown.status, JSON.stringify(unknown.body)).toBe(400);
    expect(unknown.body.error).toContain("Unsupported marketplace tool");
  });

  it("does not turn an Assistant message route into a test of heartbeat execution", async () => {
    const response = await request(createApp(boardActor()))
      .post(`/api/companies/${companyId}/marketplace/assistant/sessions/${sessionId}/messages`)
      .send({ content: "find a plugin" });

    expect(response.status, JSON.stringify(response.body)).toBe(202);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledTimes(1);
    expect(mockHeartbeat.wakeup).toHaveBeenCalledWith(assistantAgentId, expect.objectContaining({
      reason: "marketplace_assistant_message",
    }));
  });

  it("rejects requests scoped to another company before using the tool bridge", async () => {
    const response = await request(createApp(assistantAgentActor()))
      .post(`/api/companies/${otherCompanyId}/marketplace/assistant/tools/search_marketplace_plugins`)
      .send({ input: { q: "plugin" } });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
  });
});
