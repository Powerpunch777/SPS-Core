import type { Request } from "express";

const TAILSCALE_USER_LOGIN_HEADER = "tailscale-user-login";

export type RequestHostIdentity = {
  hostname: string;
  source: "direct" | "tailscale-serve";
  peer: "loopback" | "remote" | "unknown";
  identity: { userLogin: string } | null;
};

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseHostname(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  try {
    return new URL(`http://${value}`).hostname.trim().toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

function requestPeer(address: string | undefined): RequestHostIdentity["peer"] {
  const normalized = address?.trim().toLowerCase() ?? "";
  if (!normalized) return "unknown";
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1"
    ? "loopback"
    : "remote";
}

function trustedTailscaleForwardedHost(
  req: Request,
  directHostname: string,
  peer: RequestHostIdentity["peer"],
): RequestHostIdentity | null {
  if (!isLoopbackHostname(directHostname) || peer !== "loopback") return null;

  // Tailscale Serve removes caller-supplied identity headers before adding its
  // own. Requiring that proof prevents a bare X-Forwarded-Host header from
  // turning a direct loopback browser request into a private team request.
  const userLogin = req.header(TAILSCALE_USER_LOGIN_HEADER)?.trim() ?? "";
  if (!userLogin || userLogin.length > 320 || /[\r\n\0]/.test(userLogin)) return null;

  const forwardedHeader = req.header("x-forwarded-host")?.trim() ?? "";
  if (!forwardedHeader || forwardedHeader.includes(",")) return null;
  const forwardedHostname = parseHostname(forwardedHeader);
  if (!forwardedHostname.endsWith(".ts.net")) return null;
  return {
    hostname: forwardedHostname,
    source: "tailscale-serve",
    peer,
    identity: { userLogin },
  };
}

export function requestHostIdentity(req: Request): RequestHostIdentity {
  const hostname = parseHostname(req.header("host") ?? undefined);
  const peer = requestPeer(req.socket?.remoteAddress);
  return trustedTailscaleForwardedHost(req, hostname, peer) ?? {
    hostname,
    source: "direct",
    peer,
    identity: null,
  };
}

export function requestHostname(req: Request): string {
  return requestHostIdentity(req).hostname;
}
