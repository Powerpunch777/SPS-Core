import { isIP } from "node:net";
import type { Request } from "express";

const TAILSCALE_USER_LOGIN_HEADER = "tailscale-user-login";
const TAILSCALE_HEADERS_INFO_HEADER = "tailscale-headers-info";
const TAILSCALE_HEADERS_INFO_URL = "https://tailscale.com/s/serve-headers";

export type RequestHostIdentity = {
  hostname: string;
  source: "direct" | "tailscale-serve";
  peer: "loopback" | "remote" | "unknown";
  identity: { userLogin: string } | null;
};

function normalizeHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function parseHostname(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (!value) return "";
  try {
    return normalizeHostname(new URL(`http://${value}`).hostname);
  } catch {
    return normalizeHostname(value);
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
  if (peer !== "loopback" || !directHostname.endsWith(".ts.net")) return null;

  // Tailscale Serve connects to the backend over loopback, preserves the
  // incoming .ts.net Host, and replaces its forwarded and identity headers.
  // Validate that complete shape so a bare .ts.net Host remains a direct
  // request that still needs the Desktop launch token.
  const userLogin = req.header(TAILSCALE_USER_LOGIN_HEADER)?.trim() ?? "";
  if (!userLogin || userLogin.length > 320 || /[\r\n\0]/.test(userLogin)) return null;

  const forwardedHeader = req.header("x-forwarded-host")?.trim() ?? "";
  if (!forwardedHeader || forwardedHeader.includes(",")) return null;
  const forwardedHostname = parseHostname(forwardedHeader);
  if (forwardedHostname !== directHostname) return null;

  const forwardedProto = req.header("x-forwarded-proto")?.trim().toLowerCase() ?? "";
  if (forwardedProto !== "https") return null;

  const forwardedFor = req.header("x-forwarded-for")?.trim() ?? "";
  if (!forwardedFor || forwardedFor.includes(",") || isIP(forwardedFor) === 0) return null;

  const headersInfo = req.header(TAILSCALE_HEADERS_INFO_HEADER)?.trim() ?? "";
  if (headersInfo !== TAILSCALE_HEADERS_INFO_URL) return null;
  return {
    hostname: directHostname,
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
