import type { PluginSpsRuntimeConnection } from "../compat/paperclip/plugin-sdk.js";

const RECENT_HEARTBEAT_MS = 2 * 60 * 1000;

export function isSpsNodeHeartbeatRecent(lastSeenAt: Date | null, now = Date.now()): boolean {
  const observed = lastSeenAt?.getTime();
  if (!Number.isFinite(now) || observed === undefined || !Number.isFinite(observed)) return false;
  const age = now - observed;
  return age >= 0 && age <= RECENT_HEARTBEAT_MS;
}

/** A cached Host observation, never a socket probe, CLI login or grant check. */
export function describeSpsRuntimeConnection(node: {
  status: string;
  keyVerifiedAt: Date | null;
  lastSeenAt: Date | null;
}, now = Date.now()): PluginSpsRuntimeConnection {
  const observed = node.lastSeenAt?.getTime();
  const validObservation = Number.isFinite(now) && observed !== undefined && Number.isFinite(observed) && observed <= now;
  const verified = node.keyVerifiedAt?.getTime();
  const state = node.status !== "active" ? "inactive"
    : verified === undefined || !Number.isFinite(verified) ? "unverified"
    : !validObservation ? "unknown"
    : isSpsNodeHeartbeatRecent(node.lastSeenAt, now) ? "recently_seen" : "offline";
  return {
    executionOwner: "node",
    authorization: "execution_grant_required",
    state,
    observedAt: validObservation ? node.lastSeenAt!.toISOString() : null,
  };
}
