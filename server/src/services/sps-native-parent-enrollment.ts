import type { Db } from "../compat/paperclip/db.js";
import { spsNativeEnrollmentService } from "./sps-native-enrollments.js";
import type { SpsNativePairingPolicy } from "./sps-native-pairings.js";
import { createSpsNativeParentSignerClient } from "./sps-native-parent-signer.js";

const OPTION_KEYS = ["pairingPolicy", "certificateLifetimeMs", "signingTimeoutMs", "maxConcurrentSignings"] as const;
const PAIRING_POLICY_KEYS = ["maxTtlMs", "maxAttempts", "maxActiveInvites"] as const;

export type SpsNativeParentEnrollmentOptions = {
  pairingPolicy: SpsNativePairingPolicy;
  certificateLifetimeMs: number;
  signingTimeoutMs: number;
  maxConcurrentSignings: number;
};

export type SpsNativeParentEnrollment = {
  service: ReturnType<typeof spsNativeEnrollmentService>;
  /** Public host metadata only. The private signer key never leaves Desktop Main. */
  identity: Readonly<{ hostId: string; serverSpkiSha256: string; issuerSpkiSha256: string; issuerCertificate: string }>;
  assertActive(): void;
  dispose(): void;
};

function invalidOptions(): TypeError {
  return new TypeError("Invalid SPS Native parent enrollment options.");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidOptions();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidOptions();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) {
      throw invalidOptions();
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidOptions();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw invalidOptions();
  }
}

function validatedOptions(value: SpsNativeParentEnrollmentOptions): SpsNativeParentEnrollmentOptions {
  const options = exactRecord(value, OPTION_KEYS);
  const pairingPolicy = exactRecord(options.pairingPolicy, PAIRING_POLICY_KEYS) as unknown as SpsNativePairingPolicy;
  if (!Number.isSafeInteger(options.certificateLifetimeMs) || (options.certificateLifetimeMs as number) < 1000
    || (options.certificateLifetimeMs as number) > 90 * 24 * 60 * 60 * 1000
    || (options.certificateLifetimeMs as number) % 1000 !== 0
    || !Number.isSafeInteger(options.signingTimeoutMs) || (options.signingTimeoutMs as number) < 1000
    || (options.signingTimeoutMs as number) > 30_000
    || !Number.isSafeInteger(options.maxConcurrentSignings) || (options.maxConcurrentSignings as number) < 1
    || (options.maxConcurrentSignings as number) > 2) {
    throw invalidOptions();
  }
  return {
    // exactRecord deliberately returns a null-prototype bag. Project its
    // already-validated primitive fields into the plain DTO required by the
    // existing pairing service's closed configuration validator.
    pairingPolicy: {
      maxTtlMs: pairingPolicy.maxTtlMs,
      maxAttempts: pairingPolicy.maxAttempts,
      maxActiveInvites: pairingPolicy.maxActiveInvites,
    },
    certificateLifetimeMs: options.certificateLifetimeMs as number,
    signingTimeoutMs: options.signingTimeoutMs as number,
    maxConcurrentSignings: options.maxConcurrentSignings as number,
  };
}

/** Explicit composition only; this factory does not authenticate a session or register an ingress. */
export async function createSpsNativeParentEnrollmentService(
  db: Db,
  optionsValue: SpsNativeParentEnrollmentOptions,
  channel: unknown = process,
): Promise<SpsNativeParentEnrollment> {
  const options = validatedOptions(optionsValue);
  const client = createSpsNativeParentSignerClient(channel, {
    timeoutMs: options.signingTimeoutMs,
    maxPending: options.maxConcurrentSignings,
  });
  let disposed = false;
  const assertActive = () => {
    try {
      client.assertAvailable();
    } catch {
      throw Object.assign(new Error("This SPS device enrollment is unavailable. Existing credentials were not replaced."), {
        code: "native_enrollment_unavailable",
        status: 409,
      });
    }
    if (disposed) {
      throw Object.assign(new Error("This SPS device enrollment is unavailable. Existing credentials were not replaced."), {
        code: "native_enrollment_unavailable",
        status: 409,
      });
    }
  };
  try {
    const identity = await client.inspect();
    assertActive();
    const delegate = spsNativeEnrollmentService(db, {
      hostId: identity.hostId,
      serverSpkiSha256: identity.serverSpkiSha256,
      issuerCertificate: identity.issuerCertificate,
      pairingPolicy: options.pairingPolicy,
      certificateLifetimeMs: options.certificateLifetimeMs,
      signingTimeoutMs: options.signingTimeoutMs,
      maxConcurrentSignings: options.maxConcurrentSignings,
    }, async input => await client.sign({
      hostId: identity.hostId,
      serverSpkiSha256: identity.serverSpkiSha256,
      issuerSpkiSha256: identity.issuerSpkiSha256,
      deviceKeyId: input.deviceKeyId,
      requestPem: input.requestPem,
      notBefore: input.notBefore,
      notAfter: input.notAfter,
      signal: input.signal,
    }), assertActive);
    const service: ReturnType<typeof spsNativeEnrollmentService> = Object.freeze({
      async reconcileFromTlsPeer(socket, input, authorizeInTransaction) {
        assertActive();
        return await delegate.reconcileFromTlsPeer(socket, input, authorizeInTransaction);
      },
      async issue(input, authorizeInTransaction) {
        assertActive();
        return await delegate.issue(input, authorizeInTransaction);
      },
      async completeFromTlsPeer(socket, input, authorizeInTransaction) {
        assertActive();
        return await delegate.completeFromTlsPeer(socket, input, authorizeInTransaction);
      },
    });
    return Object.freeze({
      service,
      identity: Object.freeze({ ...identity }),
      assertActive,
      dispose() {
        if (disposed) return;
        disposed = true;
        client.dispose();
      },
    });
  } catch {
    disposed = true;
    client.dispose();
    throw Object.assign(new Error("SPS Native parent enrollment is unavailable."), { code: "native_signer_unavailable" });
  }
}
