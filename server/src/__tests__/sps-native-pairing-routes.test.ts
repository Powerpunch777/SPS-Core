import express, { type Request } from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../services/sps-native-host-pairings.js", () => ({
  createSpsNativeHostPairings: (...args: unknown[]) => factory(...args),
  SpsNativeHostPairingDeliveryError: class SpsNativeHostPairingDeliveryError extends Error { status = 503; },
}));

import { spsNativePairingRoutes } from "../routes/sps-native-pairings.js";

const TOKEN = "fixture-desktop-launch-token";
const originalToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
afterEach(() => {
  if (originalToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
  else process.env.SPS_DESKTOP_ACCESS_TOKEN = originalToken;
  factory.mockReset();
});

function appFor(pairs: Record<string, ReturnType<typeof vi.fn>>) {
  process.env.SPS_DESKTOP_ACCESS_TOKEN = TOKEN;
  factory.mockReturnValue(pairs);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", source: "session", userId: "configured-owner", isInstanceAdmin: false,
      companyIds: [], memberships: [] } as Request["actor"];
    next();
  });
  app.use("/api", spsNativePairingRoutes({} as never, { assertActive: vi.fn(), hostId: "11111111-1111-4111-8111-111111111111",
    serverSpkiSha256: "a".repeat(64), resolveHostSession: vi.fn(), dispose: vi.fn() } as never));
  return app;
}

function local(operation: request.Test) {
  return operation.set("Host", "127.0.0.1:31310").set("x-sps-desktop-access", TOKEN)
    .set("x-sps-desktop-owner-bootstrap", TOKEN).set("Cookie", "sps_identity_session=" + "a".repeat(64));
}

describe("local SPS Native pairing routes", () => {
  it("issues exactly the one-time invite DTO, lists redacted metadata and revokes under the same local gate", async () => {
    const issue = vi.fn(async () => ({ pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "one-time-secret",
      issuedAt: 1, expiresAt: 2 }));
    const list = vi.fn(async () => [{ id: "11111111-1111-4111-8111-111111111111", status: "pending" }]);
    const revoke = vi.fn(async () => ({ id: "11111111-1111-4111-8111-111111111111", status: "revoked" }));
    const app = appFor({ issue, list, revoke });
    const created = await local(request(app).post("/api/sps/native-pairings")).send({}).expect(201);
    expect(Object.keys(created.body).sort()).toEqual(["expiresAt", "issuedAt", "pairingId", "pairingSecret"]);
    expect(created.body).toEqual({ pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "one-time-secret", issuedAt: 1, expiresAt: 2 });
    expect(created.headers["cache-control"]).toContain("no-store");
    expect(factory).toHaveBeenCalledWith({}, expect.any(Object), { maxAttempts: 5, maxActiveInvites: 10 });

    const listed = await local(request(app).get("/api/sps/native-pairings")).expect(200);
    expect(listed.body).toEqual([{ id: "11111111-1111-4111-8111-111111111111", status: "pending" }]);
    expect(listed.body[0]).not.toHaveProperty("pairingSecret");
    const revoked = await local(request(app).post("/api/sps/native-pairings/11111111-1111-4111-8111-111111111111/revoke")).send({}).expect(200);
    expect(revoked.body.status).toBe("revoked");
  });

  it("rejects missing local proof, missing actor, query parameters and nonempty action bodies", async () => {
    const pairs = { issue: vi.fn(), list: vi.fn(), revoke: vi.fn() };
    const app = appFor(pairs);
    await request(app).get("/api/sps/native-pairings").set("Host", "127.0.0.1:31310").expect(403);
    await local(request(app).get("/api/sps/native-pairings?unexpected=1")).expect(400);
    await local(request(app).post("/api/sps/native-pairings")).send({ ttlMs: 999999 }).expect(400);
    const noActor = express();
    noActor.use(express.json());
    noActor.use("/api", spsNativePairingRoutes({} as never, { assertActive: vi.fn(), hostId: "11111111-1111-4111-8111-111111111111",
      serverSpkiSha256: "a".repeat(64), resolveHostSession: vi.fn(), dispose: vi.fn() } as never));
    await local(request(noActor).get("/api/sps/native-pairings")).expect(403);
    expect(pairs.issue).not.toHaveBeenCalled();
    expect(pairs.list).not.toHaveBeenCalled();
  });
});
