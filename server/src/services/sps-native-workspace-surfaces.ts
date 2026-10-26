import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../compat/paperclip/db.js";
import type { createSpsIdentityAuth } from "../auth/sps-identity.js";
import { spsMemberDeviceService } from "./sps-member-devices.js";
import { spsWorkspaceSurfaceService } from "./sps-workspace-surfaces.js";
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
  | Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["listShellProviders"]>>
  | Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["getShell"]>>
  | { widgets: Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["listDashboard"]>> }
  | { items: Awaited<ReturnType<ReturnType<typeof spsWorkspaceSurfaceService>["listInbox"]>> };

type Options = {
  db: Db;
  identity: Identity;
  hostId: string;
  verifier: Verifier;
  assertCurrent: () => void;
};

type SurfaceOperation =
  | { workspaceId: string; kind: "shell-providers" }
  | { workspaceId: string; kind: "shell" }
  | { workspaceId: string; kind: "dashboard" }
  | { workspaceId: string; kind: "inbox"; archived: boolean };

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

function matchTarget(target: string): SurfaceOperation {
  const shellProviders = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-shell\/providers$/.exec(target);
  if (shellProviders) return { workspaceId: shellProviders[1]!, kind: "shell-providers" };
  const shell = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-shell$/.exec(target);
  if (shell) return { workspaceId: shell[1]!, kind: "shell" };
  const dashboard = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-dashboard$/.exec(target);
  if (dashboard) return { workspaceId: dashboard[1]!, kind: "dashboard" };
  const inbox = /^\/api\/companies\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\/workspace-inbox(?:\?archived=(true|false))?$/.exec(target);
  if (inbox) return { workspaceId: inbox[1]!, kind: "inbox", archived: inbox[2] === "true" };
  return fail();
}

/**
 * Core-side read-only Native Workspace surface consumer. It has no listener or
 * Express integration; the private HTTP composition owns request framing.
 */
export function createSpsNativeWorkspaceSurfaceReader({ db, identity, hostId, verifier, assertCurrent: assertCurrentInput }: Options) {
  if (!db || !identity || typeof identity.resolveNativeEnrollmentSessionFromHeaders !== "function"
    || !UUID.test(hostId) || !verifier || typeof verifier.verify !== "function"
    || typeof assertCurrentInput !== "function") throw new TypeError("Invalid Native Workspace surface reader configuration.");
  const devices = spsMemberDeviceService(db, hostId);

  return Object.freeze({
    async read(header: string, actual: SpsNativeWorkspaceProofActualRequest): Promise<ReadResult> {
      try {
        assertCurrent(assertCurrentInput);
        const proof = verifier.verify(header, actual);
        const operation = matchTarget(proof.target);
        if (proof.hostId !== hostId || proof.method !== "GET" || actual.method !== "GET"
          || actual.body.length !== 0 || actual.contentType !== ""
          || operation.workspaceId !== proof.workspaceId) fail();
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

          await assertSession();
          const initialGrant = await authorizeDevice();
          const surfaces = spsWorkspaceSurfaceService(tx as unknown as Db);
          let value: ReadResult;
          if (operation.kind === "shell-providers") value = await surfaces.listShellProviders(operation.workspaceId);
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
