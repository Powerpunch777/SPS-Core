import { createHash, createPublicKey, verify } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createSpsNodeSchema } from "../compat/paperclip/shared.js";
import { spsMemberDevices, spsNativeNodeBindings, spsNodeHeartbeats, spsNodeRunnerProfiles, spsNodes, type Db } from "../compat/paperclip/db.js";
import { createSpsNodeOperations, type SpsNodeOperationContext, type SpsNodeOperationResult } from "./sps-node-operations.js";
import { spsNativeNodeBindingService } from "./sps-native-node-bindings.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_CONCURRENT = 2;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 30_000;
const OPERATIONS = new Set([
  "heartbeat", "availability", "source-route", "claim-command", "command-lease", "command-event", "command-complete",
  "claim-plugin-run", "plugin-lease", "plugin-event", "plugin-complete",
]);
type NodeOperation = "heartbeat" | "availability" | "source-route" | "claim-command"
  | "command-lease" | "command-event" | "command-complete" | "claim-plugin-run"
  | "plugin-lease" | "plugin-event" | "plugin-complete";

export type SpsNativeNodePrincipal = Readonly<{
  hostId: string;
  userId: string;
  deviceId: string;
  deviceRevision: number;
  certificateSha256: string;
  certificateNotAfter: number;
}>;

export type SpsNativeNodeAuthority = <T>(
  action: (tx: Db, principal: SpsNativeNodePrincipal) => Promise<T>,
) => Promise<T>;

export type SpsNativeNodeRuntimeInput = Readonly<{
  workspaceId: string;
  operation: "register" | NodeOperation;
  nodeId: string | null;
  resourceId: string | null;
  payload: unknown;
}>;

type RegistrationProof = { timestamp: string; nonce: string; signature: string };

function unavailable(): Error { return new Error("Native SPS Node operation is unavailable."); }

function exactRecord(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string" || !allowed.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))) throw unavailable();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw unavailable();
    result[key] = descriptor.value;
  }
  return result;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw unavailable();
  return encoded;
}

function normalizeJson(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (depth > MAX_JSON_DEPTH || ++budget.nodes > MAX_JSON_NODES) throw unavailable();
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw unavailable();
    return value;
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string" || key !== "length" && !/^(0|[1-9]\d*)$/.test(key))) throw unavailable();
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !("value" in descriptor)) throw unavailable();
      result.push(normalizeJson(descriptor.value, depth + 1, budget));
    }
    return result;
  }
  if (!value || typeof value !== "object") throw unavailable();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw unavailable();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string")) throw unavailable();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor)) throw unavailable();
    result[key] = normalizeJson(descriptor.value, depth + 1, budget);
  }
  return result;
}

function readRegistrationProof(value: unknown): RegistrationProof {
  const record = exactRecord(value, ["timestamp", "nonce", "signature"]);
  if (typeof record.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(record.timestamp)
    || typeof record.nonce !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(record.nonce)
    || typeof record.signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.signature)) throw unavailable();
  const signature = Buffer.from(record.signature, "base64");
  if (signature.length !== 64 || signature.toString("base64") !== record.signature) throw unavailable();
  const signedAt = Date.parse(record.timestamp);
  if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > MAX_CLOCK_SKEW_MS) throw unavailable();
  return record as RegistrationProof;
}

function registrationMessage(input: {
  hostId: string; workspaceId: string; deviceId: string; timestamp: string; nonce: string; registration: unknown;
}) {
  const digest = createHash("sha256").update(canonicalJson(input.registration), "utf8").digest("hex");
  return `SPS-NATIVE-NODE-REGISTER-V1\n${input.hostId}\n${input.workspaceId}\n${input.deviceId}\n${input.timestamp}\n${input.nonce}\n${digest}`;
}

function signaturePath(input: SpsNativeNodeRuntimeInput): { method: string; path: string } {
  if (!input.nodeId || !UUID.test(input.nodeId)) throw unavailable();
  const nodeId = input.nodeId.toLowerCase();
  const command = input.resourceId && UUID.test(input.resourceId) ? input.resourceId.toLowerCase() : null;
  const source = input.resourceId && UUID.test(input.resourceId) ? input.resourceId.toLowerCase() : null;
  switch (input.operation) {
    case "heartbeat": return { method: "POST", path: `/sps-nodes/${nodeId}/heartbeat` };
    case "availability": return { method: "POST", path: `/sps-nodes/${nodeId}/runners/availability` };
    case "source-route": if (source) return { method: "POST", path: `/sps-nodes/${nodeId}/workspace-sources/${source}/claim-route` }; break;
    case "claim-command": return { method: "POST", path: `/sps-nodes/${nodeId}/commands/claim-next` };
    case "command-lease": if (command) return { method: "POST", path: `/sps-nodes/${nodeId}/commands/${command}/lease` }; break;
    case "command-event": if (command) return { method: "POST", path: `/sps-nodes/${nodeId}/commands/${command}/events` }; break;
    case "command-complete": if (command) return { method: "POST", path: `/sps-nodes/${nodeId}/commands/${command}/complete` }; break;
    case "claim-plugin-run": return { method: "POST", path: `/sps-nodes/${nodeId}/plugin-runs/claim-next` };
    case "plugin-lease": if (command) return { method: "POST", path: `/sps-nodes/${nodeId}/plugin-runs/${command}/lease` }; break;
    case "plugin-event": if (command) return { method: "POST", path: `/sps-nodes/${nodeId}/plugin-runs/${command}/events` }; break;
    case "plugin-complete": if (command) return { method: "POST", path: `/sps-nodes/${nodeId}/plugin-runs/${command}/complete` }; break;
  }
  throw unavailable();
}

