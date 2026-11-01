import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { createSpsPluginArtifactReferenceReader } from "./sps-plugin-artifact-references.js";
import { captureSpsPluginArtifactReferencePath } from "./sps-plugin-artifact-reference-path.js";

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
type Request = { v: 1; kind: typeof REQUEST; channelId: string; id: string; transactionId: string; operation: "begin" | "check" | "end"; parentPaths?: unknown };
type ParentPath = { source: string; ownerId: string; state: string; path: string; kind: "file" | "directory" };

function parentPaths(value: unknown): readonly ParentPath[] {
  if (!Array.isArray(value) || value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1
    || Object.keys(value).length !== value.length) throw new Error(FAILURE);
  const entries = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) {
    if (!entries[index]?.enumerable || !("value" in entries[index])) throw new Error(FAILURE);
  }
  const seen = new Set<string>();
  const text = (value: unknown): value is string => typeof value === "string" && value.length > 0
    && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  const result = Object.freeze(Array.from({ length: value.length }, (_, index) => {
    const item: unknown = entries[index].value;
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new Error(FAILURE);
    const fields = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(fields).length !== 5 || ["source", "ownerId", "state", "path", "kind"]
      .some(key => !fields[key]?.enumerable || !("value" in fields[key]))) throw new Error(FAILURE);
    const reference = item as ParentPath;
    if (!text(reference.source) || !text(reference.ownerId) || !text(reference.state)
      || typeof reference.path !== "string" || !reference.path || reference.path.length > 32_768
      || /[\u0000-\u001f\u007f]/.test(reference.path) || !path.isAbsolute(reference.path)
      || path.resolve(reference.path) !== reference.path || !["file", "directory"].includes(reference.kind)) throw new Error(FAILURE);
    const result = { source: reference.source, ownerId: reference.ownerId, state: reference.state, path: reference.path, kind: reference.kind };
    const key = JSON.stringify(result);
    if (seen.has(key)) throw new Error(FAILURE);
    seen.add(key);
    return Object.freeze(result);
  }));
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 4 * 1024 * 1024) throw new Error(FAILURE);
  return result;
}

function request(value: unknown): Request | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    const names = ["v", "kind", "channelId", "id", "transactionId", "operation"];
    if (fields.operation?.value === "begin" && Object.hasOwn(fields, "parentPaths")) names.push("parentPaths");
    if (Reflect.ownKeys(fields).length !== names.length
      || names.some(key => !fields[key]?.enumerable || !("value" in fields[key]))) return null;
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
  let active: { transactionId: string; scope: { assertCurrent(): Promise<void> } | null; poisoned: boolean;
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
      const owner = { transactionId: input.transactionId, scope: null as { assertCurrent(): Promise<void> } | null,
        poisoned: false, endRequest: null as Request | null, release, checks: Promise.resolve(), finished: Promise.resolve() };
      active = owner;
      let snapshotEntered = false;
      owner.finished = (async () => {
        let success = false;
        try {
          const parent = Object.hasOwn(input, "parentPaths") ? parentPaths(input.parentPaths) : undefined;
          await reader.withSnapshot(async scope => {
            const captures = new Map<string, Awaited<ReturnType<typeof captureSpsPluginArtifactReferencePath>>>();
            const canonicalParent = [];
            for (const reference of parent ?? []) {
              const key = JSON.stringify([reference.path, reference.kind]);
              // Parent launch inputs include pnpm's hardlinked loader files.
              // This only retains read references; removal ownership stays
              // separate. Identity, link count and metadata must remain fixed.
              if (!captures.has(key)) captures.set(key, await captureSpsPluginArtifactReferencePath(reference.path,
                reference.kind, { allowFileHardlinks: true }));
              canonicalParent.push(Object.freeze({ ...reference, canonicalPath: captures.get(key)!.canonicalPath }));
            }
            owner.scope = parent === undefined ? scope : Object.freeze({ async assertCurrent() {
              await scope.assertCurrent();
              for (const capture of captures.values()) await capture.assertCurrent();
            } });
            if (parent !== undefined) await owner.scope.assertCurrent();
            snapshotEntered = true;
            const snapshot = parent === undefined
              ? { coverage: scope.coverage, fingerprint: scope.fingerprint, references: scope.references }
              : { coverage: "core-and-parent-paths", fingerprint: createHash("sha256")
                .update(JSON.stringify([scope.fingerprint, canonicalParent])).digest("hex"), references: scope.references,
              parentPaths: Object.freeze(canonicalParent) };
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
            if (parent !== undefined) await owner.scope.assertCurrent();
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
