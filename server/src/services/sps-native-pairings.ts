import { randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import {
  authUsers, spsNativePairings, spsNativePairingEvents, type Db,
} from "../compat/paperclip/db.js";
import {
  createSpsNativePairingSecret, hashSpsNativePairingEmail,
  hashSpsNativePairingSecret, verifySpsNativePairingSecret,
} from "./sps-native-pairing-crypto.js";
import {
  registerPendingSpsMemberDeviceInTransaction, SpsMemberDeviceError,
  type SpsMemberDeviceDto,
} from "./sps-member-devices.js";

type PairingRow = typeof spsNativePairings.$inferSelect;
export type SpsNativePairingTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type SpsNativePairingAuthorizer = (tx: SpsNativePairingTransaction, userId: string) => Promise<void>;
type Transaction = SpsNativePairingTransaction;
type Target = { kind: "any_verified_user" } | { kind: "verified_email"; email: string };
export type SpsNativePairingPolicy = { maxTtlMs: number; maxAttempts: number; maxActiveInvites: number };
export type SpsNativePairingMetadata = {
  id: string; status: "pending" | "expired" | "identity_changed" | "consumed" | "revoked" | "exhausted";
  createdAt: string; expiresAt: string; failedAttempts: number; maxAttempts: number;
  issuedByUserId: string; consumedByUserId: string | null; consumedDeviceSnapshotId: string | null;
  target: "any_verified_user" | "verified_email";
};
type PairingCode = "invalid_input" | "pairing_unavailable" | "limit_reached" | "state_unavailable";
const statuses: Record<PairingCode, number> = { invalid_input: 400, pairing_unavailable: 403, limit_reached: 409, state_unavailable: 503 };
const messages: Record<PairingCode, string> = {
  invalid_input: "Invalid SPS pairing input.", pairing_unavailable: "This SPS pairing is unavailable.",
  limit_reached: "The SPS Host has reached its pending pairing limit.", state_unavailable: "SPS pairing state is unavailable.",
};
export class SpsNativePairingError extends Error {
  readonly status: number;
  constructor(readonly code: PairingCode) { super(messages[code]); this.name = "SpsNativePairingError"; this.status = statuses[code]; }
}
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
function fail(code: PairingCode): never { throw new SpsNativePairingError(code); }
function object(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail("invalid_input");
  return value as Record<string, unknown>;
}
function id(value: unknown) {
  if (typeof value !== "string" || value.length !== 36 || !uuid.test(value)) fail("invalid_input");
  return value.toLowerCase();
}
function user(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail("invalid_input");
  return value;
}
function integer(value: unknown, min: number, max: number) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail("invalid_input");
  return value as number;
}