function validateInput(value: unknown): SpsNativeNodeRuntimeInput {
  const input = exactRecord(value, ["workspaceId", "operation", "nodeId", "resourceId", "payload"]);
  if (typeof input.workspaceId !== "string" || !UUID.test(input.workspaceId)
    || typeof input.operation !== "string" || (input.operation !== "register" && !OPERATIONS.has(input.operation))
    || !(input.nodeId === null || typeof input.nodeId === "string" && UUID.test(input.nodeId))
    || !(input.resourceId === null || typeof input.resourceId === "string" && UUID.test(input.resourceId))) throw unavailable();
  if (input.operation === "register") {
    if (input.nodeId !== null || input.resourceId !== null) throw unavailable();
  } else {
    if (input.nodeId === null) throw unavailable();
    const needsResource = input.operation === "source-route"
      || ["command-lease", "command-event", "command-complete", "plugin-lease", "plugin-event", "plugin-complete"]
        .includes(String(input.operation));
    if (needsResource !== (input.resourceId !== null)) throw unavailable();
  }
  const payload = normalizeJson(input.payload);
  if (!payload || typeof payload !== "object" || Buffer.byteLength(canonicalJson(payload), "utf8") > MAX_PAYLOAD_BYTES) throw unavailable();
  return { ...input, payload } as unknown as SpsNativeNodeRuntimeInput;
}

/**
 * Executes the existing SPS Node operations only inside Main's authenticated,
 * transaction-scoped Native authority callback. It never starts local work.
 */
