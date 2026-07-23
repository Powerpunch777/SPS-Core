import { timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";

export const SPS_DESKTOP_ACCESS_HEADER = "x-sps-desktop-access";
export const SPS_DESKTOP_ACCESS_TOKEN_ENV = "SPS_DESKTOP_ACCESS_TOKEN";

function requestHostname(req: Request): string {
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = req.header("host")?.trim();
  const raw = forwardedHost || hostHeader || "";
  if (!raw) return "";
  try {
    return new URL(`http://${raw}`).hostname.trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function tokenMatches(value: string | undefined, expected: string): boolean {
  if (!value) return false;
  const candidate = Buffer.from(value, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return candidate.length === expectedBuffer.length && timingSafeEqual(candidate, expectedBuffer);
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
export function desktopLocalAccessGuard({ token = process.env[SPS_DESKTOP_ACCESS_TOKEN_ENV]?.trim() } = {}): RequestHandler {
  if (!token) return (_req, _res, next) => next();

  return (req, res, next) => {
    const hostname = requestHostname(req);
    // The Owner Host manager probes health before Electron loads the Workspace.
    // Health contains no user data and must remain available for lifecycle checks.
    if (req.path === "/api/health" || !isLoopbackHostname(hostname)) {
      next();
      return;
    }
    if (tokenMatches(req.header(SPS_DESKTOP_ACCESS_HEADER) ?? undefined, token)) {
      next();
      return;
    }
    sendDesktopOnlyResponse(req, res);
  };
}
