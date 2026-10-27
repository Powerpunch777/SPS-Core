import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { companies, companyMemberships, type Db } from "../compat/paperclip/db.js";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { spsMemberDeviceService } from "./sps-member-devices.js";
import { spsWorkspaceSurfaceService } from "./sps-workspace-surfaces.js";
import type { createSpsNativePluginRuntime, SpsNativePluginPrincipal, SpsNativePluginRequest } from "./sps-native-plugin-runtime.js";
import type {
  SpsNativeWorkspaceProof,
  SpsNativeWorkspaceProofActualRequest,
} from "./sps-native-workspace-proof.js";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const SAFE_FAILURE = "Native Workspace access is unavailable.";

type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "resolveNativeEnrollmentSessionFromHeaders">;
type Verifier = Readonly<{
  verify(header: string, actual: SpsNativeWorkspaceProofActualRequest): SpsNativeWorkspaceProof;
}>;
type ReadResult =
  | ReadonlyArray<Readonly<{ id: string; name: string }>>
  | SpsNativeWorkspaceBootstrap
  | Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["listShellProviders"]>>
  | Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["getShell"]>>
  | { widgets: Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["listDashboard"]>> }
  | { items: Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["listInbox"]>> }
  | Readonly<{ readAt: string | null; archivedAt: string | null }>
  | Readonly<{ data: unknown }>;

type SpsNativeWorkspaceBootstrap = Readonly<{
  v: 1;
  kind: "sps.native.workspace.bootstrap";
  workspace: Readonly<{ id: string; name: string; issuePrefix: string }>;
  member: Readonly<{ userId: string }>;
  capabilities: readonly ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read"]
    | readonly ["workspace.shell.read", "workspace.dashboard.read", "workspace.inbox.read", "workspace.inbox.state.write"];
}>;

type Options = {
  db: Db;
  identity: Identity;
  hostId: string;
  verifier: Verifier;
  assertCurrent: () => void;
  getPluginRuntime?: () => ReturnType<typeof createSpsNativePluginRuntime> | undefined;
};

type SurfaceOperation =
  | { workspaceId: null; kind: "workspace-discovery" }
  | { workspaceId: string; kind: "workspace-bootstrap" }
  | { workspaceId: string; kind: "shell-providers" }
  | { workspaceId: string; kind: "shell" }
  | { workspaceId: string; kind: "dashboard" }
  | { workspaceId: string; kind: "inbox"; archived: boolean }
  | { workspaceId: string; itemId: string; kind: "inbox-state" };

export class SpsNativeWorkspaceSurfaceError extends Error {
  readonly status = 403;
  readonly code = "native_workspace_unavailable";
  constructor() { super(SAFE_FAILURE); }
}

function fail(): never { throw new SpsNativeWorkspaceSurfaceError(); }

function assertCurrent(assertion: () => void) {
  try {
    const result = assertion();
    if (result !== undefined) {
      if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
      fail();
    }
  } catch { fail(); }
}

function parseInboxState(body: Buffer): Readonly<{ read?: boolean; archived?: boolean }> {
  if (!Buffer.isBuffer(body) || body.length < 2 || body.length > 128) fail();
  const text = body.toString("utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail();
  const prototype = Object.getPrototypeOf(parsed);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const descriptors = Object.getOwnPropertyDescriptors(parsed);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length < 1 || keys.length > 2 || keys.some(key => key !== "read" && key !== "archived")) fail();
  const state: { read?: boolean; archived?: boolean } = {};
  for (const key of keys as Array<"read" | "archived">) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "boolean") fail();
    state[key] = descriptor.value;
  }
  if (JSON.stringify(state) !== text) fail();
  return Object.freeze(state);
}

function matchTarget(target: string): SurfaceOperation {
  if (target === "/sps-native/v1/workspaces") return { workspaceId: null, kind: "workspace-discovery" };
  const bootstrap = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-bootstrap$/.exec(target);
  if (bootstrap) return { workspaceId: bootstrap[1]!, kind: "workspace-bootstrap" };
  const shellProviders = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-shell\/providers$/.exec(target);
  if (shellProviders) return { workspaceId: shellProviders[1]!, kind: "shell-providers" };
  const shell = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-shell$/.exec(target);
  if (shell) return { workspaceId: shell[1]!, kind: "shell" };
  const dashboard = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-dashboard$/.exec(target);
  if (dashboard) return { workspaceId: dashboard[1]!, kind: "dashboard" };
  const inbox = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-inbox(?:\?archived=(true|false))?$/.exec(target);
  if (inbox) return { workspaceId: inbox[1]!, kind: "inbox", archived: inbox[2] === "true" };
  const inboxState = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-inbox\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/.exec(target);
  if (inboxState) return { workspaceId: inboxState[1]!, itemId: inboxState[2]!, kind: "inbox-state" };
  return fail();
}

/**
 * Core-side allowlisted Native Workspace surface reader. It has no listener or
 * Express integration; the private HTTP composition owns request framing.
 */
