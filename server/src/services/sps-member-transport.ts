import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { TLSSocket } from "node:tls";

export type SpsMemberTransportGrant = {
  deviceId: string;
  hostId: string;
  userId: string;
  companyId: string;
  revision: number;
  certificateSha256: string;
  certificateNotAfter: Date;
};

type Authorize = (input: { companyId: string; userId: string; certificateSha256: string }) => Promise<SpsMemberTransportGrant>;
type Scope = { companyId: string; userId: string };
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export class SpsMemberTransportError extends Error {
  readonly status = 403;
  readonly code = "member_device_authentication_required";
  constructor() { super("A currently approved SPS Member device is required."); }
}

function peerCertificate(socket: IncomingMessage["socket"]) {
  if (!(socket instanceof TLSSocket) || socket.destroyed || !socket.encrypted || !socket.authorized
    || socket.getProtocol() !== "TLSv1.3") {
    throw new SpsMemberTransportError();
  }
  try {
    const certificate = socket.getPeerX509Certificate();
    if (!certificate || certificate.ca
      || !certificate.keyUsage?.includes("1.3.6.1.5.5.7.3.2")
      || certificate.keyUsage.includes("1.3.6.1.5.5.7.3.1")
      || !Number.isFinite(Date.parse(certificate.validFrom))
      || Date.parse(certificate.validFrom) > Date.now()
      || !Number.isFinite(Date.parse(certificate.validTo))
      || Date.parse(certificate.validTo) <= Date.now()) throw new SpsMemberTransportError();
    return { socket, certificateSha256: createHash("sha256").update(certificate.raw).digest("hex") };
  } catch { throw new SpsMemberTransportError(); }
}

/** Internal Core boundary. Neither request headers nor a body-supplied device ID is proof. */
export function createSpsMemberTransport(hostId: string, authorizeCurrent: Authorize) {
  if (!uuid.test(hostId) || typeof authorizeCurrent !== "function") throw new TypeError("Invalid SPS Member transport configuration");
  const connections = new Map<TLSSocket, Map<string, SpsMemberTransportGrant>>();
  let generation = 0n;
  let disposed = false;

  function closeWhere(predicate: (grant: SpsMemberTransportGrant) => boolean) {
    generation++;
    for (const [socket, grants] of connections) {
      if ([...grants.values()].some(predicate)) {
        connections.delete(socket);
        socket.destroy();
      }
    }
  }

  return {
    async authorize(req: IncomingMessage, scope: Scope): Promise<SpsMemberTransportGrant> {
      if (disposed || !scope || !uuid.test(scope.companyId) || typeof scope.userId !== "string"
        || !scope.userId || scope.userId.length > 200 || /[\u0000-\u001f\u007f]/.test(scope.userId)) {
        throw new SpsMemberTransportError();
      }
      const before = generation;
      const peer = peerCertificate(req.socket);
      let grant: SpsMemberTransportGrant;
      try {
        grant = await authorizeCurrent({ ...scope, certificateSha256: peer.certificateSha256 });
      } catch { throw new SpsMemberTransportError(); }
      if (disposed || before !== generation || !grant || !uuid.test(grant.deviceId)
        || grant.hostId !== hostId || grant.userId !== scope.userId || grant.companyId !== scope.companyId
        || grant.certificateSha256 !== peer.certificateSha256 || !Number.isSafeInteger(grant.revision) || grant.revision < 1
        || !(grant.certificateNotAfter instanceof Date) || !Number.isFinite(grant.certificateNotAfter.getTime())
        || grant.certificateNotAfter.getTime() <= Date.now()
        || peerCertificate(req.socket).certificateSha256 !== peer.certificateSha256) {
        throw new SpsMemberTransportError();
      }
      let scopes = connections.get(peer.socket);
      if (!scopes) {
        scopes = new Map();
        connections.set(peer.socket, scopes);
        peer.socket.once("close", () => connections.delete(peer.socket));
      }
      const key = `${grant.deviceId}:${grant.companyId}`;
      if (!scopes.has(key) && scopes.size >= 64) {
        peer.socket.destroy();
        throw new SpsMemberTransportError();
      }
      const safe = Object.freeze({
        deviceId: grant.deviceId, hostId, userId: scope.userId, companyId: scope.companyId,
        revision: grant.revision, certificateSha256: peer.certificateSha256,
        certificateNotAfter: new Date(grant.certificateNotAfter),
      });
      scopes.set(key, safe);
      return safe;
    },
    revokeDevice(deviceId: string) { closeWhere(grant => grant.deviceId === deviceId); },
    revokeWorkspaceUser(companyId: string, userId: string) {
      closeWhere(grant => grant.companyId === companyId && grant.userId === userId);
    },
    dispose() {
      disposed = true;
      generation++;
      for (const socket of connections.keys()) socket.destroy();
      connections.clear();
    },
  };
}
