import type { Request } from "express";
import type { Db } from "../compat/paperclip/db.js";
import type { SpsNativeHostManagement } from "./sps-native-host-management.js";
import {
  spsNativePairingService, SpsNativePairingError,
  type SpsNativePairingAuthorizer, type SpsNativePairingPolicy,
} from "./sps-native-pairings.js";

export const SPS_NATIVE_HOST_PAIRING_TTL_MS = 3_600_000;
type Policy = Pick<SpsNativePairingPolicy, "maxAttempts" | "maxActiveInvites">;

function unavailable(): never { throw new SpsNativePairingError("pairing_unavailable"); }
export class SpsNativeHostPairingDeliveryError extends Error {
  readonly code = "native_pairing_result_unavailable";
  readonly status = 503;
  constructor() { super("SPS pairing result was not delivered. Existing state was not reset; do not automatically retry."); }
}

/** Explicit local composition only. No startup route, listener or UI is enabled. */
export function createSpsNativeHostPairings(db: Db, management: SpsNativeHostManagement, policyInput: Policy) {
  if (!management || typeof management.assertActive !== "function"
    || typeof management.resolveHostSession !== "function") unavailable();
  if (!policyInput || typeof policyInput !== "object" || Object.getPrototypeOf(policyInput) !== Object.prototype) {
    throw new SpsNativePairingError("invalid_input");
  }
  const fields = Object.getOwnPropertyDescriptors(policyInput);
  const names = Reflect.ownKeys(fields);
  if (names.length !== 2 || names.some(name => name !== "maxAttempts" && name !== "maxActiveInvites")
    || names.some(name => !fields[name as string]?.enumerable || !("value" in fields[name as string]!))) {
    throw new SpsNativePairingError("invalid_input");
  }
  const maxAttempts = fields.maxAttempts!.value;
  const maxActiveInvites = fields.maxActiveInvites!.value;
  if (typeof maxAttempts !== "number" || typeof maxActiveInvites !== "number") {
    throw new SpsNativePairingError("invalid_input");
  }
  management.assertActive();
  const pairings = spsNativePairingService(db, management.hostId, {
    maxTtlMs: SPS_NATIVE_HOST_PAIRING_TTL_MS,
    maxAttempts,
    maxActiveInvites,
  }, { serverSpkiSha256: management.serverSpkiSha256 });

  function assertDeliveryActive() {
    try { management.assertActive(); }
    catch { throw new SpsNativeHostPairingDeliveryError(); }
  }

  async function authority(request: Request) {
    try {
      management.assertActive();
      const session = await management.resolveHostSession(request);
      management.assertActive();
      const authorizeInTransaction: SpsNativePairingAuthorizer = async (tx, expectedUserId) => {
        try {
          management.assertActive();
          if (expectedUserId !== session.userId) unavailable();
          await session.authorizeInTransaction(tx, expectedUserId);
          management.assertActive();
        } catch { unavailable(); }
      };
      return { userId: session.userId, authorizeInTransaction };
    } catch { unavailable(); }
  }

  return Object.freeze({
    async issue(request: Request) {
      const access = await authority(request);
      const issued = await pairings.issue({ actorUserId: access.userId,
        target: { kind: "any_verified_user" }, ttlMs: SPS_NATIVE_HOST_PAIRING_TTL_MS,
      }, access.authorizeInTransaction);
      assertDeliveryActive();
      return issued;
    },
    async list(request: Request) {
      const access = await authority(request);
      const listed = await pairings.listHost(access);
      assertDeliveryActive();
      return listed;
    },
    async revoke(request: Request, pairingId: string) {
      const access = await authority(request);
      const revoked = await pairings.revoke(pairingId, access.userId, access.authorizeInTransaction);
      assertDeliveryActive();
      return revoked;
    },
  });
}
