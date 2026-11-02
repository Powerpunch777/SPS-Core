import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, spsMemberDevices, spsNativeNodeBindings, spsNodeHeartbeats, spsNodeRunnerProfiles, spsNodes } from "@paperclipai/db";
import type { Db } from "../compat/paperclip/db.js";
import { createSpsNativeNodeRuntime, type SpsNativeNodeAuthority, type SpsNativeNodePrincipal } from "../services/sps-native-node-runtime.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

describeDatabase("Native SPS Node runtime", () => {
  let db: Db;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const workspaceId = "a8c82933-73db-4b6f-9e5b-647fd0d38777";
  const hostId = "a4fbbf32-72a0-4a59-aea8-b95c1a319bdd";
  const deviceId = "0ebbd1fb-a22b-47a5-8bfc-632052021a01";
  const userId = "native-node-owner";
  const certificateSha256 = "a".repeat(64);
  let pair: ReturnType<typeof generateKeyPairSync>;
  let principal: SpsNativeNodePrincipal;
  let runtime: ReturnType<typeof createSpsNativeNodeRuntime>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("sps-native-node-runtime-");
    db = createDb(database.connectionString);
  }, 180_000);
  afterEach(async () => {
    runtime?.dispose();
    await db.delete(activityLog);
    await db.delete(spsNodeHeartbeats);
    await db.delete(spsNativeNodeBindings);
    await db.delete(spsNodes);
    await db.delete(spsMemberDevices);
    await db.delete(companies);
  });
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  }, 30_000);

  async function setup() {
    pair = generateKeyPairSync("ed25519");
    principal = { hostId, userId, deviceId, deviceRevision: 1, certificateSha256, certificateNotAfter: Date.now() + 60_000 };
    runtime = createSpsNativeNodeRuntime(db);
    await db.insert(companies).values({ id: workspaceId, name: "Native Node fixture", issuePrefix: "NN" });
    await db.insert(spsMemberDevices).values({ id: deviceId, hostId, ownerUserId: userId,
      displayName: "Native Node fixture device", certificate: "fixture-public-certificate", certificateSha256,
      spkiSha256: "b".repeat(64), certificateNotBefore: new Date(Date.now() - 60_000),
      certificateNotAfter: new Date(principal.certificateNotAfter), status: "approved", revision: 1 });
  }

  function registration() {
    return { displayName: "Fixture Node", publicKey: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      platform: "win32", appVersion: "1.0.0", capabilities: [] };
  }

  function signedRegistration(registrationValue: ReturnType<typeof registration>, nonce: string, options: { deviceId?: string; keyPair?: typeof pair } = {}) {
    const proofDeviceId = options.deviceId ?? deviceId;
    const signingPair = options.keyPair ?? pair;
    const timestamp = new Date().toISOString();
    const message = `SPS-NATIVE-NODE-REGISTER-V1\n${hostId}\n${workspaceId}\n${proofDeviceId}\n${timestamp}\n${nonce}\n${hash(canonical(registrationValue))}`;
    return { timestamp, nonce, signature: sign(null, Buffer.from(message), signingPair.privateKey).toString("base64") };
  }

  const withAuthority: SpsNativeNodeAuthority = async <T>(action: (tx: Db, actor: SpsNativeNodePrincipal) => Promise<T>) =>
    db.transaction(tx => action(tx as unknown as Db, principal));

  it("registers only with Ed25519 proof of the exact workspace, Host, device, time, nonce, and canonical registration", async () => {
    await setup();
    const registrationValue = registration();
    const nonce = "registration_nonce_12345678901234567890";
    const result = await runtime.invoke({ workspaceId, operation: "register", nodeId: null, resourceId: null,
      payload: { registration: registrationValue, proof: signedRegistration(registrationValue, nonce) } }, withAuthority);
    expect(result.status).toBe(201);
    const node = result.data as { id: string; status: string; ownerUserId: string };
    expect(node).toMatchObject({ status: "pending", ownerUserId: userId });
    expect(await db.select().from(spsNativeNodeBindings)).toMatchObject([{
      nodeId: node.id, companyId: workspaceId, deviceId, hostId, ownerUserId: userId,
    }]);
    await expect(db.delete(spsMemberDevices).where(eq(spsMemberDevices.id, deviceId))).rejects.toThrow();
    expect(await db.select().from(spsNativeNodeBindings)).toMatchObject([{
      nodeId: node.id, companyId: workspaceId, deviceId, hostId, ownerUserId: userId,
    }]);
    const [registrationReceipt] = await db.select().from(spsNodeHeartbeats);
    expect(registrationReceipt!.nonceHash).toBe(hash(`native-register:${node.id}:${nonce}`));
    expect(registrationReceipt!.nonceHash).not.toBe(hash(nonce));

    const timestamp = new Date().toISOString(), heartbeatNonce = "heartbeat_nonce_12345678901234567890";
    const heartbeatMessage = `SPS-NODE-HEARTBEAT-V1\n${node.id}\n${timestamp}\n${heartbeatNonce}`;
    const heartbeat = await runtime.invoke({ workspaceId, operation: "heartbeat", nodeId: node.id, resourceId: null,
      payload: { timestamp, nonce: heartbeatNonce, signature: sign(null, Buffer.from(heartbeatMessage), pair.privateKey).toString("base64") } }, withAuthority);
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.data).toMatchObject({ id: node.id, status: "pending", keyVerifiedAt: expect.any(Date) });

    const renewedCertificateSha256 = "e".repeat(64);
    const renewedNotAfter = Date.now() + 120_000;
    await db.update(spsMemberDevices).set({ certificateSha256: renewedCertificateSha256,
      certificateNotAfter: new Date(renewedNotAfter) }).where(eq(spsMemberDevices.id, deviceId));
    principal = { ...principal, certificateSha256: renewedCertificateSha256, certificateNotAfter: renewedNotAfter };
    const renewedTimestamp = new Date().toISOString(), renewedNonce = "renewed_device_heartbeat_nonce_123456789";
    const renewedMessage = `SPS-NODE-HEARTBEAT-V1\n${node.id}\n${renewedTimestamp}\n${renewedNonce}`;
    const afterRenewal = await runtime.invoke({ workspaceId, operation: "heartbeat", nodeId: node.id, resourceId: null,
      payload: { timestamp: renewedTimestamp, nonce: renewedNonce,
        signature: sign(null, Buffer.from(renewedMessage), pair.privateKey).toString("base64") } }, withAuthority);
    expect(afterRenewal.status).toBe(200);
    expect(await db.select().from(spsNativeNodeBindings)).toMatchObject([{
      nodeId: node.id, companyId: workspaceId, deviceId, hostId, ownerUserId: userId,
    }]);

    await db.update(spsMemberDevices).set({ status: "revoked" }).where(eq(spsMemberDevices.id, deviceId));
    const revokedTimestamp = new Date().toISOString(), revokedNonce = "revoked_device_heartbeat_nonce_123456789";
    const revokedMessage = `SPS-NODE-HEARTBEAT-V1\n${node.id}\n${revokedTimestamp}\n${revokedNonce}`;
    await expect(runtime.invoke({ workspaceId, operation: "heartbeat", nodeId: node.id, resourceId: null,
      payload: { timestamp: revokedTimestamp, nonce: revokedNonce,
        signature: sign(null, Buffer.from(revokedMessage), pair.privateKey).toString("base64") } }, withAuthority)).rejects.toThrow();
  });

  it("rejects replay, a different device transfer, and operations on an unbound preexisting Node", async () => {
    await setup();
    const registrationValue = registration();
    const firstProof = signedRegistration(registrationValue, "registration_nonce_12345678901234567890");
    const input = { workspaceId, operation: "register" as const, nodeId: null, resourceId: null,
      payload: { registration: registrationValue, proof: firstProof } };
    const first = await runtime.invoke(input, withAuthority);
    await expect(runtime.invoke(input, withAuthority)).rejects.toThrow();
    const nodeId = (first.data as { id: string }).id;

    const otherDeviceId = "30c9d941-1338-40b6-8e50-b011262d3df1";
    await db.insert(spsMemberDevices).values({ id: otherDeviceId, hostId, ownerUserId: userId,
      displayName: "Second fixture device", certificate: "other-public-certificate", certificateSha256: "c".repeat(64),
      spkiSha256: "d".repeat(64), certificateNotBefore: new Date(Date.now() - 60_000),
      certificateNotAfter: new Date(Date.now() + 60_000), status: "approved", revision: 1 });
    const originalPrincipal = principal;
    principal = { ...principal, deviceId: otherDeviceId, certificateSha256: "c".repeat(64) };
    const transferProof = signedRegistration(registrationValue, "registration_nonce_abcdefghijklmnopqrstuvwxyz", { deviceId: otherDeviceId });
    await expect(runtime.invoke({ ...input, payload: { registration: registrationValue, proof: transferProof } }, withAuthority)).rejects.toThrow();
    principal = originalPrincipal;

    const foreignPair = generateKeyPairSync("ed25519");
    const foreignNode = await db.insert(spsNodes).values({ id: "bf2a3621-d6a1-4c34-99c5-dc5cd97750f6", companyId: workspaceId,
      ownerUserId: userId, displayName: "Unbound", publicKey: foreignPair.publicKey.export({ format: "pem", type: "spki" }).toString(),
      platform: "win32", capabilities: [], status: "active", keyVerifiedAt: new Date() }).returning().then(rows => rows[0]!);
    const timestamp = new Date().toISOString(), nonce = "request_nonce_12345678901234567890";
    const body = { runners: [{ runnerKey: "claude_cli:default", availability: { status: "unknown", observedAt: timestamp, source: "node_probe" } }] };
    const bodyHash = hash(canonical({ ...body }));
    const message = ["SPS-NODE-REQUEST-V1", foreignNode.id, "POST", `/sps-nodes/${foreignNode.id}/runners/availability`, timestamp, nonce, bodyHash].join("\n");
    await expect(runtime.invoke({ workspaceId, operation: "availability", nodeId: foreignNode.id, resourceId: null,
      payload: { ...body, timestamp, nonce, signature: sign(null, Buffer.from(message), foreignPair.privateKey).toString("base64") } }, withAuthority)).rejects.toThrow();
    expect((await db.select().from(spsNativeNodeBindings)).map(row => row.nodeId)).toEqual([nodeId]);
  });

  it("rejects reinterpreting an existing runner grant through a Native registration refresh", async () => {
    await setup();
    const original = { ...registration(), runners: [{ runnerKey: "cli:primary", kind: "claude_cli", label: "CLI" }] };
    const created = await runtime.invoke({ workspaceId, operation: "register", nodeId: null, resourceId: null,
      payload: { registration: original, proof: signedRegistration(original, "runner_kind_initial_nonce_123456789") } }, withAuthority);
    const nodeId = (created.data as { id: string }).id;

    const changedKind = { ...original, runners: [{ runnerKey: "cli:primary", kind: "codex_cli", label: "CLI" }] };
    await expect(runtime.invoke({ workspaceId, operation: "register", nodeId: null, resourceId: null,
      payload: { registration: changedKind, proof: signedRegistration(changedKind, "runner_kind_change_nonce_123456789") } }, withAuthority)).rejects.toThrow();
    const sameKind = await runtime.invoke({ workspaceId, operation: "register", nodeId: null, resourceId: null,
      payload: { registration: original, proof: signedRegistration(original, "runner_kind_refresh_nonce_123456789") } }, withAuthority);
    expect((sameKind.data as { id: string }).id).toBe(nodeId);
    expect(await db.select().from(spsNodeRunnerProfiles).where(eq(spsNodeRunnerProfiles.nodeId, nodeId)))
      .toMatchObject([{ runnerKey: "cli:primary", kind: "claude_cli" }]);
  });

  it("rejects malformed operation selectors before the authority callback", async () => {
    await setup();
    let calls = 0;
    const unused = (async <T>(action: (tx: Db, actor: SpsNativeNodePrincipal) => Promise<T>) => {
      calls++;
      return db.transaction(tx => action(tx as unknown as Db, principal));
    }) as SpsNativeNodeAuthority;
    await expect(runtime.invoke({ workspaceId, operation: "../commands/claim-next", nodeId: null, resourceId: null, payload: {} }, unused)).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
