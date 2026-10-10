import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import { isLoopbackHostname, requestHostIdentity } from "./request-hostname.js";

export const SPS_DESKTOP_ACCESS_HEADER = "x-sps-desktop-access";
// A second proof is intentionally required before an authenticated private
// Host may perform the narrow Owner-membership recovery flow. The normal
// Desktop access header only protects the local transport; it must not turn
// every Electron Workspace request into an implicit instance administrator.
export const SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER = "x-sps-desktop-owner-bootstrap";
export const SPS_DESKTOP_ACCESS_TOKEN_ENV = "SPS_DESKTOP_ACCESS_TOKEN";

function tokenMatches(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  const candidate = Buffer.from(value, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
}

function localAgentBearerToken(req: Request) {
  if (!req.path.startsWith("/api/")) return null;
  const match = req.header("authorization")?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

/**
 * True only for an SPS Desktop main-process request on the loopback Owner
 * Host. It grants local-implicit authority for one recovery operation: adding
 * the currently signed-in Owner account back to its private team. Both
 * per-launch headers must match, so a browser never gains this capability.
 */
export function hasTrustedDesktopOwnerBootstrap(
  req: Request,
  { token = process.env[SPS_DESKTOP_ACCESS_TOKEN_ENV]?.trim() } = {},
): boolean {
  const host = requestHostIdentity(req);
  if (
    !token
    || host.source !== "direct"
    || host.peer !== "loopback"
    || !isLoopbackHostname(host.hostname)
  ) return false;
  return (
    tokenMatches(req.header(SPS_DESKTOP_ACCESS_HEADER) ?? undefined, token)
    && tokenMatches(req.header(SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER) ?? undefined, token)
  );
}

function sendDesktopOnlyResponse(req: Request, res: Parameters<RequestHandler>[1]) {
  const error = "This local SPS Owner Host is available only through SPS Desktop.";
  if (req.path.startsWith("/api/")) {
    res.status(403).json({ error, code: "desktop_access_required" });
    return;
  }
  res.status(403).type("text/plain").send(error);
}

/**
 * Makes a local Owner Host app-only without changing its loopback transport.
 * Tailscale requests retain their hostname and use the authenticated team path;
 * only direct loopback requests need the per-launch Electron token.
 */
export function desktopLocalAccessGuard({
  token = process.env[SPS_DESKTOP_ACCESS_TOKEN_ENV]?.trim(),
  verifyAgentToken = verifyLocalAgentJwt,
} = {}): RequestHandler {
  if (!token) return (_req, _res, next) => next();

  return (req, res, next) => {
    const host = requestHostIdentity(req);
    // The Owner Host manager probes health before Electron loads the Workspace.
    // Health contains no user data and must remain available for lifecycle checks.
    const trustedPrivateTransport = host.source === "tailscale-serve"
      || (
        host.source === "direct"
        && host.peer === "remote"
        && !isLoopbackHostname(host.hostname)
      );
    if (req.path === "/api/health" || trustedPrivateTransport) {
      next();
      return;
    }
    if (tokenMatches(req.header(SPS_DESKTOP_ACCESS_HEADER) ?? undefined, token)) {
      next();
      return;
    }
    // Core-spawned Agent tools call the loopback API without exposing the
    // Desktop launch token to an ACP process. A valid short-lived local Agent
    // JWT may cross this transport gate; actor, run, company, and scope checks
    // still execute in the authentication and authorization middleware.
    const agentToken = localAgentBearerToken(req);
    if (agentToken && verifyAgentToken(agentToken)) {
      next();
      return;
    }
    sendDesktopOnlyResponse(req, res);
  };
}