export function createSpsNativeWorkspaceSurfaceReader({ db, identity, hostId, verifier,
  assertCurrent: assertCurrentInput, getPluginRuntime }: Options) {
  if (!db || !identity || typeof identity.resolveNativeEnrollmentSessionFromHeaders !== "function"
    || !UUID.test(hostId) || !verifier || typeof verifier.verify !== "function"
    || typeof assertCurrentInput !== "function") throw new TypeError("Invalid Native Workspace surface reader configuration.");
  const devices = spsMemberDeviceService(db, hostId);

  return Object.freeze({
    async read(header: string, actual: SpsNativeWorkspaceProofActualRequest, signal?: AbortSignal): Promise<ReadResult> {
      try {
        assertCurrent(assertCurrentInput);
        const proof = verifier.verify(header, actual);
        if (actual.target === "/sps-native/v1/plugin-runtime") {
          if (actual.method !== "POST" || proof.method !== "POST" || actual.contentType !== "application/json"
            || proof.workspaceId === null || proof.hostId !== hostId || !getPluginRuntime
            || actual.body.length < 2 || actual.body.length > 64 * 1024 || signal?.aborted) fail();
          const text = new TextDecoder("utf-8", { fatal: true }).decode(actual.body);
          const parsed: unknown = JSON.parse(text);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
            || JSON.stringify(parsed) !== text || !["key,operation,params,pluginId,surface,surfaceId",
              "key,operation,params,pluginId,revision,surface,surfaceId"].includes(Object.keys(parsed).sort().join(","))) fail();
          const input = { ...parsed, workspaceId: proof.workspaceId } as SpsNativePluginRequest;
          const session = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie: proof.cookie }));
          if (!session || typeof session.authorizeInTransaction !== "function" || !session.userId) fail();
          const userId = session.userId;
          const workspaceId = proof.workspaceId;
          const certificateSha256 = createHash("sha256").update(proof.peerCertificateDer).digest("hex");
          const authorizeNative = async (): Promise<SpsNativePluginPrincipal> => {
            assertCurrent(assertCurrentInput);
            if (signal?.aborted) fail();
            const authorized = await db.transaction(async tx => {
              await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
              await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
              await session.authorizeInTransaction(tx, userId);
              const grant = await devices.authorizeInTransaction(tx, { companyId: workspaceId, userId, certificateSha256 });
              if (grant.hostId !== hostId || grant.companyId !== workspaceId || grant.userId !== userId
                || grant.certificateSha256 !== certificateSha256 || grant.certificateNotAfter.getTime() <= Date.now()) fail();
              assertCurrent(assertCurrentInput);
              if (signal?.aborted) fail();
              await session.authorizeInTransaction(tx, userId);
              return Object.freeze({ hostId, userId, deviceId: grant.deviceId, deviceRevision: grant.revision,
                certificateSha256, certificateNotAfter: grant.certificateNotAfter.getTime() });
            });
            assertCurrent(assertCurrentInput);
            if (signal?.aborted) fail();
            return authorized;
          };
          const runtime = getPluginRuntime();
          if (!runtime) fail();
          await authorizeNative();
          const data = await runtime.invoke(input, authorizeNative, signal);
          await authorizeNative();
          assertCurrent(assertCurrentInput);
          if (signal?.aborted || getPluginRuntime() !== runtime) fail();
          return Object.freeze({ data });
        }
        const operation = matchTarget(proof.target);
        const isInboxState = operation.kind === "inbox-state";
        if (proof.hostId !== hostId || proof.method !== actual.method
          || (isInboxState
            ? actual.method !== "PATCH" || actual.contentType !== "application/json"
            : actual.method !== "GET" || actual.body.length !== 0 || actual.contentType !== "")
          || operation.workspaceId !== proof.workspaceId) fail();
        const inboxState = isInboxState ? parseInboxState(actual.body) : undefined;
        assertCurrent(assertCurrentInput);

        const session = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie: proof.cookie }));
        assertCurrent(assertCurrentInput);
        if (!session || typeof session.userId !== "string" || !session.userId || session.userId.length > 200
          || /[\u0000-\u001f\u007f]/.test(session.userId)
          || typeof session.authorizeInTransaction !== "function") fail();
        const userId = session.userId;
        const certificateSha256 = createHash("sha256").update(proof.peerCertificateDer).digest("hex");

        const result = await db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
          const assertSession = async () => {
            assertCurrent(assertCurrentInput);
            await session.authorizeInTransaction(tx, userId);
            assertCurrent(assertCurrentInput);
          };
          await assertSession();
          if (operation.kind === "workspace-discovery") {
            const initial = await devices.listAuthorizedWorkspacesInTransaction(tx, { userId, certificateSha256 });
            if (!UUID.test(initial.deviceId) || !Number.isSafeInteger(initial.revision) || initial.revision < 1
              || initial.hostId !== hostId || initial.userId !== userId || initial.certificateSha256 !== certificateSha256
              || !(initial.certificateNotAfter instanceof Date) || !Number.isFinite(initial.certificateNotAfter.getTime())
              || initial.certificateNotAfter.getTime() <= Date.now() || !Array.isArray(initial.workspaces)
              || initial.workspaces.length > 200
              || initial.workspaces.some(workspace => !UUID.test(workspace.id) || typeof workspace.name !== "string")) fail();
            assertCurrent(assertCurrentInput);
            await assertSession();
            const final = await devices.listAuthorizedWorkspacesInTransaction(tx, { userId, certificateSha256 });
            if (final.deviceId !== initial.deviceId || final.revision !== initial.revision
              || final.hostId !== initial.hostId || final.userId !== initial.userId
              || final.certificateSha256 !== initial.certificateSha256
              || final.certificateNotAfter.getTime() !== initial.certificateNotAfter.getTime()) fail();
            assertCurrent(assertCurrentInput);
            return final.workspaces;
          }
          if (operation.workspaceId === null) fail();
          const authorizeDevice = async () => {
            const grant = await devices.authorizeInTransaction(tx, {
              companyId: operation.workspaceId,
              userId,
              certificateSha256,
            });
            if (!UUID.test(grant.deviceId) || !Number.isSafeInteger(grant.revision) || grant.revision < 1
              || grant.hostId !== hostId || grant.companyId !== operation.workspaceId || grant.userId !== userId
              || grant.certificateSha256 !== certificateSha256 || !(grant.certificateNotAfter instanceof Date)
              || !Number.isFinite(grant.certificateNotAfter.getTime()) || grant.certificateNotAfter.getTime() <= Date.now()) fail();
            assertCurrent(assertCurrentInput);
            return grant;
          };

          if (!operation.workspaceId) fail();
          const workspaceId = operation.workspaceId;
          const initialGrant = await authorizeDevice();
          const membershipRole = async () => {
            const rows = await tx.select({ membershipRole: companyMemberships.membershipRole })
              .from(companyMemberships)
              .where(and(
                eq(companyMemberships.companyId, workspaceId),
                eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, userId),
                eq(companyMemberships.status, "active"),
              ))
              .for("share")
              .limit(2);
            if (!Array.isArray(rows) || rows.length !== 1) fail();
            return rows[0]!.membershipRole;
          };
          if (operation.kind === "workspace-bootstrap") {
            const rows = await tx.select({
              id: companies.id,
              name: companies.name,
              issuePrefix: companies.issuePrefix,
            }).from(companies).where(eq(companies.id, operation.workspaceId)).limit(2);
            if (!Array.isArray(rows) || rows.length !== 1) fail();
            const row = rows[0];
            if (!row || row.id !== operation.workspaceId || typeof row.name !== "string" || row.name.length === 0
              || typeof row.issuePrefix !== "string" || row.issuePrefix.length === 0) fail();
            const role = await membershipRole();
            if (role !== "member" && role !== "admin" && role !== "viewer") fail();
            assertCurrent(assertCurrentInput);
            await assertSession();
            const finalGrant = await authorizeDevice();
            if (finalGrant.deviceId !== initialGrant.deviceId || finalGrant.revision !== initialGrant.revision) fail();
            const readCapabilities = [
              "workspace.shell.read",
              "workspace.dashboard.read",
              "workspace.inbox.read",
            ] as const;
            const capabilities = role === "viewer"
              ? Object.freeze(readCapabilities)
              : Object.freeze([...readCapabilities, "workspace.inbox.state.write"] as const);
            return Object.freeze({
              v: 1 as const,
              kind: "sps.native.workspace.bootstrap" as const,
              workspace: Object.freeze({ id: row.id, name: row.name, issuePrefix: row.issuePrefix }),
              member: Object.freeze({ userId }),
              capabilities,
            });
          }
          const surfaces = spsWorkspaceSurfaceService(tx as unknown as Db);
          let value: ReadResult;
          if (operation.kind === "inbox-state") {
            const role = await membershipRole();
            if (role !== "member" && role !== "admin") fail();
            const state = await surfaces.setInboxUserState({
              companyId: operation.workspaceId,
              userId,
              itemId: operation.itemId,
              read: inboxState!.read,
              archived: inboxState!.archived,
            });
            const isoOrNull = (date: Date | null) => {
              if (date === null) return null;
              if (!(date instanceof Date) || !Number.isFinite(date.getTime())) fail();
              return date.toISOString();
            };
            value = Object.freeze({
              readAt: isoOrNull(state.readAt),
              archivedAt: isoOrNull(state.archivedAt),
            });
          } else if (operation.kind === "shell-providers") value = await surfaces.listShellProviders(operation.workspaceId);
          else if (operation.kind === "shell") value = await surfaces.getShell(operation.workspaceId);
          else if (operation.kind === "dashboard") {
            value = { widgets: await surfaces.listDashboard(operation.workspaceId, userId) };
          } else {
            value = { items: await surfaces.listInbox({
              companyId: operation.workspaceId,
              userId,
              includeArchived: operation.archived,
            }) };
          }
          assertCurrent(assertCurrentInput);
          await assertSession();
          const finalGrant = await authorizeDevice();
          if (finalGrant.deviceId !== initialGrant.deviceId || finalGrant.revision !== initialGrant.revision) fail();
          return value;
        });
        assertCurrent(assertCurrentInput);
        return result;
      } catch {
        throw new SpsNativeWorkspaceSurfaceError();
      }
    },
  });
}