export function createSpsNativeNodeRuntime(db: Db) {
  let disposed = false;
  let active = 0;
  const controllers = new Set<AbortController>();

  return Object.freeze({
    async invoke(rawInput: unknown, withAuthority: SpsNativeNodeAuthority, signal?: AbortSignal): Promise<SpsNodeOperationResult> {
      if (disposed || typeof withAuthority !== "function" || active >= MAX_CONCURRENT) throw unavailable();
      const input = validateInput(rawInput);
      if (signal?.aborted) throw unavailable();
      active += 1;
      const localController = new AbortController();
      controllers.add(localController);
      const abortLocal = () => localController.abort();
      signal?.addEventListener("abort", abortLocal, { once: true });
      const effects: Array<() => Promise<unknown> | unknown> = [];
      try {
        const result = await withAuthority(async (tx, principal) => {
          if (disposed || localController.signal.aborted) throw unavailable();
          if (!principal || !UUID.test(principal.hostId) || !UUID.test(principal.deviceId)
            || !UUID.test(input.workspaceId) || typeof principal.userId !== "string" || !principal.userId
            || !Number.isSafeInteger(principal.deviceRevision) || principal.deviceRevision < 1
            || !/^[0-9a-f]{64}$/.test(principal.certificateSha256)
            || !Number.isSafeInteger(principal.certificateNotAfter) || principal.certificateNotAfter <= Date.now()) throw unavailable();

          await tx.select({ id: spsMemberDevices.id }).from(spsMemberDevices).where(and(
            eq(spsMemberDevices.id, principal.deviceId), eq(spsMemberDevices.hostId, principal.hostId),
            eq(spsMemberDevices.ownerUserId, principal.userId), eq(spsMemberDevices.status, "approved"),
            eq(spsMemberDevices.revision, principal.deviceRevision),
          )).then(rows => { if (!rows[0]) throw unavailable(); });

          const bindingService = spsNativeNodeBindingService(tx);
          const context: SpsNodeOperationContext = {
            userId: principal.userId,
            syncRunnerGrants: false,
            requeueStaleClaims: false,
            assertCurrent: () => { if (disposed || localController.signal.aborted) throw unavailable(); },
            authorizeWorkspace: companyId => { if (companyId !== input.workspaceId) throw unavailable(); },
            authorizeNode: async node => {
              const binding = await bindingService.get(node.id);
              if (!binding || binding.companyId !== input.workspaceId || binding.deviceId !== principal.deviceId
                || binding.hostId !== principal.hostId || binding.ownerUserId !== principal.userId
                || node.companyId !== input.workspaceId || node.ownerUserId !== principal.userId || node.status === "revoked") throw unavailable();
            },
            logMutation: async mutation => {
              if (mutation.companyId !== input.workspaceId) throw unavailable();
              // The shared operation service supplies the transaction-bound logger in Native composition.
              const { logActivity } = await import("../compat/paperclip/control-plane.js");
              await logActivity(tx, { companyId: mutation.companyId, actorType: "user", actorId: principal.userId,
                action: mutation.action, entityType: "sps_node", entityId: mutation.nodeId, details: mutation.details ?? {} });
            },
            afterCommit: effect => { effects.push(effect); },
          };

          const operations = createSpsNodeOperations(tx, { effectDb: db });
          if (input.operation === "register") {
            await context.authorizeWorkspace(input.workspaceId);
            const payload = exactRecord(input.payload, ["registration", "proof"]);
            const signedRegistration = payload.registration;
            const registration = createSpsNodeSchema.parse(signedRegistration);
            const proof = readRegistrationProof(payload.proof);
            let key: ReturnType<typeof createPublicKey>;
            try { key = createPublicKey(registration.publicKey); } catch { throw unavailable(); }
            if (key.asymmetricKeyType !== "ed25519") throw unavailable();

            const [prior] = await tx.select().from(spsNodes).where(and(
              eq(spsNodes.companyId, input.workspaceId), eq(spsNodes.publicKey, registration.publicKey),
            ));
            if (prior && (prior.ownerUserId !== principal.userId || prior.status === "revoked")) throw unavailable();
            if (prior) {
              // A Native refresh may update observations and labels, but must
              // not change the meaning of an existing runner grant.
              const submittedRunners = registration.runners ?? registration.capabilities.map(capability => ({
                runnerKey: `${capability.kind}:default`, kind: capability.kind,
              }));
              const priorProfiles = await tx.select({ runnerKey: spsNodeRunnerProfiles.runnerKey, kind: spsNodeRunnerProfiles.kind })
                .from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, prior.id));
              const priorKinds = new Map(priorProfiles.map(profile => [profile.runnerKey, profile.kind]));
              if (submittedRunners.some(runner => priorKinds.has(runner.runnerKey) && priorKinds.get(runner.runnerKey) !== runner.kind)
                || (prior.transportPublicKey ?? null) !== (registration.transportPublicKey ?? null)) throw unavailable();
              const priorBinding = await bindingService.get(prior.id);
              if (priorBinding && (priorBinding.deviceId !== principal.deviceId || priorBinding.hostId !== principal.hostId
                || priorBinding.ownerUserId !== principal.userId || priorBinding.companyId !== input.workspaceId)) throw unavailable();
            }
            const message = registrationMessage({ hostId: principal.hostId, workspaceId: input.workspaceId,
              deviceId: principal.deviceId, timestamp: proof.timestamp, nonce: proof.nonce, registration: signedRegistration });
            if (!verify(null, Buffer.from(message, "utf8"), key, Buffer.from(proof.signature, "base64"))) throw unavailable();

            const registered = await operations.register({ workspaceId: input.workspaceId, payload: registration }, context);
            const data = registered.data as { id?: unknown; status?: unknown; ownerUserId?: unknown };
            if (typeof data?.id !== "string" || data.ownerUserId !== principal.userId || data.status === "revoked") throw unavailable();
            const nonceHash = createHash("sha256").update(`native-register:${data.id}:${proof.nonce}`, "utf8").digest("hex");
            const signedAt = new Date(proof.timestamp);
            const [nonce] = await tx.select({ id: spsNodeHeartbeats.id }).from(spsNodeHeartbeats)
              .where(eq(spsNodeHeartbeats.nonceHash, nonceHash));
            if (nonce) throw unavailable();
            await tx.insert(spsNodeHeartbeats).values({ nodeId: data.id, nonceHash, signedAt,
              expiresAt: new Date(signedAt.getTime() + MAX_CLOCK_SKEW_MS + 60_000) });
            await bindingService.bind({ nodeId: data.id, companyId: input.workspaceId,
              deviceId: principal.deviceId, hostId: principal.hostId, ownerUserId: principal.userId });
            if (disposed || localController.signal.aborted || signal?.aborted) throw unavailable();
            return registered;
          }

          const route = signaturePath(input);
          const operationInput = { operation: input.operation as NodeOperation, nodeId: input.nodeId!, resourceId: input.resourceId, payload: input.payload };
          const response = await operations.invoke(operationInput, { ...context, signatureMethod: route.method, signaturePath: route.path });
          if (disposed || localController.signal.aborted || signal?.aborted) throw unavailable();
          return response;
        });
        for (const effect of effects) {
          try { await effect(); } catch { /* durable Node completion remains committed; async cancellation is best-effort */ }
        }
        if (disposed || localController.signal.aborted || signal?.aborted) throw unavailable();
        return result;
      } finally {
        signal?.removeEventListener("abort", abortLocal);
        controllers.delete(localController);
        active -= 1;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  });
}
