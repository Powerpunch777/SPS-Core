import type { Request } from "express";
import type { createSpsIdentityAuth, SpsIdentityNativeEnrollmentSession } from "../auth/sps-identity.js";
import { hasTrustedDesktopOwnerBootstrap } from "../middleware/desktop-local-access.js";
import { HttpError } from "../errors.js";
import { createSpsNativeParentSignerClient } from "./sps-native-parent-signer.js";

type Identity = Pick<ReturnType<typeof createSpsIdentityAuth>, "resolveNativeEnrollmentSessionFromHeaders">;
export type SpsNativeHostManagement = Readonly<{
  hostId: string;
  serverSpkiSha256: string;
  assertActive(): void;
  resolveHostSession(request: Request): Promise<SpsIdentityNativeEnrollmentSession>;
  dispose(): void;
}>;

function unavailable(): Error {
  return new HttpError(403, "SPS Native Host management is unavailable.");
}

/** Local management only. Public identity comes from the directly owned Main
 * channel, never an HTTP Host ID. This opens no Native listener or enrollment.
 */
export async function createSpsNativeHostManagement(
  identity: Identity, options: { ownerUserId: string }, channel: unknown = process,
): Promise<SpsNativeHostManagement> {
  if (!identity || typeof identity.resolveNativeEnrollmentSessionFromHeaders !== "function") throw unavailable();
  if (!options || typeof options.ownerUserId !== "string" || !options.ownerUserId.trim()
    || options.ownerUserId.length > 200 || /[\u0000-\u001f\u007f]/.test(options.ownerUserId)) throw unavailable();
  const ownerUserId = options.ownerUserId;
  const client = createSpsNativeParentSignerClient(channel);
  let disposed = false;
  const assertActive = () => {
    if (disposed || !client.isAvailable()) throw unavailable();
  };
  try {
    const binding = await client.inspect();
    assertActive();
    return Object.freeze({
      hostId: binding.hostId,
      serverSpkiSha256: binding.serverSpkiSha256,
      assertActive,
      async resolveHostSession(request: Request) {
        const checkRequest = () => {
          assertActive();
          if (!hasTrustedDesktopOwnerBootstrap(request) || request.actor.type !== "board"
            || request.actor.source !== "session" || !request.actor.userId
            || request.headers.authorization !== undefined) throw unavailable();
        };
        checkRequest();
        const cookies: string[] = [];
        for (let index = 0; index < request.rawHeaders.length; index += 2) {
          if (request.rawHeaders[index]?.toLowerCase() === "cookie") cookies.push(request.rawHeaders[index + 1] ?? "");
        }
        if (cookies.length !== 1 || cookies[0]!.length > 8192) throw unavailable();
        let session: SpsIdentityNativeEnrollmentSession;
        try { session = await identity.resolveNativeEnrollmentSessionFromHeaders(new Headers({ cookie: cookies[0]! })); }
        catch { throw unavailable(); }
        checkRequest();
        if (session.userId !== ownerUserId || session.userId !== request.actor.userId
          || typeof session.authorizeInTransaction !== "function") throw unavailable();
        return Object.freeze({
          userId: session.userId,
          async authorizeInTransaction(tx, expectedUserId) {
            checkRequest();
            if (expectedUserId !== session.userId) throw unavailable();
            await session.authorizeInTransaction(tx, expectedUserId);
            checkRequest();
          },
        });
      },
      dispose() { disposed = true; client.dispose(); },
    });
  } catch { disposed = true; client.dispose(); throw unavailable(); }
}
