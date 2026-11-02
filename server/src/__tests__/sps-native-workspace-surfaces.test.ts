import { createHash, randomBytes, randomUUID, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authSessions,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  spsMemberDeviceEvents,
  spsMemberDevices,
  spsPluginInboxItems,
  spsPluginInboxUserStates,
} from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { spsMemberDeviceService } from "../services/sps-member-devices.js";
import { spsWorkspaceExecutionControlService } from "../services/sps-workspace-execution-control.js";
import { createSpsNativeWorkspaceProofVerifier } from "../services/sps-native-workspace-proof.js";
import { createSpsNativeWorkspaceSurfaceReader } from "../services/sps-native-workspace-surfaces.js";
import type { SpsNativePluginPrincipal, SpsNativePluginRequest } from "../services/sps-native-plugin-runtime.js";
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
  body?: Buffer;
  contentType?: string;
}) {
  const body = input.body ?? Buffer.alloc(0);
  const contentType = input.contentType ?? "";
  const fields = [1, HOST_ID, input.workspaceId, input.method ?? "GET", input.target,
    randomBytes(32).toString("base64url"), Date.now(), createHash("sha256").update(body).digest("hex"),
    input.cookie ?? COOKIE, contentType, input.certificate];
  const bytes = Buffer.from(JSON.stringify(fields), "utf8");
  return { header: `${bytes.toString("base64url")}.${createHmac("sha256", input.key).update(bytes).digest("base64url")}`,
    actual: { method: input.method ?? "GET", target: input.target, body, cookie: input.cookie ?? COOKIE, contentType } };
}

