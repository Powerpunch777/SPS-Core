import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  spsMemberDeviceEvents,
  spsMemberDevices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import {
  spsMemberDeviceService,
} from "../services/sps-member-devices.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres member device tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPS Member device service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtures: MemberTlsFixture[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-member-devices-");
    db = createDb(tempDb.connectionString);
  }, process.platform === "win32" ? 120_000 : 20_000);

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await db.delete(spsMemberDeviceEvents);
    await db.delete(spsMemberDevices);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  }, 30_000);

  async function tls(options: Parameters<typeof createMemberTlsFixture>[0] = {}) {
    const fixture = await createMemberTlsFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  async function workspace(userId: string, options: { status?: string; membership?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Member device test",
      status: options.status ?? "active",
      issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
    });
    if (options.membership !== false) {
      await db.insert(companyMemberships).values({
        companyId,
        principalType: "user",
        principalId: userId,
        status: "active",
      });
    }
    return companyId;
  }

  function service(hostId = randomUUID()) {
    return { hostId, value: spsMemberDeviceService(db, hostId) };
  }

  it("rolls back device approval and revocation when final Host session authority fails", async () => {
    const userId = "guarded-device-user", actorUserId = "guarded-host-user";
    const companyId = await workspace(userId);
    const { value } = service();
    const fixture = await tls();
    const device = await value.request({ companyId, userId, displayName: "Guarded device", certificate: fixture.certificate });
    let checks = 0;
    const denied = { userId: actorUserId, authorizeInTransaction: async () => {
      if (++checks === 2) throw new Error("Fixture session was revoked.");
    } };
    await expect(value.approve(device.id, actorUserId, denied)).rejects.toThrow("Fixture session was revoked.");
    expect((await value.listHost())[0]).toMatchObject({ status: "pending", revision: 1 });
    expect((await value.listEvents(device.id)).map(event => event.action)).toEqual(["request"]);
    await value.approve(device.id, actorUserId);
    checks = 0;
    await expect(value.revoke(device.id, actorUserId, denied)).rejects.toThrow("Fixture session was revoked.");
    expect((await value.listHost())[0]).toMatchObject({ status: "approved", revision: 2 });
    expect((await value.listEvents(device.id)).map(event => event.action).sort()).toEqual(["approved", "request"]);
    await expect(value.approve(device.id, actorUserId, { ...denied, userId: "different-user" })).rejects.toMatchObject({ code: "not_authorized" });
    await expect(value.revoke(device.id, actorUserId, { ...denied, userId: "different-user" })).rejects.toMatchObject({ code: "not_authorized" });
    expect(checks).toBe(2);
  });

  it("revalidates Host list authority after reading rows without creating a Workspace or granting access", async () => {
    const { value } = service();
    const calls: string[] = [];
    const authority = { userId: "host-without-workspace", authorizeInTransaction: async (_tx: unknown, userId: string) => {
      calls.push(userId);
      if (calls.length === 2) throw new Error("Fixture channel disconnected.");
    } };
    await expect(value.listHost(authority)).rejects.toThrow("Fixture channel disconnected.");
    expect(calls).toEqual([authority.userId, authority.userId]);
    expect(await db.select().from(companies)).toEqual([]);
    expect(await db.select().from(companyMemberships)).toEqual([]);
  });

  it("withholds event history when final Host session authority fails", async () => {
    const ownerUserId = "event-history-owner", hostUserId = "event-history-host";
    const companyId = await workspace(ownerUserId);
    const { value } = service();
    const fixture = await tls();
    const device = await value.request({ companyId, userId: ownerUserId, displayName: "Event history device", certificate: fixture.certificate });
    let checks = 0;
    const authority = { userId: hostUserId, authorizeInTransaction: async () => {
      if (++checks === 2) throw new Error("Fixture Host session ended during event history read.");
    } };

    await expect(value.listEvents(device.id, authority)).rejects.toThrow("Fixture Host session ended during event history read.");
    expect(checks).toBe(2);
    expect((await value.listEvents(device.id)).map((event) => event.action)).toEqual(["request"]);
    expect(await db.select().from(companies)).toHaveLength(1);
    expect(await db.select().from(companyMemberships)).toHaveLength(1);
  });

  it("registers a real clientAuth DER certificate, returns the shared safe DTO, and deduplicates requests", async () => {
    const userId = "user-member-device-1";
    const companyId = await workspace(userId);
    const { hostId, value } = service();
    const fixture = await tls();
    const parsed = new X509Certificate(Buffer.from(fixture.certificate, "base64url"));

    expect(parsed.ca).toBe(false);
    expect(parsed.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    expect(parsed.verify(parsed.publicKey)).toBe(true);

    const input = { companyId, userId, displayName: "Member laptop", certificate: fixture.certificate };
    const device = await value.request(input);
    const duplicate = await value.request(input);

    expect(device).toMatchObject({
      hostId,
      ownerUserId: userId,
      displayName: "Member laptop",
      certificateSha256: fixture.certificateSha256,
      spkiSha256: fixture.spkiSha256,
      status: "pending",
      revision: 1,
    });
    expect(device.certificateNotBefore).toBe(parsed.validFromDate.toISOString());
    expect(device.certificateNotAfter).toBe(parsed.validToDate.toISOString());
    expect(duplicate.id).toBe(device.id);
    expect(device).not.toHaveProperty("certificate");
    expect(JSON.stringify(device)).not.toContain(fixture.certificate);
    expect(await value.listOwn(companyId, userId)).toEqual([device]);
    expect(await value.listHost()).toEqual([device]);

    const events = await value.listEvents(device.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      hostId,
      deviceId: device.id,
      deviceSnapshotId: device.id,
      ownerUserId: userId,
      actorUserId: userId,
      action: "request",
      revision: 1,
    });
    expect(events[0]).not.toHaveProperty("certificate");
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
  });

  it("rejects non-client EKU and non-canonical base64url certificate input", async () => {
    const userId = "user-member-device-2";
    const companyId = await workspace(userId);
    const { value } = service();
    const serverCertificate = await tls({ purpose: "serverAuth" });
    const clientCertificate = await tls();
    const serverX509 = new X509Certificate(Buffer.from(serverCertificate.certificate, "base64url"));

    expect(serverX509.checkHost("localhost")).toBe("localhost");
    expect(serverX509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(serverX509.checkIP("::1")).toBe("::1");

    await expect(value.request({
      companyId,
      userId,
      displayName: "Wrong purpose",
      certificate: serverCertificate.certificate,
    })).rejects.toMatchObject({ code: "certificate_invalid", status: 400 });
    await expect(value.request({
      companyId,
      userId,
      displayName: "Padded",
      certificate: `${clientCertificate.certificate}=`,
    })).rejects.toMatchObject({ code: "certificate_invalid" });
    await expect(value.request({
      companyId,
      userId,
      displayName: "Malformed",
      certificate: "not-a-certificate",
    })).rejects.toMatchObject({ code: "certificate_invalid" });
    expect(await value.listHost()).toEqual([]);
  });

  it("requires an active Workspace and active user membership before registration or own-device reads", async () => {
    const userId = "user-member-device-3";
    const noMembershipCompanyId = await workspace(userId, { membership: false });
    const inactiveCompanyId = await workspace(userId, { status: "paused" });
    const { value } = service();
    const fixture = await tls();

    for (const companyId of [noMembershipCompanyId, inactiveCompanyId]) {
      await expect(value.request({
        companyId,
        userId,
        displayName: "Blocked",
        certificate: fixture.certificate,
      })).rejects.toMatchObject({ code: "workspace_membership_required" });
      await expect(value.listOwn(companyId, userId))
        .rejects.toMatchObject({ code: "workspace_membership_required" });
    }
    expect(await value.listHost()).toEqual([]);
  });

  it("approves atomically, authorizes in the current membership scope, and revokes once", async () => {
    const userId = "user-member-device-4";
    const actorUserId = "host-actor-4";
    const companyId = await workspace(userId);
    const { hostId, value } = service();
    const fixture = await tls();
    const requested = await value.request({
      companyId,
      userId,
      displayName: "Approved laptop",
      certificate: fixture.certificate,
    });

    const approved = await value.approve(requested.id, actorUserId);
    expect(approved).toMatchObject({ status: "approved", revision: 2, approvedByUserId: actorUserId });
    expect(await value.approve(requested.id, "another-actor")).toEqual(approved);

    const authorization = await value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 });
    expect(authorization).toEqual({
      deviceId: requested.id,
      hostId,
      userId,
      companyId,
      revision: 2,
      certificateSha256: fixture.certificateSha256,
      certificateNotAfter: new Date(approved.certificateNotAfter),
    });
    expect(authorization.certificateNotAfter).toBeInstanceOf(Date);
    const otherCompanyId = await workspace("another-member-user");
    await expect(value.authorize({ companyId: otherCompanyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
    await expect(value.authorize({ companyId, userId: "another-member-user", certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });

    const revoked = await value.revoke(requested.id, actorUserId);
    expect(revoked).toMatchObject({ status: "revoked", revision: 3 });
    expect(await value.revoke(requested.id, "another-actor")).toEqual(revoked);
    await expect(value.approve(requested.id, actorUserId))
      .rejects.toMatchObject({ code: "device_revoked" });
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });

    const events = await value.listEvents(requested.id);
    expect(events).toHaveLength(3);
    expect(events.map(({ action, revision }) => `${action}:${revision}`).sort()).toEqual([
      "approved:2",
      "request:1",
      "revoked:3",
    ]);
    expect(events.find((event) => event.action === "approved")?.actorUserId).toBe(actorUserId);
    expect(events.find((event) => event.action === "revoked")?.actorUserId).toBe(actorUserId);
  });

  it("holds current device and membership authority until a Native Workspace transaction completes", async () => {
    const userId = "user-native-workspace-transaction";
    const companyId = await workspace(userId);
    const { value } = service();
    const fixture = await tls();
    const device = await value.request({ companyId, userId, displayName: "Transaction laptop", certificate: fixture.certificate });
    await value.approve(device.id, "host-actor");
    const input = { companyId, userId, certificateSha256: fixture.certificateSha256 };

    await db.transaction(async tx => {
      expect(await value.authorizeInTransaction(tx, input)).toMatchObject({ deviceId: device.id, companyId, userId });
      // The real PostgreSQL lock timeout proves concurrent changes cannot
      // invalidate authority in the middle of the authorized transaction.
      for (const mutate of [
        async (connection: typeof tx) => connection.update(spsMemberDevices)
          .set({ status: "revoked" }).where(eq(spsMemberDevices.id, device.id)),
        async (connection: typeof tx) => connection.update(companyMemberships)
          .set({ status: "inactive" }).where(eq(companyMemberships.companyId, companyId)),
        async (connection: typeof tx) => connection.update(companies)
          .set({ status: "paused" }).where(eq(companies.id, companyId)),
      ]) {
        let conflict: unknown;
        try {
          await db.transaction(async concurrent => {
            await concurrent.execute(sql`set local lock_timeout = '100ms'`);
            await mutate(concurrent);
          });
        } catch (error) { conflict = error; }
        expect(conflict).toBeDefined();
        const cause = conflict as { code?: string; cause?: { code?: string } };
        expect(cause.code ?? cause.cause?.code).toBe("55P03");
      }
    });
    await value.revoke(device.id, "host-actor");
    await expect(db.transaction(tx => value.authorizeInTransaction(tx, input)))
      .rejects.toMatchObject({ code: "not_authorized" });
  });

  it("requires a real transaction for locked Native authorization", async () => {
    const { value } = service();
    await expect(value.authorizeInTransaction(db as never, {
      companyId: randomUUID(), userId: "member", certificateSha256: "a".repeat(64),
    })).rejects.toThrow("A Member authorization transaction is required");
  });

  it("rejects a different certificate reusing a registered SPKI and keeps revoked identities terminal", async () => {
    const userId = "user-member-device-5";
    const companyId = await workspace(userId);
    const { hostId, value } = service();
    const fixture = await tls();
    const deviceId = randomUUID();
    const previousCertificateSha256 = createHash("sha256").update("previous certificate").digest("hex");
    const now = new Date();
    await db.insert(spsMemberDevices).values({
      id: deviceId,
      hostId,
      ownerUserId: userId,
      displayName: "Prior certificate",
      certificate: "stored DER fixture",
      certificateSha256: previousCertificateSha256,
      spkiSha256: fixture.spkiSha256,
      certificateNotBefore: new Date(now.getTime() - 60_000),
      certificateNotAfter: new Date(now.getTime() + 60_000),
    });
    await expect(value.request({
      companyId,
      userId,
      displayName: "Reissued key",
      certificate: fixture.certificate,
    })).rejects.toMatchObject({ code: "device_conflict" });

    const freshKey = await tls();
    const fresh = await value.request({
      companyId,
      userId,
      displayName: "Fresh key",
      certificate: freshKey.certificate,
    });
    await value.revoke(fresh.id, "trusted-host-user");
    const repeated = await value.request({
      companyId,
      userId,
      displayName: "Fresh key",
      certificate: freshKey.certificate,
    });
    expect(repeated).toMatchObject({ id: fresh.id, status: "revoked", revision: 2 });
    await expect(value.approve(fresh.id, "trusted-host-user"))
      .rejects.toMatchObject({ code: "device_revoked" });
    expect(await value.listEvents(fresh.id)).toHaveLength(2);
  });

  it("rejects expired certificates and requires current membership during authorization", async () => {
    const userId = "user-member-device-6";
    const companyId = await workspace(userId);
    const { hostId, value } = service();
    const fixture = await tls();
    const device = await value.request({
      companyId,
      userId,
      displayName: "Expiring laptop",
      certificate: fixture.certificate,
    });
    await db.update(spsMemberDevices)
      .set({ certificateNotAfter: new Date(Date.now() - 1_000) })
      .where(andHostDevice(hostId, device.id));
    await expect(value.approve(device.id, "trusted-host-user"))
      .rejects.toMatchObject({ code: "certificate_not_valid" });

    await db.update(spsMemberDevices)
      .set({ status: "approved" })
      .where(andHostDevice(hostId, device.id));
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
    await db.update(spsMemberDevices)
      .set({ certificateNotAfter: new Date(Date.now() + 60_000) })
      .where(andHostDevice(hostId, device.id));
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .resolves.toMatchObject({ deviceId: device.id });
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active" });
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .resolves.toMatchObject({ deviceId: device.id });
    await db.update(companies).set({ status: "archived" }).where(eq(companies.id, companyId));
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
  });

  it("serializes duplicate registrations and racing Host decisions without resurrecting a revoked key", async () => {
    const userId = "member-device-race";
    const companyId = await workspace(userId);
    const { value } = service();
    const fixture = await tls();
    const input = { companyId, userId, displayName: "Concurrent device", certificate: fixture.certificate };
    const requests = await Promise.all(Array.from({ length: 4 }, () => value.request(input)));
    const deviceId = requests[0].id;
    expect(new Set(requests.map((device) => device.id)).size).toBe(1);
    expect(await value.listEvents(deviceId)).toHaveLength(1);
    const decisions = await Promise.allSettled([
      value.approve(deviceId, "local-host"), value.revoke(deviceId, "local-host"),
      value.approve(deviceId, "local-host"), value.revoke(deviceId, "local-host"),
    ]);
    for (const decision of decisions) {
      if (decision.status === "rejected") expect(decision.reason).toMatchObject({ code: "device_revoked" });
    }
    expect((await value.listHost())[0].status).toBe("revoked");
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
    const events = (await value.listEvents(deviceId)).sort((a, b) => a.revision - b.revision);
    expect(events.filter((event) => event.action === "revoked")).toHaveLength(1);
    expect(events.at(-1)?.action).toBe("revoked");
    expect(events.map((event) => event.revision)).toEqual(events.map((_event, index) => index + 1));
  });

  it("rolls an approval back when its durable security event cannot be written", async () => {
    const userId = "member-device-event-rollback";
    const companyId = await workspace(userId);
    const { value } = service();
    const fixture = await tls();
    const device = await value.request({ companyId, userId, displayName: "Atomic device", certificate: fixture.certificate });
    await db.execute(sql`ALTER TABLE sps_member_device_events ADD CONSTRAINT test_reject_approval_event CHECK (action <> 'approved')`);
    try {
      await expect(value.approve(device.id, "local-host")).rejects.toThrow();
      expect((await value.listHost())[0]).toMatchObject({ status: "pending", revision: 1, approvedAt: null });
      expect(await value.listEvents(device.id)).toHaveLength(1);
      await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
        .rejects.toMatchObject({ code: "not_authorized" });
    } finally {
      await db.execute(sql`ALTER TABLE sps_member_device_events DROP CONSTRAINT test_reject_approval_event`);
    }
    await expect(value.approve(device.id, "local-host")).resolves.toMatchObject({ status: "approved", revision: 2 });
  });

  it("retains non-authorizing history when restored device trust is deleted", async () => {
    const userId = "member-device-restore-history";
    const companyId = await workspace(userId);
    const { hostId, value } = service();
    const fixture = await tls();
    const device = await value.request({ companyId, userId, displayName: "Restore device", certificate: fixture.certificate });
    await value.approve(device.id, "local-host");
    await db.delete(spsMemberDevices).where(andHostDevice(hostId, device.id));
    const history = await value.listEvents(device.id);
    expect(history).toHaveLength(2);
    expect(history.every((event) => event.deviceId === null && event.deviceSnapshotId === device.id)).toBe(true);
    await expect(value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
    await expect(value.approve(device.id, "local-host")).rejects.toMatchObject({ code: "device_not_found" });
  });

  it("enforces constructor Host scope for every read and mutation selector", async () => {
    const userId = "user-member-device-7";
    const companyId = await workspace(userId);
    const first = service();
    const otherHost = service();
    const fixture = await tls();
    const device = await first.value.request({
      companyId,
      userId,
      displayName: "Host-specific",
      certificate: fixture.certificate,
    });
    await first.value.approve(device.id, "trusted-host-user");

    expect(await otherHost.value.listHost()).toEqual([]);
    expect(await otherHost.value.listOwn(companyId, userId)).toEqual([]);
    expect(await otherHost.value.listEvents(device.id)).toEqual([]);
    await expect(otherHost.value.approve(device.id, "trusted-host-user"))
      .rejects.toMatchObject({ code: "device_not_found" });
    await expect(otherHost.value.revoke(device.id, "trusted-host-user"))
      .rejects.toMatchObject({ code: "device_not_found" });
    await expect(otherHost.value.authorize({ companyId, userId, certificateSha256: fixture.certificateSha256 }))
      .rejects.toMatchObject({ code: "not_authorized" });
  });

  it("bounds device and event list projections to 200 and never returns stored certificate text", async () => {
    const userId = "user-member-device-8";
    const companyId = await workspace(userId);
    const { hostId, value } = service();
    const now = new Date();
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: randomUUID(),
      hostId,
      ownerUserId: userId,
      displayName: `Device ${index}`,
      certificate: `private-test-column-${index}`,
      certificateSha256: index.toString(16).padStart(64, "0"),
      spkiSha256: (index + 1000).toString(16).padStart(64, "0"),
      certificateNotBefore: new Date(now.getTime() - 60_000),
      certificateNotAfter: new Date(now.getTime() + 60_000),
    }));
    await db.insert(spsMemberDevices).values(rows);
    const deviceIds = rows.map((row) => row.id);
    await db.insert(spsMemberDeviceEvents).values(deviceIds.map((deviceId) => ({
      hostId,
      deviceId,
      deviceSnapshotId: deviceId,
      ownerUserId: userId,
      actorUserId: "trusted-host-user",
      action: "request",
      revision: 1,
    })));

    const hostDevices = await value.listHost();
    const ownDevices = await value.listOwn(companyId, userId);
    expect(hostDevices).toHaveLength(200);
    expect(ownDevices).toHaveLength(200);
    expect(hostDevices[0]).not.toHaveProperty("certificate");
    expect(JSON.stringify(hostDevices)).not.toContain("private-test-column");
    expect(await value.listEvents(deviceIds[0]!)).toHaveLength(1);

    const eventTargetId = randomUUID();
    await db.insert(spsMemberDeviceEvents).values(deviceIds.map((deviceId) => ({
      hostId,
      deviceId: null,
      deviceSnapshotId: eventTargetId,
      ownerUserId: userId,
      actorUserId: "trusted-host-user",
      action: "approved",
      revision: 2,
    })));
    expect(await value.listEvents(eventTargetId)).toHaveLength(200);
  });
});

function andHostDevice(hostId: string, deviceId: string) {
  return and(eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.id, deviceId));
}