/** Internal persistence only. The caller must provide real session/Host/transport authority. */
export function spsNativePairingService(
  db: Db, hostIdInput: string, policyInput: SpsNativePairingPolicy,
  options: { serverSpkiSha256: string; now?: () => Date },
) {
  const hostId = id(hostIdInput);
  if (!options || typeof options.serverSpkiSha256 !== "string" || options.serverSpkiSha256.length !== 64
    || !/^[0-9a-f]{64}$/.test(options.serverSpkiSha256)) fail("invalid_input");
  const serverSpkiSha256 = options.serverSpkiSha256;
  const raw = object(policyInput, ["maxTtlMs", "maxAttempts", "maxActiveInvites"]);
  const policy = Object.freeze({
    maxTtlMs: integer(raw.maxTtlMs, 1_000, 86_400_000),
    maxAttempts: integer(raw.maxAttempts, 1, 20), maxActiveInvites: integer(raw.maxActiveInvites, 1, 100),
  });
  if (options.now !== undefined && typeof options.now !== "function") fail("invalid_input");
  function now() {
    const date = options.now ? options.now() : new Date();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail("state_unavailable");
    return new Date(date);
  }
  function current(row: PairingRow, at: Date) {
    return row.serverSpkiSha256 === serverSpkiSha256 && row.status === "pending"
      && row.createdAt <= at && row.expiresAt > at && row.failedAttempts < row.maxAttempts;
  }
  function project(row: PairingRow): SpsNativePairingMetadata {
    return {
      id: row.id, status: row.status === "pending" && row.serverSpkiSha256 !== serverSpkiSha256 ? "identity_changed"
        : row.status === "pending" && row.expiresAt <= now() ? "expired" : row.status as SpsNativePairingMetadata["status"],
      createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
      failedAttempts: row.failedAttempts, maxAttempts: row.maxAttempts, issuedByUserId: row.issuedByUserId,
      consumedByUserId: row.consumedByUserId, consumedDeviceSnapshotId: row.consumedDeviceSnapshotId,
      target: row.targetEmailSha256 === null ? "any_verified_user" : "verified_email",
    };
  }
  async function store<T>(operation: () => Promise<T>) {
    try { return await operation(); }
    catch (error) {
      if (error instanceof SpsNativePairingError) throw error;
      if (error instanceof SpsMemberDeviceError) fail(error.status === 400 ? "invalid_input" : "pairing_unavailable");
      fail("state_unavailable");
    }
  }
  async function verifiedUser(tx: Transaction, userId: string) {
    const [row] = await tx.select({ id: authUsers.id, email: authUsers.email, verified: authUsers.emailVerified })
      .from(authUsers).where(eq(authUsers.id, userId)).for("share").limit(1);
    if (!row?.verified) fail("pairing_unavailable");
    return row;
  }
  async function event(tx: Transaction, row: PairingRow, actorUserId: string,
    action: "created" | "secret_rejected" | "consumed" | "revoked" | "exhausted", deviceSnapshotId: string | null = null) {
    await tx.insert(spsNativePairingEvents).values({
      hostId, pairingId: row.id, pairingSnapshotId: row.id, actorUserId, action, deviceSnapshotId, createdAt: now(),
    });
  }

  // Private DB orchestration only; this does not authenticate a network session
  // or prove TLS possession. No route, Worker RPC or public SDK exposes it.
  async function withEnrollmentInvitation<T>(
    input: { pairingId: string; pairingSecret: string; userId: string },
    operation: (tx: Transaction, row: PairingRow) => Promise<T>,
    authorizeInTransaction: SpsNativePairingAuthorizer = async () => {},
  ): Promise<T> {
    object(input, ["pairingId", "pairingSecret", "userId"]);
    const pairingId = id(input.pairingId), userId = user(input.userId);
    if (typeof operation !== "function" || typeof authorizeInTransaction !== "function") fail("invalid_input");
    try { hashSpsNativePairingSecret(hostId, pairingId, input.pairingSecret); } catch { fail("invalid_input"); }
    const outcome = await store(() => db.transaction(async tx => {
      await authorizeInTransaction(tx, userId);
      const account = await verifiedUser(tx, userId);
      const [row] = await tx.select().from(spsNativePairings).where(and(
        eq(spsNativePairings.hostId, hostId), eq(spsNativePairings.id, pairingId),
      )).for("update");
      if (!row || !current(row, now())) fail("pairing_unavailable");
      if (row.targetEmailSha256 !== null) {
        let emailHash: string;
        try { emailHash = hashSpsNativePairingEmail(account.email); } catch { fail("pairing_unavailable"); }
        if (emailHash !== row.targetEmailSha256) fail("pairing_unavailable");
      }
      if (!verifySpsNativePairingSecret(hostId, pairingId, input.pairingSecret, row.secretSha256)) {
        const failedAttempts = row.failedAttempts + 1, exhausted = failedAttempts >= row.maxAttempts;
        await tx.update(spsNativePairings).set({ failedAttempts, status: exhausted ? "exhausted" : "pending" })
          .where(and(eq(spsNativePairings.hostId, hostId), eq(spsNativePairings.id, pairingId)));
        await event(tx, row, userId, exhausted ? "exhausted" : "secret_rejected");
        await authorizeInTransaction(tx, userId);
        return { ok: false } as const;
      }
      const value = await operation(tx, row);
      // Operations may intentionally consume the row; this snapshot checks only
      // the captured identity/expiry/attempt window, not the newly stored status.
      if (!current(row, now())) fail("pairing_unavailable");
      return { ok: true, value } as const;
    }));
    if (!outcome.ok) fail("pairing_unavailable");
    return outcome.value;
  }

  return {
    withEnrollmentInvitation,
    async issue(
      input: { actorUserId: string; target: Target; ttlMs: number },
      authorizeInTransaction: SpsNativePairingAuthorizer = async () => {},
    ) {
      object(input, ["actorUserId", "target", "ttlMs"]);
      if (typeof authorizeInTransaction !== "function") fail("invalid_input");
      const actorUserId = user(input.actorUserId), ttlMs = integer(input.ttlMs, 1_000, policy.maxTtlMs);
      const target = input.target;
      let targetEmailSha256: string | null = null;
      if (target?.kind === "any_verified_user") object(target, ["kind"]);
      else if (target?.kind === "verified_email") {
        object(target, ["kind", "email"]);
        try { targetEmailSha256 = hashSpsNativePairingEmail(target.email); } catch { fail("invalid_input"); }
      } else fail("invalid_input");
      const pairingId = randomUUID(), pairingSecret = createSpsNativePairingSecret();
      return store(() => db.transaction(async tx => {
        await authorizeInTransaction(tx, actorUserId);
        // Serialize only issuance for this Host; concurrent callers cannot exceed its quota.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"sps-native-pairings:" + hostId}, 0))`);
        await verifiedUser(tx, actorUserId);
        const at = now();
        const [open] = await tx.select({ value: count() }).from(spsNativePairings).where(and(
          eq(spsNativePairings.hostId, hostId), eq(spsNativePairings.status, "pending"),
          eq(spsNativePairings.serverSpkiSha256, serverSpkiSha256),
          gt(spsNativePairings.expiresAt, at),
        ));
        if (!open || open.value >= policy.maxActiveInvites) fail("limit_reached");
        const expiresAt = new Date(at.getTime() + ttlMs);
        if (!Number.isSafeInteger(expiresAt.getTime())) fail("invalid_input");
        const [row] = await tx.insert(spsNativePairings).values({
          id: pairingId, hostId, serverSpkiSha256, issuedByUserId: actorUserId,
          secretSha256: hashSpsNativePairingSecret(hostId, pairingId, pairingSecret), targetEmailSha256,
          maxAttempts: policy.maxAttempts, createdAt: at, expiresAt,
        }).returning();
        await event(tx, row, actorUserId, "created");
        if (!current(row, now())) fail("pairing_unavailable");
        const result = { pairingId, pairingSecret, issuedAt: at.getTime(), expiresAt: expiresAt.getTime() };
        await authorizeInTransaction(tx, actorUserId);
        return result;
      }));
    },
    async listHost(access?: { userId: string; authorizeInTransaction: SpsNativePairingAuthorizer }): Promise<SpsNativePairingMetadata[]> {
      if (access === undefined) {
        return store(async () => (await db.select().from(spsNativePairings).where(eq(spsNativePairings.hostId, hostId))
          .orderBy(desc(spsNativePairings.createdAt), desc(spsNativePairings.id)).limit(200)).map(project));
      }
      const raw = object(access, ["userId", "authorizeInTransaction"]);
      const userId = user(raw.userId), authorizeInTransaction = raw.authorizeInTransaction;
      if (typeof authorizeInTransaction !== "function") fail("invalid_input");
      return store(() => db.transaction(async tx => {
        await authorizeInTransaction(tx, userId);
        await verifiedUser(tx, userId);
        const result = (await tx.select().from(spsNativePairings).where(eq(spsNativePairings.hostId, hostId))
          .orderBy(desc(spsNativePairings.createdAt), desc(spsNativePairings.id)).limit(200)).map(project);
        await authorizeInTransaction(tx, userId);
        return result;
      }));
    },
    async revoke(
      pairingIdInput: string,
      actorUserIdInput: string,
      authorizeInTransaction: SpsNativePairingAuthorizer = async () => {},
    ): Promise<SpsNativePairingMetadata> {
      const pairingId = id(pairingIdInput), actorUserId = user(actorUserIdInput);
      if (typeof authorizeInTransaction !== "function") fail("invalid_input");
      return store(() => db.transaction(async tx => {
        await authorizeInTransaction(tx, actorUserId);
        await verifiedUser(tx, actorUserId);
        const [row] = await tx.select().from(spsNativePairings).where(and(
          eq(spsNativePairings.hostId, hostId), eq(spsNativePairings.id, pairingId),
        )).for("update");
        if (!row) fail("pairing_unavailable");
        if (row.status !== "pending") {
          const result = project(row);
          await authorizeInTransaction(tx, actorUserId);
          return result;
        }
        const [revoked] = await tx.update(spsNativePairings).set({ status: "revoked", revokedAt: now(), revokedByUserId: actorUserId })
          .where(and(eq(spsNativePairings.hostId, hostId), eq(spsNativePairings.id, pairingId))).returning();
        await event(tx, revoked, actorUserId, "revoked");
        const result = project(revoked);
        await authorizeInTransaction(tx, actorUserId);
        return result;
      }));
    },
    async consume(input: { pairingId: string; pairingSecret: string; userId: string; displayName: string; certificate: string }): Promise<SpsMemberDeviceDto> {
      object(input, ["pairingId", "pairingSecret", "userId", "displayName", "certificate"]);
      const scope = { pairingId: input.pairingId, pairingSecret: input.pairingSecret, userId: input.userId };
      return withEnrollmentInvitation(scope, async (tx, row) => {
        const device = await registerPendingSpsMemberDeviceInTransaction(tx, hostId, {
          userId: scope.userId, displayName: input.displayName, certificate: input.certificate,
        });
        const afterRegistration = now();
        if (device.status !== "pending" || !current(row, afterRegistration)
          || Date.parse(device.certificateNotBefore) > afterRegistration.getTime()
          || Date.parse(device.certificateNotAfter) <= afterRegistration.getTime()) fail("pairing_unavailable");
        await tx.update(spsNativePairings).set({
          status: "consumed", consumedAt: now(), consumedByUserId: scope.userId,
          consumedDeviceId: device.id, consumedDeviceSnapshotId: device.id,
        }).where(and(eq(spsNativePairings.hostId, hostId), eq(spsNativePairings.id, row.id)));
        await event(tx, row, scope.userId, "consumed", device.id);
        if (!current(row, now())) fail("pairing_unavailable");
        return device;
      });
    },
  };
}
