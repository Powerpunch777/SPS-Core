import { randomUUID } from "node:crypto";
import type { createSpsPluginArtifactReferenceReader, SpsPluginArtifactReferenceScope } from "./sps-plugin-artifact-references.js";

const REQUEST = "sps.plugin-artifacts.request";
const RESPONSE = "sps.plugin-artifacts.response";
const READY = "sps.plugin-artifacts.ready";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const FAILURE = "plugin_artifact_channel_unavailable";
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
type Channel = {
  connected?: boolean;
  send(message: unknown, callback: (error: Error | null) => void): unknown;
  on(event: string, listener: (message?: unknown) => void): unknown;
  removeListener(event: string, listener: (message?: unknown) => void): unknown;
};
type Request = { v: 1; kind: typeof REQUEST; channelId: string; id: string; transactionId: string; operation: "begin" | "check" | "end" };

function request(value: unknown): Request | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).length !== 6
      || ["v", "kind", "channelId", "id", "transactionId", "operation"].some(key => !fields[key]?.enumerable || !("value" in fields[key]))) return null;
    const input = value as Request;
    if (input.v !== 1 || input.kind !== REQUEST || typeof input.channelId !== "string" || !UUID.test(input.channelId)
      || typeof input.id !== "string" || !UUID.test(input.id) || typeof input.transactionId !== "string"
      || !UUID.test(input.transactionId) || !["begin", "check", "end"].includes(input.operation)) return null;
    return input;
  } catch { return null; }
}

/** Private direct-parent observation scope. No HTTP, SDK or deletion authority. */
export function createSpsPluginArtifactParentChannel(reader: ReturnType<typeof createSpsPluginArtifactReferenceReader>, channel: Channel) {
  if (!reader || typeof reader.withSnapshot !== "function" || !channel || channel.connected !== true
    || typeof channel.send !== "function" || typeof channel.on !== "function" || typeof channel.removeListener !== "function") {
    throw new TypeError("Invalid private artifact reference channel.");
  }
  const channelId = randomUUID();
  let closed = false;
  let active: { transactionId: string; scope: SpsPluginArtifactReferenceScope | null; poisoned: boolean;
    endRequest: Request | null; release(): void; checks: Promise<void>; finished: Promise<void> } | null = null;
  const seen = new Set<string>();
  const transactions = new Set<string>();
  const send = (message: unknown) => new Promise<void>((resolve, reject) => {
    try {
      if (closed || channel.connected !== true) throw new Error(FAILURE);
      channel.send(message, error => error ? reject(new Error(FAILURE)) : resolve());
    } catch { reject(new Error(FAILURE)); }
  });
  const response = (input: Request, ok: boolean, snapshot?: unknown) => send({
    v: 1, kind: RESPONSE, channelId, id: input.id, transactionId: input.transactionId, operation: input.operation, ok,
    ...(ok ? snapshot === undefined ? {} : { snapshot } : { errorCode: FAILURE }),
  });
  // A lost channel/reply never releases the Core maintenance scope by timeout.
  // Normal parent end or actual owned Core process termination is required.
  const onDisconnect = () => { closed = true; if (active) active.poisoned = true; };
  const onMessage = (value: unknown) => {
    if (closed || channel.connected !== true) return;
    let kind;
    try { kind = Object.getOwnPropertyDescriptor(value ?? {}, "kind")?.value; } catch { return; }
    if (kind !== REQUEST) return;
    const input = request(value);
    if (!input || input.channelId !== channelId) {
      if (active) active.poisoned = true;
      return;
    }
    if (seen.has(input.id) || seen.size >= 10_000) {
      if (active) active.poisoned = true;
      void response(input, false).catch(() => {});
      return;
    }
    seen.add(input.id);
    if (input.operation === "begin") {
      if (active || transactions.has(input.transactionId) || transactions.size >= 10_000) { void response(input, false).catch(() => {}); return; }
      transactions.add(input.transactionId);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const owner = { transactionId: input.transactionId, scope: null as SpsPluginArtifactReferenceScope | null,
        poisoned: false, endRequest: null as Request | null, release, checks: Promise.resolve(), finished: Promise.resolve() };
      active = owner;
      let snapshotEntered = false;
      owner.finished = (async () => {
        let success = false;
        try {
          await reader.withSnapshot(async scope => {
            owner.scope = scope;
            snapshotEntered = true;
            const snapshot = { coverage: scope.coverage, fingerprint: scope.fingerprint, references: scope.references };
            if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > MAX_SNAPSHOT_BYTES) {
              owner.poisoned = true;
              // No snapshot escaped; a normal negative begin can release safely.
              owner.scope = null;
              throw new Error(FAILURE);
            }
            try { await response(input, true, snapshot); }
            catch { owner.poisoned = true; }
            await held;
            await owner.checks;
            if (owner.poisoned || closed || channel.connected !== true) throw new Error(FAILURE);
          });
          success = true;
        } catch {
          if (!snapshotEntered || owner.scope === null) await response(input, false).catch(() => {});
        } finally {
          if (active === owner) active = null;
        }
        if (owner.endRequest) await response(owner.endRequest, success).catch(() => {});
      })();
      void owner.finished.catch(() => {});
      return;
    }
    const owner = active;
    if (!owner || owner.transactionId !== input.transactionId || !owner.scope || owner.endRequest) {
      void response(input, false).catch(() => {}); return;
    }
    if (input.operation === "end") {
      owner.endRequest = input;
      owner.release();
      return;
    }
    owner.checks = owner.checks.then(async () => {
      let ok = false;
      try {
        if (owner.poisoned || closed || active !== owner || !owner.scope) throw new Error(FAILURE);
        await owner.scope.assertCurrent();
        if (owner.poisoned || closed || active !== owner) throw new Error(FAILURE);
        ok = true;
      } catch { owner.poisoned = true; }
      try { await response(input, ok); } catch { owner.poisoned = true; }
    });
  };
  channel.on("message", onMessage);
  channel.on("disconnect", onDisconnect);
  channel.on("exit", onDisconnect);
  void send({ v: 1, kind: READY, channelId }).catch(onDisconnect);
  return Object.freeze({
    // Revoke observation immediately. A held lock remains fail-closed until
    // exact Core process termination; disposal is not an implicit end receipt.
    dispose() {
      onDisconnect();
      channel.removeListener("message", onMessage);
      channel.removeListener("disconnect", onDisconnect);
      channel.removeListener("exit", onDisconnect);
    },
  });
}
