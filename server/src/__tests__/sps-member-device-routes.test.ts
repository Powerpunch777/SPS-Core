import { randomUUID } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, companyMemberships, createDb, spsMemberDevices, spsMemberDeviceEvents, spsNodes, spsWorkspaceSourceNodeGrants } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { spsMemberDeviceRoutes } from "../routes/sps-member-devices.js";
import { spsMemberDeviceService } from "../services/sps-member-devices.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const group = support.supported ? describe : describe.skip;
const HOST = randomUUID(), OTHER_HOST = randomUUID();
const USER = "member-device-route-user", HOST_USER = "member-device-route-host";
const TOKEN = "native-member-device-route-fixture";

function session(userId: string, companyId: string, admin = false): Request["actor"] {
  return { type: "board", source: "session", userId, isInstanceAdmin: admin,
    companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "member" }] };
}

group("SPS Native Member device management routes", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let certificate: MemberTlsFixture;
  let companyId: string;
  const previousToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
  beforeAll(async () => {
    process.env.SPS_DESKTOP_ACCESS_TOKEN = TOKEN;
    database = await startEmbeddedPostgresTestDatabase("member-device-routes-");
    db = createDb(database.connectionString);
    certificate = await createMemberTlsFixture();
  }, 30_000);
  afterAll(async () => {
    if (previousToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
    else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousToken;
    await certificate?.cleanup();
    await database?.cleanup();
  });
  afterEach(async () => {
    if (!db) return;
    await db.delete(spsMemberDeviceEvents);
    await db.delete(spsMemberDevices);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });
  async function workspace() {
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native route fixture", issuePrefix: `D${companyId.replaceAll("-", "").slice(0, 8)}` });
    for (const principalId of [USER, HOST_USER]) await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId, status: "active" });
    return companyId;
  }
  function app(actor: Request["actor"], hostId = HOST, onRevoked = vi.fn()) {
    const current = express();
    current.use(express.json());
    current.use((req, _res, next) => { req.actor = actor; next(); });
    current.use("/api", spsMemberDeviceRoutes(db, { hostId, onRevoked }));
    current.use(errorHandler);
    return current;
  }
  function host<T extends { set(name: string, value: string): T }>(operation: T) {
    return operation.set("Host", "127.0.0.1").set("x-sps-desktop-access", TOKEN).set("x-sps-desktop-owner-bootstrap", TOKEN);
  }
  async function register() {
    return (await request(app(session(USER, companyId))).post(`/api/companies/${companyId}/sps-member-device-requests`)
      .send({ displayName: "Member PC", certificate: certificate.certificate }).expect(201)).body;
  }
  it("registers pending for the actual user and keeps the public response certificate-free", async () => {
    await workspace();
    const row = await register();
    expect(row).toMatchObject({ hostId: HOST, ownerUserId: USER, status: "pending", revision: 1 });
    expect(row).not.toHaveProperty("certificate");
    expect(JSON.stringify(row)).not.toContain(certificate.keyPem);
    expect(JSON.stringify(row)).not.toContain(certificate.certificate);
    await expect(spsMemberDeviceService(db, HOST).authorize({ companyId, userId: USER, certificateSha256: certificate.certificateSha256 })).rejects.toMatchObject({ status: 403 });
    const own = await request(app(session(USER, companyId))).get(`/api/companies/${companyId}/sps-member-device-requests`).expect(200);
    expect(own.body.map((device: { id: string }) => device.id)).toEqual([row.id]);
  });
  it("requires both local Host proofs and a real user session for Host actions", async () => {
    await workspace();
    const row = await register();
    for (const actor of [session(USER, companyId), session(USER, companyId, true),
      { type: "board", source: "board_key", userId: USER, companyIds: [companyId], isInstanceAdmin: true } as Request["actor"],
      { type: "board", source: "local_implicit", userId: HOST_USER, isInstanceAdmin: true } as Request["actor"]]) {
      const current = app(actor);
      await request(current).post(`/api/sps/member-devices/${row.id}/approve`).send({}).expect(403);
      if (actor.source !== "session") await host(request(current).post(`/api/sps/member-devices/${row.id}/approve`)).send({}).expect(403);
    }
    await request(app(session(HOST_USER, companyId))).post(`/api/sps/member-devices/${row.id}/approve`)
      .set("Host", "127.0.0.1").set("x-sps-desktop-access", TOKEN).send({}).expect(403);
    await request(app(session(HOST_USER, companyId))).post(`/api/sps/member-devices/${row.id}/approve`)
      .set("Host", "forged.example.ts.net").set("x-sps-desktop-access", TOKEN).set("x-sps-desktop-owner-bootstrap", TOKEN).send({}).expect(403);
    await host(request(app(session(HOST_USER, companyId))).post(`/api/sps/member-devices/${row.id}/approve`)).send({}).expect(200);
  });
  it("approves and revokes without granting Node authority or reviving the certificate", async () => {
    await workspace();
    const row = await register();
    const onRevoked = vi.fn();
    const current = app(session(HOST_USER, companyId), HOST, onRevoked);
    const approved = await host(request(current).post(`/api/sps/member-devices/${row.id}/approve`)).send({}).expect(200);
    expect(approved.body.status).toBe("approved");
    expect(await db.select().from(spsNodes)).toEqual([]);
    expect(await db.select().from(spsWorkspaceSourceNodeGrants)).toEqual([]);
    await host(request(current).post(`/api/sps/member-devices/${row.id}/approve`)).send({}).expect(200);
    await host(request(current).post(`/api/sps/member-devices/${row.id}/revoke`)).send({}).expect(200);
    await host(request(current).post(`/api/sps/member-devices/${row.id}/revoke`)).send({}).expect(200);
    expect(onRevoked.mock.calls).toEqual([[row.id], [row.id]]);
    await host(request(current).post(`/api/sps/member-devices/${row.id}/approve`)).send({}).expect(409);
    expect((await register()).status).toBe("revoked");
    const history = await host(request(current).get(`/api/sps/member-devices/${row.id}/events`)).expect(200);
    expect(history.body.map((entry: { action: string }) => entry.action).sort()).toEqual(["approved", "request", "revoked"]);
    expect(JSON.stringify(history.body)).not.toContain(certificate.certificate);
  });
  it("keeps Host and Workspace scopes authoritative, not request overrides or stale actor membership", async () => {
    await workspace();
    const row = await register();
    await host(request(app(session(HOST_USER, companyId), OTHER_HOST)).post(`/api/sps/member-devices/${row.id}/approve`)).send({}).expect(404);
    const other = await host(request(app(session(HOST_USER, companyId), OTHER_HOST)).get("/api/sps/member-devices")).expect(200);
    expect(other.body).toEqual([]);
    await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.principalId, USER));
    await request(app(session(USER, companyId))).get(`/api/companies/${companyId}/sps-member-device-requests`).expect(403);
  });
  it("rejects status, identity, private-key, action and query overrides", async () => {
    await workspace();
    const current = app(session(USER, companyId));
    for (const extra of [{ ownerUserId: HOST_USER }, { hostId: OTHER_HOST }, { status: "approved" }, { privateKey: certificate.keyPem }]) {
      const response = await request(current).post(`/api/companies/${companyId}/sps-member-device-requests`)
        .send({ displayName: "Member PC", certificate: certificate.certificate, ...extra }).expect(400);
      expect(JSON.stringify(response.body)).not.toContain(certificate.keyPem);
    }
    const row = await register();
    const owner = app(session(HOST_USER, companyId));
    await host(request(owner).post(`/api/sps/member-devices/${row.id}/approve`)).send({ status: "approved" }).expect(400);
    await host(request(owner).get("/api/sps/member-devices?hostId=ignored")).expect(400);
  });
});
