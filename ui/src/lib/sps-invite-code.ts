const LEGACY_INVITE_TOKEN_PREFIX = "pcp_invite_";
const SPS_INVITE_TOKEN_PREFIX = "sps_invite_";
const INVITE_SUFFIX_PATTERN = /^[a-z0-9]{8}(?:[a-z0-9]{8})?$/;
const INVITE_CODE_INPUT_PATTERN = /^(?:[a-z0-9]{8}|[a-z0-9]{16}|[a-z0-9]{4}(?:[\s_-][a-z0-9]{4}){1,3})$/i;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function inviteSuffixFromToken(token: string): string | null {
  const normalized = token.trim().toLowerCase();
  const prefix = normalized.startsWith(SPS_INVITE_TOKEN_PREFIX)
    ? SPS_INVITE_TOKEN_PREFIX
    : normalized.startsWith(LEGACY_INVITE_TOKEN_PREFIX)
      ? LEGACY_INVITE_TOKEN_PREFIX
      : null;
  if (!prefix) return null;

  const suffix = normalized.slice(prefix.length);
  return INVITE_SUFFIX_PATTERN.test(suffix) ? suffix : null;
}

export function inviteTokenToSpsCode(token: string): string | null {
  const suffix = inviteSuffixFromToken(token);
  if (!suffix) return null;
  return `SPS-${suffix.match(/.{1,4}/g)!.map((part) => part.toUpperCase()).join("-")}`;
}

export function spsCodeToInviteToken(input: string): string | null {
  const trimmed = input.trim();
  const withoutPrefix = trimmed.replace(/^sps[\s_-]*/i, "");
  if (!INVITE_CODE_INPUT_PATTERN.test(withoutPrefix)) return null;
  const suffix = withoutPrefix.replace(/[\s_-]/g, "").toLowerCase();
  if (!INVITE_SUFFIX_PATTERN.test(suffix)) return null;
  return `${SPS_INVITE_TOKEN_PREFIX}${suffix}`;
}

export function buildSpsDesktopJoinUri(inviteUrl: string, token: string): string | null {
  const code = inviteTokenToSpsCode(token);
  if (!code) return null;

  try {
    const hub = new URL(inviteUrl).origin;
    const params = new URLSearchParams({ hub, code });
    return `sps://join?${params.toString()}`;
  } catch {
    return null;
  }
}

export function buildSpsInviteUrl(hubInput: string, token: string): string | null {
  const normalizedHub = hubInput.trim();
  if (!normalizedHub) return null;

  try {
    const source = /^[a-z][a-z\d+.-]*:\/\//i.test(normalizedHub)
      ? normalizedHub
      : `https://${normalizedHub}`;
    const hub = new URL(source);
    if (hub.protocol !== "http:" && hub.protocol !== "https:") return null;
    if (hub.protocol === "http:" && !isLoopbackHost(hub.hostname)) return null;
    hub.pathname = `/invite/${encodeURIComponent(token)}`;
    hub.search = "";
    hub.hash = "";
    return hub.toString();
  } catch {
    return null;
  }
}