describeDatabase("Native read-only Workspace surface consumer", () => {
  let db!: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let certificate!: MemberTlsFixture;
  let companyId!: string;
  let companyIssuePrefix!: string;
  let secondCompanyId!: string;
  let secondCompanyIssuePrefix!: string;
  let currentIdentity!: ReturnType<typeof createSpsIdentityAuth>;
  let service!: ReturnType<typeof createSpsNativeWorkspaceSurfaceReader>;
  let privateHttp!: ReturnType<typeof createSpsNativeWorkspaceHttpServer>;
  let privateAddress!: Readonly<{ host: "127.0.0.1"; port: number }>;
  let key: Buffer;
  let verifier: ReturnType<typeof createSpsNativeWorkspaceProofVerifier>;
  let registeredDeviceId: string;
  let inboxItemId: string;
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
    companyIssuePrefix = `N${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    await db.insert(companies).values({ id: companyId, name: "Native Workspace Fixture",
      issuePrefix: companyIssuePrefix });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: USER_ID,
      status: "active", membershipRole: "member" });
    secondCompanyId = randomUUID();
    secondCompanyIssuePrefix = `N${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
    await db.insert(companies).values({ id: secondCompanyId, name: "Second Native Workspace Fixture",
      issuePrefix: secondCompanyIssuePrefix });
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
  }, process.platform === "win32" ? 180_000 : 60_000);

  afterAll(async () => {
    await privateHttp?.dispose();
    verifier?.dispose();
    if (companyId) await db?.delete(activityLog).where(eq(activityLog.companyId, companyId));
    await db?.delete(spsMemberDeviceEvents);
    await db?.delete(spsMemberDevices);
    await db?.delete(spsPluginInboxUserStates);
    await db?.delete(spsPluginInboxItems);
    await db?.delete(companyMemberships);
    await db?.delete(companies);
    await db?.delete(authSessions);
    await db?.delete(authUsers);
    await certificate?.cleanup();
    await db?.$client.end();
    await database?.cleanup();
  }, process.platform === "win32" ? 60_000 : 30_000);

  afterEach(async () => {
    if (inboxItemId) {
      await db.delete(spsPluginInboxUserStates).where(eq(spsPluginInboxUserStates.itemId, inboxItemId));
      await db.delete(spsPluginInboxItems).where(eq(spsPluginInboxItems.id, inboxItemId));
      inboxItemId = "";
    }
    await db.update(spsMemberDevices).set({ status: "approved", revokedAt: null })
      .where(eq(spsMemberDevices.id, registeredDeviceId));
  });

  const read = (path: string, workspaceId: string | null = companyId, method = "GET", cookie = COOKIE, cert = certificate.certificate,
    body = Buffer.alloc(0), contentType = "") => {
    const request = signedHeader({ key, workspaceId, target: path, certificate: cert, method, cookie, body, contentType });
    return service.read(request.header, request.actual);
  };

  it("authorizes the private Plugin runtime outside DB locks and rejects revoked-device late results", async () => {
    const target = "/sps-native/v1/plugin-runtime";
    const body = Buffer.from(JSON.stringify({ pluginId: randomUUID(), surface: "widget", surfaceId: "summary",
      operation: "action", key: "save", params: {} }));
    let available = false, revoke = false, calls = 0;
    const runtime = { dispose() {}, async invoke(input: SpsNativePluginRequest,
      authorize: () => Promise<SpsNativePluginPrincipal>) {
      calls++;
      expect(input.workspaceId).toBe(companyId);
      expect(await authorize()).toMatchObject({ userId: USER_ID, deviceId: registeredDeviceId });
      if (revoke) await deviceService.revoke(registeredDeviceId, USER_ID);
      return { saved: true };
    } };
    const consumer = createSpsNativeWorkspaceSurfaceReader({ db, identity: currentIdentity, hostId: HOST_ID,
      verifier, assertCurrent() {}, getPluginRuntime: () => available ? runtime : undefined });
    const request = () => signedHeader({ key, target, workspaceId: companyId, certificate: certificate.certificate,
      method: "POST", contentType: "application/json", body });
    let signed = request(); await expect(consumer.read(signed.header, signed.actual)).rejects.toThrow();
    expect(calls).toBe(0); available = true;
    signed = request(); await expect(consumer.read(signed.header, signed.actual)).resolves.toEqual({ data: { saved: true } });
    revoke = true;
    signed = request(); await expect(consumer.read(signed.header, signed.actual)).rejects.toThrow();
    expect(calls).toBe(2);
    signed = request(); await expect(consumer.read(signed.header, signed.actual)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  function overPrivateHttp(path: string, options: { cookie?: string; header?: string; cert?: string; workspaceId?: string | null;
    method?: string; body?: Buffer; contentType?: string } = {}) {
    const signed = signedHeader({ key, workspaceId: options.workspaceId === undefined ? companyId : options.workspaceId, target: path,
      certificate: options.cert ?? certificate.certificate, cookie: options.cookie ?? COOKIE,
      method: options.method, body: options.body, contentType: options.contentType });
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const request = httpRequest({ hostname: privateAddress.host, port: privateAddress.port, path,
        method: options.method ?? "GET", agent: false, headers: {
          ...(options.header === "" ? {} : { "x-sps-native-workspace-proof": options.header ?? signed.header }),
          ...(options.cookie === "" ? {} : { Cookie: options.cookie ?? COOKIE }),
          ...(options.contentType ? { "Content-Type": options.contentType } : {}),
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
        if (options.body) request.end(options.body);
        else request.end();
    });
  }

  it("serves the bounded existing read surfaces through Core services", async () => {
    expect(await read(`/api/companies/${companyId}/workspace-shell/providers`)).toEqual([]);
    expect(await read(`/api/companies/${companyId}/workspace-shell`)).toMatchObject({ mode: "neutral" });
    expect(await read(`/api/companies/${companyId}/workspace-dashboard`)).toEqual({ widgets: [] });
    expect(await read(`/api/companies/${companyId}/workspace-inbox`)).toEqual({ items: [] });
    expect(await read(`/api/companies/${companyId}/workspace-inbox?archived=true`)).toEqual({ items: [] });
    expect(await read(`/api/companies/${companyId}/workspace-inbox?archived=false`)).toEqual({ items: [] });
  });

  it("returns a closed Member-readable Workspace execution DTO with no Host control authority", async () => {
    const target = `/api/companies/${companyId}/execution-control`;
    const result = await read(target);
    expect(result).toEqual({ state: "running", epoch: "0", revision: 0, updatedAt: null,
      pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 }, canControl: false });
    expect(Object.keys(result as object).sort()).toEqual(["canControl", "epoch", "pending", "revision", "state", "updatedAt"]);
    expect(await overPrivateHttp(target)).toEqual({ status: 200, body: result });
    await expect(read(target, secondCompanyId, "GET", UNMEMBERED_SECRET)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
    await expect(read(`/api/companies/${companyId}/execution-control?extra=true`)).rejects.toMatchObject({ code: "native_workspace_unavailable" });

    const stopped = await spsWorkspaceExecutionControlService(db).transition(companyId, "stop", USER_ID, 0);
    expect(stopped).toMatchObject({ state: "stopped", epoch: "1", revision: 1 });
    const stoppedResult = await read(target);
    expect(stoppedResult).toMatchObject({ state: "stopped", epoch: "1", revision: 1, canControl: false,
      pending: { agents: 0, jobs: 0, models: 0, commands: 0, plugins: 0 } });
    const post = signedHeader({ key, workspaceId: companyId, target, certificate: certificate.certificate,
      method: "POST", body: Buffer.from('{"action":"resume","expectedRevision":1}'), contentType: "application/json" });
    await expect(service.read(post.header, post.actual)).rejects.toMatchObject({ code: "native_workspace_unavailable" });

    await db.update(companyMemberships).set({ status: "revoked" }).where(eq(companyMemberships.companyId, companyId));
    await expect(read(target)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
    await db.update(companyMemberships).set({ status: "active" }).where(eq(companyMemberships.companyId, companyId));
    await db.update(spsMemberDevices).set({ status: "revoked", revokedAt: new Date() })
      .where(eq(spsMemberDevices.id, registeredDeviceId));
    await expect(read(target)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
  });

  it("updates only the authenticated Member's inbox state on the exact PATCH contract", async () => {
    const [inboxItem] = await db.insert(spsPluginInboxItems).values({
      companyId,
      sourcePluginId: null,
      sourcePluginKey: "test-plugin",
      externalId: `native-${randomUUID()}`,
      targetUserId: USER_ID,
      category: "test",
      severity: "info",
      title: "Member inbox fixture",
      summary: "Inbox state fixture",
      navigationTarget: null,
      actionIds: [],
      opaqueReference: {},
      withdrawnAt: null,
    }).returning({ id: spsPluginInboxItems.id });
    inboxItemId = inboxItem!.id;
    const target = `/api/companies/${companyId}/workspace-inbox/${inboxItemId}`;
    const body = Buffer.from('{"read":true,"archived":true}', "utf8");
    const result = await read(target, companyId, "PATCH", COOKIE, certificate.certificate, body, "application/json");
    expect(Object.keys(result as object).sort()).toEqual(["archivedAt", "readAt"]);
    expect(result).toMatchObject({ readAt: expect.any(String), archivedAt: expect.any(String) });
    expect(await overPrivateHttp(target, { method: "PATCH", body, contentType: "application/json" }))
      .toMatchObject({ status: 200, body: { readAt: expect.any(String), archivedAt: expect.any(String) } });

    await expect(read(target, secondCompanyId, "PATCH", COOKIE, certificate.certificate, body, "application/json"))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });
    const viewerTarget = `/api/companies/${secondCompanyId}/workspace-inbox/${randomUUID()}`;
    await expect(read(viewerTarget, secondCompanyId, "PATCH", COOKIE, certificate.certificate, body, "application/json"))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });

    for (const [badBody, contentType] of [
      [Buffer.from("{}"), "application/json"],
      [Buffer.from('{"read":true,"extra":false}'), "application/json"],
      [Buffer.from('{"read":"true"}'), "application/json"],
      [Buffer.from('{ "read": true }'), "application/json"],
      [Buffer.from('{"read":true}'), "text/plain"],
      [Buffer.from("x".repeat(129)), "application/json"],
    ] as const) {
      await expect(read(target, companyId, "PATCH", COOKIE, certificate.certificate, badBody, contentType))
        .rejects.toMatchObject({ code: "native_workspace_unavailable" });
    }
    await expect(read(target, companyId, "GET", COOKIE, certificate.certificate, body, "application/json"))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });

    const rollbackReader = createSpsNativeWorkspaceSurfaceReader({
      db,
      identity: currentIdentity,
      hostId: HOST_ID,
      verifier,
      assertCurrent: (() => {
        let checks = 0;
        return () => { if (++checks === 6) throw new Error("parent authority changed after mutation"); };
      })(),
    });
    const rollback = signedHeader({ key, workspaceId: companyId, target, certificate: certificate.certificate,
      method: "PATCH", body: Buffer.from('{"read":false,"archived":false}'), contentType: "application/json" });
    await expect(rollbackReader.read(rollback.header, rollback.actual))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });
    expect(await db.select().from(spsPluginInboxUserStates)
      .where(eq(spsPluginInboxUserStates.itemId, inboxItemId))).toHaveLength(1);
    expect(await db.select().from(spsPluginInboxUserStates)
      .where(eq(spsPluginInboxUserStates.itemId, inboxItemId))).toMatchObject([
      { readAt: expect.any(Date), archivedAt: expect.any(Date) },
    ]);
  });

  it("returns only the exact session-bound Workspace bootstrap DTO after current Member authorization", async () => {
    const target = `/api/companies/${companyId}/workspace-bootstrap`;
    const result = await read(target);
    expect(result).toEqual({
      v: 1,
      kind: "sps.native.workspace.bootstrap",
      workspace: { id: companyId, name: "Native Workspace Fixture", issuePrefix: companyIssuePrefix },
      member: { userId: USER_ID },
      capabilities: ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read", "workspace.inbox.state.write"],
    });
    expect(Object.keys(result as object).sort()).toEqual(["capabilities", "kind", "member", "v", "workspace"]);
    expect("hostId" in (result as object)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SESSION_SECRET);
    expect(JSON.stringify(result)).not.toContain(certificate.certificate);
    expect(await overPrivateHttp(target)).toEqual({ status: 200, body: result });

    expect(await read(`/api/companies/${secondCompanyId}/workspace-bootstrap`, secondCompanyId)).toEqual({
      v: 1,
      kind: "sps.native.workspace.bootstrap",
      workspace: { id: secondCompanyId, name: "Second Native Workspace Fixture", issuePrefix: secondCompanyIssuePrefix },
      member: { userId: USER_ID },
      capabilities: ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read"],
    });
    await expect(read(`/api/companies/${secondCompanyId}/workspace-bootstrap`, companyId))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });
    await expect(read(target, companyId, "GET", UNMEMBERED_COOKIE))
      .rejects.toMatchObject({ code: "native_workspace_unavailable" });

    await db.update(companyMemberships).set({ status: "revoked" })
      .where(eq(companyMemberships.companyId, companyId));
    await expect(read(target)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
    await db.update(companyMemberships).set({ status: "active" })
      .where(eq(companyMemberships.companyId, companyId));

    await db.update(spsMemberDevices).set({ status: "revoked", revokedAt: new Date() })
      .where(eq(spsMemberDevices.id, registeredDeviceId));
    await expect(read(target)).rejects.toMatchObject({ code: "native_workspace_unavailable" });
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
