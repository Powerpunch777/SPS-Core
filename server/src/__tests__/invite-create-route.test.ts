import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logActivityMock = vi.fn();
const canUserMock = vi.fn();
const getMembershipMock = vi.fn();

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    accessService: () => ({
      isInstanceAdmin: vi.fn(),
      canUser: canUserMock,
      getMembership: getMembershipMock,
      hasPermission: vi.fn(),
    }),
    agentService: () => ({
      getById: vi.fn(),
    }),
    boardAuthService: () => ({
      createChallenge: vi.fn(),
      resolveBoardAccess: vi.fn(),
      assertCurrentBoardKey: vi.fn(),
      revokeBoardApiKey: vi.fn(),
    }),
    deduplicateAgentName: vi.fn(),
    logActivity: (...args: unknown[]) => logActivityMock(...args),
    notifyHireApproved: vi.fn(),
  }));
}

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    companyId: "company-1",
    inviteType: "company_join",
    allowedJoinTypes: "human",
    tokenHash: "hash",
    defaultsPayload: { humanRole: "viewer" },
    expiresAt: new Date("2027-03-10T00:00:00.000Z"),
    invitedByUserId: null,
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };

  return {
    insert() {
      return {
        values() {
          return {
            returning() {
              return Promise.resolve([createdInvite]);
            },
          };
        },
      };
    },
    select(_shape?: unknown) {
      return {
        from() {
          const query = {
            leftJoin() {
              return query;
            },
            where() {
              return Promise.resolve([{
                name: "Acme Robotics",
                brandColor: "#114488",
                logoAssetId: "logo-1",
              }]);
            },
          };
          return query;
        },
      };
    },
  };
}

async function createApp(
  actorOverrides: Record<string, unknown> = {},
  routeOverrides: Record<string, unknown> = {},
) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: null,
      companyIds: ["company-1"],
      isInstanceAdmin: true,
      ...actorOverrides,
    };
    next();
  });
  app.use(
    "/api",
    accessRoutes(createDbStub() as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
      ...routeOverrides,
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /companies/:companyId/invites", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/access.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    logActivityMock.mockReset();
    canUserMock.mockReset();
    getMembershipMock.mockReset();
  });

  it("returns an absolute invite URL using the request base URL", async () => {
    const app = await createApp();

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "paperclip.example")
      .set("x-forwarded-proto", "https")
      .send({
        allowedJoinTypes: "human",
        humanRole: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.companyName).toBe("Acme Robotics");
    expect(res.body.invitePath).toMatch(/^\/invite\/sps_invite_[a-z0-9]{16}$/);
    expect(res.body.inviteUrl).toMatch(
      /^https:\/\/paperclip\.example\/invite\/sps_invite_[a-z0-9]{16}$/,
    );
  });

  it("prefers the configured public URL over a local Desktop request URL", async () => {
    const app = await createApp({}, {
      publicBaseUrl: "https://owner-pc.example.ts.net",
    });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .set("host", "127.0.0.1:31310")
      .send({
        allowedJoinTypes: "human",
        humanRole: "viewer",
      });

    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(
      /^https:\/\/owner-pc\.example\.ts\.net\/invite\/sps_invite_[a-z0-9]{16}$/,
    );
  });

  it("does not let a company admin invite a new owner", async () => {
    canUserMock.mockResolvedValue(true);
    getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "admin" });
    const app = await createApp({
      source: "board_key",
      userId: "admin-user",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only a company owner");
  });

  it("allows a company owner to invite another owner", async () => {
    canUserMock.mockResolvedValue(true);
    getMembershipMock.mockResolvedValue({ status: "active", membershipRole: "owner" });
    const app = await createApp({
      source: "board_key",
      userId: "owner-user",
      isInstanceAdmin: false,
    });

    const res = await request(app)
      .post("/api/companies/company-1/invites")
      .send({ allowedJoinTypes: "human", humanRole: "owner" });

    expect(res.status).toBe(201);
  });

  it("uses Host-only technical Member invitations in the SPS Core baseline", async () => {
    const previous = process.env.SPS_CORE_BASELINE_MODE;
    const previousDesktopToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    process.env.SPS_DESKTOP_ACCESS_TOKEN = "desktop-launch-token";
    try {
      canUserMock.mockResolvedValue(true);
      const memberApp = await createApp({
        source: "session",
        userId: "member-user",
        isInstanceAdmin: false,
      });
      const denied = await request(memberApp)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "operator" });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toContain("Only the SPS Host");

      const remoteAdminApp = await createApp({
        source: "session",
        userId: "host-user",
        isInstanceAdmin: true,
      });
      const remoteAdmin = await request(remoteAdminApp)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "operator" });
      expect(remoteAdmin.status).toBe(403);
      expect(remoteAdmin.body.error).toContain("Only the SPS Host");

      const technicalHostApp = await createApp({
        source: "session",
        userId: "host-user",
        isInstanceAdmin: true,
      });
      const technicalHost = await request(technicalHostApp)
        .post("/api/companies/company-1/invites")
        .set("Host", "127.0.0.1:31310")
        .set("x-sps-desktop-access", "desktop-launch-token")
        .set("x-sps-desktop-owner-bootstrap", "desktop-launch-token")
        .send({ allowedJoinTypes: "human", humanRole: "operator" });
      expect(technicalHost.status).toBe(201);

      const hostApp = await createApp({
        source: "local_implicit",
        userId: "host-user",
        isInstanceAdmin: false,
      });
      const disallowedPayload = await request(hostApp)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "owner" });
      expect(disallowedPayload.status).toBe(400);
      expect(disallowedPayload.body.error).toContain("technical human Member");

      const created = await request(hostApp)
        .post("/api/companies/company-1/invites")
        .send({ allowedJoinTypes: "human", humanRole: "operator" });
      expect(created.status).toBe(201);

      const legacyMembers = await request(hostApp)
        .get("/api/companies/company-1/members");
      expect(legacyMembers.status).toBe(404);
      expect(legacyMembers.body.error).toContain("provided by SPS plugins");

      const legacyRoleChange = await request(hostApp)
        .patch("/api/companies/company-1/members/member-1/role-and-grants")
        .send({ membershipRole: "admin", grants: [] });
      expect(legacyRoleChange.status).toBe(404);
      expect(legacyRoleChange.body.error).toContain("provided by SPS plugins");
    } finally {
      if (previous === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previous;
      if (previousDesktopToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
      else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousDesktopToken;
    }
  });
});
