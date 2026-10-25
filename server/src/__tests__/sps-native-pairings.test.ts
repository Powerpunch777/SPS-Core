import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  authUsers,
  companyMemberships,
  createDb,
  spsMemberDeviceEvents,
  spsMemberDevices,
  spsNativePairingEvents,
  spsNativePairings,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import { spsNativePairingService } from "../services/sps-native-pairings.js";
import { createSpsNativePairingSecret, hashSpsNativePairingSecret } from "../services/sps-native-pairing-crypto.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const DEFAULT_SERVER_SPKI_SHA256 = "a".repeat(64);

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres SPS native pairing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("SPS native pairing service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let fixtures: MemberTlsFixture[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-native-pairings-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await db.delete(spsNativePairingEvents);
    await db.delete(spsNativePairings);
    await db.delete(spsMemberDeviceEvents);
    await db.delete(spsMemberDevices);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function tls(options: Parameters<typeof createMemberTlsFixture>[0] = {}) {
    const fixture = await createMemberTlsFixture(options);
    fixtures.push(fixture);
    return fixture;
  }

  async function seedUser(id: string, email: string, emailVerified = true) {
    const now = new Date();
    await db.insert(authUsers).values({
      id,
      name: `User ${id}`,
      email,
      emailVerified,
      createdAt: now,
      updatedAt: now,
    });
  }

  function service(
    hostId = randomUUID(),
    policy: { maxTtlMs: number; maxAttempts: number; maxActiveInvites: number } = {
      maxTtlMs: 60_000,
      maxAttempts: 2,
      maxActiveInvites: 4,
    },
    now?: () => Date,
    serverSpkiSha256 = DEFAULT_SERVER_SPKI_SHA256,
  ) {
    const options = now ? { serverSpkiSha256, now } : { serverSpkiSha256 };
    return {
      hostId,
      value: spsNativePairingService(db, hostId, policy, options),
    };
  }

  function consumeInput(
    pairingId: string,
    pairingSecret: string,
    userId: string,
    certificate: string,
  ) {
    return { pairingId, pairingSecret, userId, displayName: "Member laptop", certificate };
  }

  it("issues a redacted one-use pairing and registers a verified first-time user without Workspace membership", async () => {
    const actorUserId = "pairing-issuer-1";
    const userId = "pairing-first-member-1";
    const email = "first-member@example.test";
    await seedUser(actorUserId, "pairing-issuer@example.test");
    await seedUser(userId, email);
    const fixture = await tls();
    const { hostId, value } = service();

    const issued = await value.issue({
      actorUserId,
      target: { kind: "verified_email", email },
      ttlMs: 30_000,
    });
    expect(Object.keys(issued).sort()).toEqual(["expiresAt", "issuedAt", "pairingId", "pairingSecret"]);
    expect(issued.issuedAt).toEqual(expect.any(Number));
    expect(issued.expiresAt - issued.issuedAt).toBe(30_000);
    expect(issued.pairingSecret).toEqual(expect.any(String));

    const listed = await value.listHost();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: issued.pairingId,
      status: "pending",
      createdAt: new Date(issued.issuedAt).toISOString(),
      expiresAt: new Date(issued.expiresAt).toISOString(),
      failedAttempts: 0,
      maxAttempts: 2,
      issuedByUserId: actorUserId,
      consumedByUserId: null,
      consumedDeviceSnapshotId: null,
      target: "verified_email",
    });
    expect(Object.keys(listed[0]!).sort()).toEqual([
      "consumedByUserId",
      "consumedDeviceSnapshotId",
      "createdAt",
      "expiresAt",
      "failedAttempts",
      "id",
      "issuedByUserId",
      "maxAttempts",
      "status",
      "target",
    ]);
    expect(JSON.stringify(listed)).not.toContain(issued.pairingSecret);
    expect(JSON.stringify(listed)).not.toContain(email);
    expect(JSON.stringify(listed)).not.toContain(fixture.certificate);

    const storedPairing = await db.select().from(spsNativePairings)
      .where(eq(spsNativePairings.id, issued.pairingId));
    expect(storedPairing).toHaveLength(1);
    expect(storedPairing[0]?.secretSha256).not.toBe(issued.pairingSecret);
    expect(JSON.stringify(storedPairing)).not.toContain(email);
    expect(await db.select({ id: companyMemberships.id }).from(companyMemberships)
      .where(eq(companyMemberships.principalId, userId))).toEqual([]);

    const device = await value.consume(consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate));
    expect(device).toMatchObject({
      hostId,
      ownerUserId: userId,
      displayName: "Member laptop",
      certificateSha256: fixture.certificateSha256,
      spkiSha256: fixture.spkiSha256,
      status: "pending",
      revision: 1,
    });
    expect(device).not.toHaveProperty("certificate");
    expect(JSON.stringify(device)).not.toContain(fixture.certificate);
    expect(await db.select().from(spsMemberDevices)
      .where(and(eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.ownerUserId, userId)))).toHaveLength(1);
    expect(await db.select().from(spsMemberDeviceEvents)
      .where(eq(spsMemberDeviceEvents.deviceSnapshotId, device.id))).toHaveLength(1);

    const consumed = await value.listHost();
    expect(consumed[0]).toMatchObject({
      id: issued.pairingId,
      status: "consumed",
      consumedByUserId: userId,
      consumedDeviceSnapshotId: device.id,
    });
    expect(JSON.stringify(consumed)).not.toContain(issued.pairingSecret);
    expect(JSON.stringify(consumed)).not.toContain(email);
    expect(JSON.stringify(consumed)).not.toContain(fixture.certificate);
    const events = await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId));
    expect(events.map((event) => event.action).sort()).toEqual(["consumed", "created"]);
    expect(events.find((event) => event.action === "consumed")?.deviceSnapshotId).toBe(device.id);
    expect(JSON.stringify(events)).not.toContain(issued.pairingSecret);
    expect(JSON.stringify(events)).not.toContain(email);
    expect(JSON.stringify(events)).not.toContain(fixture.certificate);
  });

  it("does not burn attempts for a wrong target, but commits wrong-secret attempts and exhaustion", async () => {
    const actorUserId = "pairing-issuer-attempts";
    const intendedUserId = "pairing-intended-user";
    const wrongTargetUserId = "pairing-other-user";
    const email = "intended@example.test";
    await seedUser(actorUserId, "issuer-attempts@example.test");
    await seedUser(intendedUserId, email);
    await seedUser(wrongTargetUserId, "other@example.test");
    const fixture = await tls();
    const { value } = service(randomUUID(), { maxTtlMs: 60_000, maxAttempts: 2, maxActiveInvites: 4 });
    const issued = await value.issue({ actorUserId, target: { kind: "verified_email", email }, ttlMs: 30_000 });
    const wrongSecret = "A".repeat(43);

    await expect(value.consume(consumeInput(issued.pairingId, issued.pairingSecret, wrongTargetUserId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    expect((await value.listHost())[0]).toMatchObject({ status: "pending", failedAttempts: 0 });
    expect(await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).toHaveLength(1);

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await expect(value.consume(consumeInput(issued.pairingId, wrongSecret, intendedUserId, fixture.certificate)))
        .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
      expect((await value.listHost())[0]).toMatchObject({
        status: attempt === 2 ? "exhausted" : "pending",
        failedAttempts: attempt,
      });
    }
    await expect(value.consume(consumeInput(issued.pairingId, issued.pairingSecret, intendedUserId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    const events = await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId));
    expect(events.map((event) => event.action).sort()).toEqual(["created", "exhausted", "secret_rejected"]);
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
  });

  it("uses current verified-user state and hides missing, unverified, deleted, and wrong-Host cases", async () => {
    const actorUserId = "pairing-issuer-auth";
    const verifiedUserId = "pairing-verified-user";
    const unverifiedUserId = "pairing-unverified-user";
    await seedUser(actorUserId, "issuer-auth@example.test");
    await seedUser(verifiedUserId, "verified@example.test");
    await seedUser(unverifiedUserId, "unverified@example.test", false);
    const fixture = await tls();
    const first = service();
    const otherHost = service();
    const issued = await first.value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });

    for (const userId of [unverifiedUserId, "missing-pairing-user"]) {
      await expect(first.value.consume(consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate)))
        .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    }
    await expect(otherHost.value.consume(consumeInput(
      issued.pairingId,
      issued.pairingSecret,
      verifiedUserId,
      fixture.certificate,
    ))).rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    expect(await otherHost.value.listHost()).toEqual([]);
    expect((await first.value.listHost())[0]).toMatchObject({ status: "pending", failedAttempts: 0 });

    await db.delete(authUsers).where(eq(authUsers.id, verifiedUserId));
    await expect(first.value.consume(consumeInput(issued.pairingId, issued.pairingSecret, verifiedUserId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    expect((await first.value.listHost())[0]).toMatchObject({ status: "pending", failedAttempts: 0 });
    expect(await db.select().from(spsMemberDevices)).toEqual([]);
  });

  it("rejects expired and future-dated pairings and never replays a consumed pairing", async () => {
    const actorUserId = "pairing-issuer-clock";
    const userId = "pairing-clock-user";
    await seedUser(actorUserId, "issuer-clock@example.test");
    await seedUser(userId, "clock-user@example.test");
    const fixture = await tls();
    let clock = new Date();
    const { value } = service(randomUUID(), undefined, () => new Date(clock));

    const expired = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 5_000,
    });
    clock = new Date(expired.expiresAt);
    expect((await value.listHost()).find((pairing) => pairing.id === expired.pairingId)?.status).toBe("expired");
    await expect(value.consume(consumeInput(expired.pairingId, expired.pairingSecret, userId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });

    clock = new Date(expired.issuedAt + 10_000);
    const future = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 5_000,
    });
    clock = new Date(future.issuedAt - 1);
    await expect(value.consume(consumeInput(future.pairingId, future.pairingSecret, userId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });

    clock = new Date(future.issuedAt);
    const consumed = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 5_000,
    });
    await value.consume(consumeInput(consumed.pairingId, consumed.pairingSecret, userId, fixture.certificate));
    await expect(value.consume(consumeInput(consumed.pairingId, consumed.pairingSecret, userId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    expect((await value.listHost()).find((pairing) => pairing.id === consumed.pairingId)?.status).toBe("consumed");
    expect(await db.select().from(spsMemberDevices)
      .where(eq(spsMemberDevices.ownerUserId, userId))).toHaveLength(1);
  });

  it("revokes a pairing once and applies the per-Host active invite limit under concurrent issue", async () => {
    const actorUserId = "pairing-issuer-capacity";
    const userId = "pairing-capacity-user";
    await seedUser(actorUserId, "issuer-capacity@example.test");
    await seedUser(userId, "capacity-user@example.test");
    const { value } = service(randomUUID(), {
      maxTtlMs: 60_000,
      maxAttempts: 2,
      maxActiveInvites: 1,
    });
    const revoked = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });
    expect(await value.revoke(revoked.pairingId, actorUserId)).toMatchObject({
      id: revoked.pairingId,
      status: "revoked",
      issuedByUserId: actorUserId,
      target: "any_verified_user",
    });
    await expect(value.consume(consumeInput(revoked.pairingId, revoked.pairingSecret, userId, (await tls()).certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });

    const attempts = await Promise.allSettled(Array.from({ length: 3 }, () => value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    })));
    const issued = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(issued).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: "limit_reached", status: 409 });
    }
    expect(await value.listHost()).toHaveLength(2);
    expect((await value.listHost()).filter((pairing) => pairing.status === "pending")).toHaveLength(1);
    expect(await service().value.listHost()).toEqual([]);
  });

  it("rolls back issue when its transaction guard rejects before or after the write and event", async () => {
    const actorUserId = "pairing-issuer-guard-issue";
    await seedUser(actorUserId, "issuer-guard-issue@example.test");
    const { value } = service();
    const input = { actorUserId, target: { kind: "any_verified_user" as const }, ttlMs: 30_000 };
    const opaqueError = new Error("opaque session details");
    let earlyChecks = 0;
    await expect(value.issue(input, async (_tx, userId) => {
      earlyChecks += 1;
      expect(userId).toBe(actorUserId);
      throw opaqueError;
    })).rejects.toMatchObject({ code: "state_unavailable", message: "SPS pairing state is unavailable." });
    expect(earlyChecks).toBe(1);
    expect(await db.select().from(spsNativePairings)).toEqual([]);
    expect(await db.select().from(spsNativePairingEvents)).toEqual([]);

    const transactions: unknown[] = [];
    let lateChecks = 0;
    await expect(value.issue(input, async (tx, userId) => {
      transactions.push(tx);
      lateChecks += 1;
      expect(userId).toBe(actorUserId);
      if (lateChecks === 2) throw opaqueError;
    })).rejects.toMatchObject({ code: "state_unavailable", message: "SPS pairing state is unavailable." });
    expect(lateChecks).toBe(2);
    expect(transactions[1]).toBe(transactions[0]);
    expect(await db.select().from(spsNativePairings)).toEqual([]);
    expect(await db.select().from(spsNativePairingEvents)).toEqual([]);
  });

  it("rolls back revoke when its transaction guard rejects before or after the write and event", async () => {
    const actorUserId = "pairing-issuer-guard-revoke";
    await seedUser(actorUserId, "issuer-guard-revoke@example.test");
    const { value } = service();
    const issued = await value.issue({ actorUserId, target: { kind: "any_verified_user" }, ttlMs: 30_000 });
    const opaqueError = new Error("opaque session details");
    let earlyChecks = 0;
    await expect(value.revoke(issued.pairingId, actorUserId, async (_tx, userId) => {
      earlyChecks += 1;
      expect(userId).toBe(actorUserId);
      throw opaqueError;
    })).rejects.toMatchObject({ code: "state_unavailable", message: "SPS pairing state is unavailable." });
    expect(earlyChecks).toBe(1);
    expect((await value.listHost())[0]).toMatchObject({ status: "pending" });
    expect((await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).map((row) => row.action)).toEqual(["created"]);

    const transactions: unknown[] = [];
    let lateChecks = 0;
    await expect(value.revoke(issued.pairingId, actorUserId, async (tx, userId) => {
      transactions.push(tx);
      lateChecks += 1;
      expect(userId).toBe(actorUserId);
      if (lateChecks === 2) throw opaqueError;
    })).rejects.toMatchObject({ code: "state_unavailable", message: "SPS pairing state is unavailable." });
    expect(lateChecks).toBe(2);
    expect(transactions[1]).toBe(transactions[0]);
    expect((await value.listHost())[0]).toMatchObject({ status: "pending" });
    expect((await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).map((row) => row.action)).toEqual(["created"]);
  });

  it("runs the final transaction guard before returning an already terminal revoke", async () => {
    const actorUserId = "pairing-issuer-terminal-revoke-guard";
    await seedUser(actorUserId, "issuer-terminal-revoke-guard@example.test");
    const { value } = service();
    const issued = await value.issue({ actorUserId, target: { kind: "any_verified_user" }, ttlMs: 30_000 });
    await value.revoke(issued.pairingId, actorUserId);
    let checks = 0;

    await expect(value.revoke(issued.pairingId, actorUserId, async () => {
      checks += 1;
      if (checks === 2) throw new Error("opaque terminal guard details");
    })).rejects.toMatchObject({ code: "state_unavailable", message: "SPS pairing state is unavailable." });
    expect(checks).toBe(2);
    expect((await value.listHost())[0]).toMatchObject({ status: "revoked" });
    expect((await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).map((row) => row.action)).toEqual(["created", "revoked"]);
  });

  it("guards a Host listing before and after its query and projection in one transaction", async () => {
    const actorUserId = "pairing-issuer-guard-list";
    await seedUser(actorUserId, "issuer-guard-list@example.test");
    const { value } = service();
    await value.issue({ actorUserId, target: { kind: "any_verified_user" }, ttlMs: 30_000 });
    const transactions: unknown[] = [];
    let checks = 0;

    await expect(value.listHost({ userId: actorUserId, authorizeInTransaction: async (tx, userId) => {
      transactions.push(tx);
      checks += 1;
      expect(userId).toBe(actorUserId);
      if (checks === 2) throw new Error("opaque list guard details");
    } })).rejects.toMatchObject({ code: "state_unavailable", message: "SPS pairing state is unavailable." });
    expect(checks).toBe(2);
    expect(transactions[1]).toBe(transactions[0]);
  });

  it("rejects malformed transaction guards and guarded-list access objects", async () => {
    const { value } = service();
    const input = { actorUserId: "pairing-issuer-malformed-guard", target: { kind: "any_verified_user" as const }, ttlMs: 30_000 };
    await expect(value.issue(input, null as never)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(value.revoke(randomUUID(), input.actorUserId, null as never))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(value.listHost(null as never)).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(value.listHost({ userId: input.actorUserId, authorizeInTransaction: null } as never))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(value.listHost({ userId: input.actorUserId, authorizeInTransaction: async () => {}, extra: true } as never))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 });
    await expect(value.listHost({ userId: " ", authorizeInTransaction: async () => {} }))
      .rejects.toMatchObject({ code: "invalid_input", status: 400 });
  });

  it("serializes concurrent accepts so exactly one transaction creates the device and consumes the invite", async () => {
    const actorUserId = "pairing-issuer-race";
    const userId = "pairing-race-user";
    await seedUser(actorUserId, "issuer-race@example.test");
    await seedUser(userId, "race-user@example.test");
    const fixture = await tls();
    const { hostId, value } = service();
    const issued = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });

    const accepts = await Promise.allSettled(Array.from({ length: 4 }, () => value.consume(
      consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate),
    )));
    const successful = accepts.filter((result) => result.status === "fulfilled");
    const rejected = accepts.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const result of rejected) {
      expect(result.reason).toMatchObject({ code: "pairing_unavailable", status: 403 });
    }
    const [device] = successful.map((result) => result.value);
    expect(device?.status).toBe("pending");
    expect(await db.select().from(spsMemberDevices)
      .where(and(eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.ownerUserId, userId)))).toHaveLength(1);
    expect(await db.select().from(spsMemberDeviceEvents)
      .where(eq(spsMemberDeviceEvents.deviceSnapshotId, device!.id))).toHaveLength(1);
    expect((await value.listHost())[0]).toMatchObject({
      status: "consumed",
      consumedByUserId: userId,
      consumedDeviceSnapshotId: device!.id,
    });
    expect(await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).toHaveLength(2);
  });

  it("isolates invitations by Host certificate pin without adopting old-pin invitations", async () => {
    const actorUserId = "pairing-issuer-identity-change";
    const firstUserId = "pairing-old-pin-user";
    const secondUserId = "pairing-revoked-old-pin-user";
    const newPinUserId = "pairing-new-pin-user";
    await seedUser(actorUserId, "issuer-identity-change@example.test");
    await seedUser(firstUserId, "old-pin-user@example.test");
    await seedUser(secondUserId, "revoked-old-pin-user@example.test");
    await seedUser(newPinUserId, "new-pin-user@example.test");
    const fixture = await tls();
    let clock = new Date();
    const now = () => new Date(clock);
    const hostId = randomUUID();
    const oldPin = "1".repeat(64);
    const newPin = "2".repeat(64);
    const oldHost = service(hostId, {
      maxTtlMs: 60_000,
      maxAttempts: 2,
      maxActiveInvites: 2,
    }, now, oldPin);
    const newHost = service(hostId, {
      maxTtlMs: 60_000,
      maxAttempts: 2,
      maxActiveInvites: 1,
    }, now, newPin);

    const oldPairing = await oldHost.value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });
    const revokedOldPairing = await oldHost.value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });

    expect((await newHost.value.listHost()).find((pairing) => pairing.id === oldPairing.pairingId)?.status)
      .toBe("identity_changed");
    await expect(newHost.value.consume(consumeInput(
      oldPairing.pairingId,
      oldPairing.pairingSecret,
      firstUserId,
      fixture.certificate,
    ))).rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    expect((await oldHost.value.listHost()).find((pairing) => pairing.id === oldPairing.pairingId))
      .toMatchObject({ status: "pending", failedAttempts: 0 });

    const newPairing = await newHost.value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });
    expect((await newHost.value.listHost()).find((pairing) => pairing.id === newPairing.pairingId)?.status)
      .toBe("pending");
    expect((await db.select().from(spsNativePairings)
      .where(eq(spsNativePairings.id, oldPairing.pairingId)))[0]?.serverSpkiSha256).toBe(oldPin);

    await expect(oldHost.value.consume(consumeInput(
      oldPairing.pairingId,
      oldPairing.pairingSecret,
      firstUserId,
      fixture.certificate,
    ))).resolves.toMatchObject({ ownerUserId: firstUserId, status: "pending" });
    await oldHost.value.revoke(revokedOldPairing.pairingId, actorUserId);
    await expect(oldHost.value.consume(consumeInput(
      revokedOldPairing.pairingId,
      revokedOldPairing.pairingSecret,
      secondUserId,
      fixture.certificate,
    ))).rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    await expect(newHost.value.consume(consumeInput(
      newPairing.pairingId,
      newPairing.pairingSecret,
      newPinUserId,
      fixture.certificate,
    ))).resolves.toMatchObject({ ownerUserId: newPinUserId, status: "pending" });
  });

  it("does not revive an existing revoked device or consume its pairing", async () => {
    const actorUserId = "pairing-issuer-terminal-device";
    const userId = "pairing-terminal-device-user";
    await seedUser(actorUserId, "issuer-terminal-device@example.test");
    await seedUser(userId, "terminal-device@example.test");
    const fixture = await tls();
    const { hostId, value } = service();
    const revokedAt = new Date();
    await db.insert(spsMemberDevices).values({
      hostId,
      ownerUserId: userId,
      displayName: "Previously revoked",
      certificate: fixture.certificate,
      certificateSha256: fixture.certificateSha256,
      spkiSha256: fixture.spkiSha256,
      certificateNotBefore: new Date(revokedAt.getTime() - 1_000),
      certificateNotAfter: new Date(revokedAt.getTime() + 60_000),
      status: "revoked",
      revision: 2,
      revokedAt,
    });
    const issued = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });

    await expect(value.consume(consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate)))
      .rejects.toMatchObject({ code: "pairing_unavailable", status: 403 });
    expect((await value.listHost()).find((pairing) => pairing.id === issued.pairingId))
      .toMatchObject({ status: "pending", consumedByUserId: null, consumedDeviceSnapshotId: null });
    const [device] = await db.select().from(spsMemberDevices)
      .where(and(eq(spsMemberDevices.hostId, hostId), eq(spsMemberDevices.ownerUserId, userId)));
    expect(device).toMatchObject({ status: "revoked", revision: 2, revokedAt });
    expect(await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).toHaveLength(1);
  });

  it("rolls back device registration and pairing consumption when the consume event cannot be appended", async () => {
    const actorUserId = "pairing-issuer-event-rollback";
    const userId = "pairing-event-rollback-user";
    await seedUser(actorUserId, "issuer-event-rollback@example.test");
    await seedUser(userId, "event-rollback@example.test");
    const fixture = await tls();
    const { value } = service();
    const issued = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });
    const constraintName = `reject_pairing_consume_${randomUUID().replace(/-/g, "")}`;
    await db.execute(sql`ALTER TABLE ${sql.identifier("sps_native_pairing_events")}
      ADD CONSTRAINT ${sql.identifier(constraintName)} CHECK (action <> 'consumed')`);
    try {
      await expect(value.consume(consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate)))
        .rejects.toThrow();
      expect((await value.listHost()).find((pairing) => pairing.id === issued.pairingId)?.status).toBe("pending");
      expect(await db.select().from(spsMemberDevices)).toEqual([]);
      expect(await db.select().from(spsMemberDeviceEvents)).toEqual([]);
      expect(await db.select().from(spsNativePairingEvents)
        .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).toHaveLength(1);
    } finally {
      await db.execute(sql`ALTER TABLE ${sql.identifier("sps_native_pairing_events")}
        DROP CONSTRAINT ${sql.identifier(constraintName)}`);
    }

    await expect(value.consume(consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate)))
      .resolves.toMatchObject({ status: "pending" });
  });

  it("retains pairing audit events with nulled live references after deleting pairing state", async () => {
    const actorUserId = "pairing-issuer-restore";
    const userId = "pairing-restore-user";
    await seedUser(actorUserId, "issuer-restore@example.test");
    await seedUser(userId, "restore-user@example.test");
    const fixture = await tls();
    const { hostId, value } = service();
    const issued = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });
    const device = await value.consume(consumeInput(issued.pairingId, issued.pairingSecret, userId, fixture.certificate));

    await db.delete(spsNativePairings).where(and(
      eq(spsNativePairings.hostId, hostId),
      eq(spsNativePairings.id, issued.pairingId),
    ));

    expect(await value.listHost()).toEqual([]);
    const history = await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId));
    expect(history).toHaveLength(2);
    expect(history.every((event) => event.pairingId === null && event.pairingSnapshotId === issued.pairingId)).toBe(true);
    expect(history.find((event) => event.action === "consumed")?.deviceSnapshotId).toBe(device.id);
    expect(await db.select().from(spsMemberDevices)
      .where(eq(spsMemberDevices.id, device.id))).toHaveLength(1);
  });

  it("distinguishes malformed input and invalid policy from unavailable pairings", async () => {
    const actorUserId = "pairing-issuer-validation";
    await seedUser(actorUserId, "issuer-validation@example.test");
    const { value } = service();

    await expect(value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 0,
    })).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    expect(() => service(randomUUID(), { maxTtlMs: 0, maxAttempts: 2, maxActiveInvites: 1 }))
      .toThrowError(expect.objectContaining({ code: "invalid_input", status: 400 }));
  });

  it("checks the current session before a wrong secret can spend an invitation attempt", async () => {
    await seedUser("session-issuer", "session-issuer@example.test");
    await seedUser("session-member", "session-member@example.test");
    const { value } = service();
    const invitation = await value.issue({ actorUserId: "session-issuer", target: { kind: "any_verified_user" }, ttlMs: 30_000 });
    let called = false;
    await expect(value.withEnrollmentInvitation({ pairingId: invitation.pairingId,
      pairingSecret: createSpsNativePairingSecret(), userId: "session-member" }, async () => { called = true; },
    async () => { throw new Error("fixture session revoked"); })).rejects.toMatchObject({ code: "state_unavailable" });
    expect(called).toBe(false);
    expect((await value.listHost())[0]).toMatchObject({ status: "pending", failedAttempts: 0 });
    expect(await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.action, "secret_rejected"))).toEqual([]);
  });

  it("rolls back wrong-secret accounting when the final session check expires", async () => {
    await seedUser("session-final-issuer", "session-final-issuer@example.test");
    await seedUser("session-final-member", "session-final-member@example.test");
    const { value } = service();
    const invitation = await value.issue({ actorUserId: "session-final-issuer", target: { kind: "any_verified_user" }, ttlMs: 30_000 });
    let checks = 0;
    await expect(value.withEnrollmentInvitation({ pairingId: invitation.pairingId,
      pairingSecret: createSpsNativePairingSecret(), userId: "session-final-member" }, async () => {},
    async () => { if (++checks > 1) throw new Error("fixture session expired"); })).rejects.toMatchObject({ code: "state_unavailable" });
    expect(checks).toBe(2);
    expect((await value.listHost())[0]).toMatchObject({ status: "pending", failedAttempts: 0 });
    expect(await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.action, "secret_rejected"))).toEqual([]);
  });

  it("rejects pairing and Host UUIDs with trailing LF or CRLF as invalid input", async () => {
    const actorUserId = "pairing-issuer-uuid-newline";
    const userId = "pairing-uuid-newline-user";
    await seedUser(actorUserId, "issuer-uuid-newline@example.test");
    await seedUser(userId, "uuid-newline@example.test");
    const fixture = await tls();
    const validHostId = randomUUID();
    const { value } = service(validHostId);
    const issued = await value.issue({
      actorUserId,
      target: { kind: "any_verified_user" },
      ttlMs: 30_000,
    });

    for (const lineEnding of ["\n", "\r\n"]) {
      expect(() => service(`${validHostId}${lineEnding}`))
        .toThrowError(expect.objectContaining({ code: "invalid_input", status: 400 }));
      expect(() => hashSpsNativePairingSecret(
        `${validHostId}${lineEnding}`,
        issued.pairingId,
        issued.pairingSecret,
      )).toThrow(TypeError);
      expect(() => hashSpsNativePairingSecret(
        validHostId,
        `${issued.pairingId}${lineEnding}`,
        issued.pairingSecret,
      )).toThrow(TypeError);
      await expect(value.consume(consumeInput(
        `${issued.pairingId}${lineEnding}`,
        issued.pairingSecret,
        userId,
        fixture.certificate,
      ))).rejects.toMatchObject({ code: "invalid_input", status: 400 });
    }

    expect((await value.listHost()).find((pairing) => pairing.id === issued.pairingId))
      .toMatchObject({ status: "pending", failedAttempts: 0 });
    expect(await db.select().from(spsNativePairingEvents)
      .where(eq(spsNativePairingEvents.pairingSnapshotId, issued.pairingId))).toHaveLength(1);
    await expect(value.consume(consumeInput(
      issued.pairingId,
      issued.pairingSecret,
      userId,
      fixture.certificate,
    ))).resolves.toMatchObject({ status: "pending" });
  });
});
