import { createHash, randomBytes, randomUUID, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  spsMemberDeviceEvents,
  spsMemberDevices,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { spsMemberDeviceService } from "../services/sps-member-devices.js";
import { createSpsNativeWorkspaceProofVerifier } from "../services/sps-native-workspace-proof.js";
import { createSpsNativeWorkspaceSurfaceReader } from "../services/sps-native-workspace-surfaces.js";
import { createSpsNativeWorkspaceHttpServer } from "../services/sps-native-workspace-http.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const HOST_ID = randomUUID();
const USER_ID = `native-workspace-${randomUUID()}`;
const UNMEMBERED_USER_ID = `native-unmembered-${randomUUID()}`;
const EXPIRED_USER_ID = `native-expired-${randomUUID()}`;
const SESSION_SECRET = randomBytes(48).toString("base64url");
const COOKIE = `sps_identity_session=${SESSION_SECRET}`;
const UNMEMBERED_SECRET = randomBytes(48).toString("base64url");
const EXPIRED_SECRET = randomBytes(48).toString("base64url");
const UNMEMBERED_COOKIE = `sps_identity_session=${UNMEMBERED_SECRET}`;
const EXPIRED_COOKIE = `sps_identity_session=${EXPIRED_SECRET}`;
const ISSUER = "https://native-workspace.example.test";

function signedHeader(input: {
  key: Buffer;
  workspaceId: string | null;
  target: string;
  certificate: string;
  cookie?: string;
  method?: string;
}) {
  const body = Buffer.alloc(0);
  const fields = [1, HOST_ID, input.workspaceId, input.method ?? "GET", input.target,
    randomBytes(32).toString("base64url"), Date.now(), createHash("sha256").update(body).digest("hex"),
    input.cookie ?? COOKIE, "", input.certificate];
  const bytes = Buffer.from(JSON.stringify(fields), "utf8");
  return { header: `${bytes.toString("base64url")}.${createHmac("sha256", input.key).update(bytes).digest("base64url")}`,
    actual: { method: input.method ?? "GET", target: input.target, body, cookie: input.cookie ?? COOKIE, contentType: "" } };
}

describeDatabase("Native read-only Workspace surface consumer", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let certificate!: MemberTlsFixture;
  let companyId!: string;
  let secondCompanyId!: string;
  let currentIdentity!: ReturnType<typeof createSpsIdentityAuth>;
  let service!: ReturnType<typeof createSpsNativeWorkspaceSurfaceReader>;
  let privateHttp!: ReturnType<typeof createSpsNativeWorkspaceHttpServer>;
  let privateAddress!: Readonly<{ host: "127.0.0.1"; port: number }>;
  let key: Buffer;
  let verifier: ReturnType<typeof createSpsNativeWorkspaceProofVerifier>;
  let registeredDeviceId: string;
  let deviceService!: ReturnType<typeof spsMemberDeviceService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-native-workspace-surfaces-");
    db = createDb(database.connectionString);
    certificate = await createMemberTlsFixture({ purpose: "clientAuth" });
    currentIdentity = createSpsIdentityAuth(db, {
      authIdentityEnabled: true,
      authIdentityIssuer: ISSUER,
      authIdentityAudience: "sps-core",
      authIdentityJwksUrl: `${ISSUER}/.well-known/jwks.json`,
      authPublicBaseUrl: "https://native-workspace.example.test",
    } as Config);
    const now = new Date();
    await db.insert(authUsers).values({ id: USER_ID, name: "Native Member", email: `${USER_ID}@example.test`,
      emailVerified: true, createdAt: now, updatedAt: now });
    await db.insert(authUsers).values([
      { id: UNMEMBERED_USER_ID, name: "Unmembered", email: `${UNMEMBERED_USER_ID}@example.test`,
        emailVerified: true, createdAt: now, updatedAt: now },
      { id: EXPIRED_USER_ID, name: "Expired", email: `${EXPIRED_USER_ID}@example.test`,
        emailVerified: true, createdAt: now, updatedAt: now },
    ]);
    await db.insert(authSessions).values({ id: `sps_identity_${randomUUID()}`,
      token: createHash("sha256").update(SESSION_SECRET).digest("base64url"), userId: USER_ID,
      expiresAt: new Date(Date.now() + 60 * 60_000), createdAt: now, updatedAt: now,
      ipAddress: null, userAgent: null });
    await db.insert(authSessions).values([
      { id: `sps_identity_${randomUUID()}`, token: createHash("sha256").update(UNMEMBERED_SECRET).digest("base64url"),
        userId: UNMEMBERED_USER_ID, expiresAt: new Date(Date.now() + 60 * 60_000), createdAt: now, updatedAt: now,
        ipAddress: null, userAgent: null },
      { id: `sps_identity_${randomUUID()}`, token: createHash("sha256").update(EXPIRED_SECRET).digest("base64url"),
        userId: EXPIRED_USER_ID, expiresAt: new Date(Date.now() - 60_000), createdAt: now, updatedAt: now,
        ipAddress: null, userAgent: null },
    ]);
    companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Native Workspace Fixture",
      issuePrefix: `N${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: USER_ID,
      status: "active", membershipRole: "member" });
    secondCompanyId = randomUUID();
    await db.insert(companies).values({ id: secondCompanyId, name: "Second Native Workspace Fixture",
      issuePrefix: `N${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId: secondCompanyId, principalType: "user", principalId: USER_ID,
      status: "active", membershipRole: "viewer" });

    deviceService = spsMemberDeviceService(db, HOST_ID);
    const pending = await deviceService.request({ companyId, userId: USER_ID,
      displayName: "Test Member", certificate: certificate.certificate });
    registeredDeviceId = pending.id;
    await deviceService.approve(pending.id, USER_ID);

    key = randomBytes(32);
    verifier = createSpsNativeWorkspaceProofVerifier({ hostId: HOST_ID, key, assertCurrent: () => {} });
    service = createSpsNativeWorkspaceSurfaceReader({ db, identity: currentIdentity, hostId: HOST_ID,
      verifier, assertCurrent: () => {} });
    privateHttp = createSpsNativeWorkspaceHttpServer({ reader: service, assertCurrent: () => {} });
    privateAddress = await privateHttp.start();
  }, process.platform === "win32" ? 120_000 : 45_000);

  afterAll(async () => {
    await privateHttp?.dispose();
    verifier?.dispose();
    await db?.delete(spsMemberDeviceEvents);
    await db?.delete(spsMemberDevices);
    await db?.delete(companyMemberships);
    await db?.delete(companies);
    await db?.delete(authSessions);
    await db?.delete(authUsers);
    await certificate?.cleanup();
    await db?.$client.end();
    await database?.cleanup();
  }, 30_000);

  afterEach(async () => {
    await db.update(spsMemberDevices).set({ status: "approved", revokedAt: null })
      .where(eq(spsMemberDevices.id, registeredDeviceId));
  });

  const read = (path: string, workspaceId: string | null = companyId, method = "GET", cookie = COOKIE, cert = certificate.certificate) => {
    const request = signedHeader({ key, workspaceId, target: path, certificate: cert, method, cookie });
    return service.read(request.header, request.actual);
  };

  function overPrivateHttp(path: string, options: { cookie?: string; header?: string; cert?: string; workspaceId?: string | null } = {}) {
    const signed = signedHeader({ key, workspaceId: options.workspaceId === undefined ? companyId : options.workspaceId, target: path,
      certificate: options.cert ?? certificate.certificate, cookie: options.cookie ?? COOKIE });
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest({ hostname: privateAddress.host, port: privateAddress.port, path,
        method: "GET", agent: false, headers: {
          ...(options.header === "" ? {} : { "x-sps-native-workspace-proof": options.header ?? signed.header }),
          ...(options.cookie === "" ? {} : { Cookie: options.cookie ?? COOKIE }),
        } }, response => {
        const parts: Buffer[] = [];
        response.on("data", part => parts.push(Buffer.from(part)));
        response.once("error", reject);
        response.once("end", () => {
          try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(parts).toString("utf8")) }); }
          catch (error) { reject(error); }
        });
      });
      request.once("error", reject);
      request.end();
    });
  }

  it("serves only the four bounded existing read surfaces through Core services", async () => {
    expect(await read(`/api/companies/${companyId}/workspace-shell/providers`)).toEqual([]);
    expect(await read(`/api/companies/${companyId}/workspace-shell`)).toMatchObject({ mode: "neutral" });
    expect(await read(`/api/companies/${companyId}/workspace-dashboard`)).toEqual({ widgets: [] });
    expect(await read(`/api/companies/${companyId}/workspace-inbox`)).toEqual({ items: [] });
    expect(await read(`/api/companies/${companyId}/workspace-inbox?archived=true`)).toEqual({ items: [] });
    expect(await read(`/api/companies/${companyId}/workspace-inbox?archived=false`)).toEqual({ items: [] });
  });

  it("discovers only this authenticated user's active workspaces for the approved Host device", async () => {
    const target = "/sps-native/v1/workspaces";
    const signed = signedHeader({ key, workspaceId: null, target, certificate: certificate.certificate });
    expect(await service.read(signed.header, signed.actual)).toEqual([
      { id: companyId, name: "Native Workspace Fixture" },
      { id: secondCompanyId, name: "Second Native Workspace Fixture" },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(await overPrivateHttp(target, { workspaceId: null })).toMatchObject({
      status: 200,
      body: expect.arrayContaining([
        { id: companyId, name: "Native Workspace Fixture" },
        { id: secondCompanyId, name: "Second Native Workspace Fixture" },
      ]),
    });
    await expect(read(target, companyId)).rejects.toMatchObject({ code: "native_workspace_unavailable" });

    const transactionSpy = vi.spyOn(db, "transaction");
    await expect(read(target, null, "GET", `sps_identity_session=${"z".repeat(64)}`))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });
    expect(transactionSpy).not.toHaveBeenCalled();
    transactionSpy.mockRestore();

    const tx = { execute: vi.fn(async () => undefined), select: vi.fn(() => { throw new Error("authorization must precede device/workspace reads"); }) };
    const fakeDb = { transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)) };
    const deniedSessionReader = createSpsNativeWorkspaceSurfaceReader({
      db: fakeDb as never,
      identity: { resolveNativeEnrollmentSessionFromHeaders: async () => ({
        userId: USER_ID,
        authorizeInTransaction: async () => { throw new Error("session was revoked"); },
      }) } as never,
      hostId: HOST_ID,
      verifier,
      assertCurrent: () => {},
    });
    const denied = signedHeader({ key, workspaceId: null, target, certificate: certificate.certificate });
    await expect(deniedSessionReader.read(denied.header, denied.actual))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });
    expect(fakeDb.transaction).toHaveBeenCalledOnce();
    expect(tx.select).not.toHaveBeenCalled();

    await db.update(companyMemberships).set({ status: "revoked" })
      .where(eq(companyMemberships.principalId, USER_ID));
    const noMembership = signedHeader({ key, workspaceId: null, target, certificate: certificate.certificate });
    expect(await service.read(noMembership.header, noMembership.actual)).toEqual([]);
    await db.update(companyMemberships).set({ status: "active" })
      .where(eq(companyMemberships.principalId, USER_ID));

    await db.update(spsMemberDevices).set({ status: "revoked", revokedAt: new Date() })
      .where(eq(spsMemberDevices.id, registeredDeviceId));
    const revoked = signedHeader({ key, workspaceId: null, target, certificate: certificate.certificate });
    await expect(service.read(revoked.header, revoked.actual)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
  });

  it("serves the real private loopback HTTP adapter only after Core proof and Member authorization", async () => {
    const path = `/api/companies/${companyId}/workspace-shell`;
    expect(await overPrivateHttp(path)).toEqual({ status: 200, body: expect.objectContaining({ mode: "neutral" }) });
    expect(await overPrivateHttp(`/api/companies/${companyId}/workspace-dashboard`))
      .toEqual({ status: 200, body: { widgets: [] } });
    expect(await overPrivateHttp(`/api/companies/${companyId}/workspace-inbox`))
      .toEqual({ status: 200, body: { items: [] } });
    expect(await overPrivateHttp(path, { header: "" })).toEqual({
      status: 403, body: { error: "Native Workspace access is unavailable." },
    });
    expect(await overPrivateHttp(path, { cookie: `sps_identity_session=${"c".repeat(64)}` })).toEqual({
      status: 403, body: { error: "Native Workspace access is unavailable." },
    });
    expect(await overPrivateHttp(path, { cookie: UNMEMBERED_COOKIE })).toEqual({
      status: 403, body: { error: "Native Workspace access is unavailable." },
    });
    expect(await overPrivateHttp(path, { cookie: EXPIRED_COOKIE })).toEqual({
      status: 403, body: { error: "Native Workspace access is unavailable." },
    });
    const replay = signedHeader({ key, workspaceId: companyId, target: path, certificate: certificate.certificate });
    expect(await overPrivateHttp(path, { header: replay.header })).toMatchObject({ status: 200 });
    expect(await overPrivateHttp(path, { header: replay.header })).toEqual({
      status: 403, body: { error: "Native Workspace access is unavailable." },
    });
  });

  it("rejects wrong workspace, path, method, query, invalid session and non-Member authority uniformly", async () => {
    const otherWorkspace = randomUUID();
    for (const [path, workspace, method, cookie] of [
      [`/api/companies/${companyId}/workspace-shell`, otherWorkspace, "GET", COOKIE],
      [`/api/companies/${companyId}/workspace-shell?x=1`, companyId, "GET", COOKIE],
      [`/api/companies/${companyId}/workspace-inbox?archived=1`, companyId, "GET", COOKIE],
      [`/api/companies/${companyId}/workspace-dashboard`, companyId, "POST", COOKIE],
      [`/api/companies/${companyId}/agents`, companyId, "GET", COOKIE],
      [`/api/companies/${companyId}/workspace-shell`, companyId, "GET", `sps_identity_session=${"b".repeat(64)}`],
      [`/api/companies/${companyId}/workspace-shell`, companyId, "GET", UNMEMBERED_COOKIE],
      [`/api/companies/${companyId}/workspace-shell`, companyId, "GET", EXPIRED_COOKIE],
    ] as const) {
      await expect(read(path, workspace, method, cookie)).rejects.toMatchObject({
        status: 403,
        code: "native_workspace_unavailable",
        message: "Native Workspace access is unavailable.",
      });
    }
  });

  it("honors certificate revocation and current Workspace membership on each request", async () => {
    const path = `/api/companies/${companyId}/workspace-shell`;
    expect(await read(path)).toMatchObject({ mode: "neutral" });
    await spsMemberDeviceService(db, HOST_ID).revoke(registeredDeviceId, USER_ID);
    await expect(read(path)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
    await db.update(spsMemberDevices).set({ status: "approved", revokedAt: null })
      .where(eq(spsMemberDevices.id, registeredDeviceId));
    await db.update(companyMemberships).set({ status: "revoked" })
      .where(eq(companyMemberships.companyId, companyId));
    await expect(read(path)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
  });
});
