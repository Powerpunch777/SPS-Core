import type { Request } from "express";

const TAILSCALE_USER_LOGIN_HEADER = "tailscale-user-login";

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

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = address?.trim().toLowerCase() ?? "";
  return normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized === "::ffff:127.0.0.1";
}

function trustedTailscaleForwardedHostname(req: Request, directHostname: string): string | null {
  if (!isLoopbackHostname(directHostname) || !isLoopbackAddress(req.socket?.remoteAddress)) return null;

  // Tailscale Serve removes caller-supplied identity headers before adding its
  // own. Requiring that proof prevents a bare X-Forwarded-Host header from
  // turning a direct loopback browser request into a private team request.
  const userLogin = req.header(TAILSCALE_USER_LOGIN_HEADER)?.trim() ?? "";
  if (!userLogin || userLogin.length > 320 || /[\r\n\0]/.test(userLogin)) return null;

  const forwardedHeader = req.header("x-forwarded-host")?.trim() ?? "";
  if (!forwardedHeader || forwardedHeader.includes(",")) return null;
  const forwardedHostname = parseHostname(forwardedHeader);
  return forwardedHostname.endsWith(".ts.net") ? forwardedHostname : null;
}

export function requestHostname(req: Request): string {
  const directHostname = parseHostname(req.header("host") ?? undefined);
  return trustedTailscaleForwardedHostname(req, directHostname) ?? directHostname;
}
