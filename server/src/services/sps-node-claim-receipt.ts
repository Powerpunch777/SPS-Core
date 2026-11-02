import { badRequest, conflict } from "../errors.js";
import { SPS_NODE_CLAIM_REQUEST_ID_PATTERN } from "../compat/paperclip/shared.js";

export const SPS_NODE_CLAIM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// Encoding the creation time in the opaque ID prevents an expired request from
// becoming a new claim after its bounded-lifetime receipt has been removed.
const REQUEST_ID = new RegExp(SPS_NODE_CLAIM_REQUEST_ID_PATTERN);

export type SpsNodeClaimKind = "agent-command" | "plugin-run";

export function parseSpsNodeClaimRequestId(value: unknown, now = Date.now()) {
  if (typeof value !== "string") throw badRequest("SPS Node claim request id is invalid.");
  const match = REQUEST_ID.exec(value);
  if (!match) throw badRequest("SPS Node claim request id is invalid.");
  const createdAt = Number(match[1]);
  if (createdAt > now + MAX_CLOCK_SKEW_MS) throw badRequest("SPS Node claim request time is outside the allowed clock-skew window.");
  if (now >= createdAt + SPS_NODE_CLAIM_MAX_AGE_MS) {
    throw conflict("SPS Node claim recovery has expired; execution remains unconfirmed.", { code: "sps_node_claim_expired" });
  }
  return { requestId: value, expiresAt: new Date(createdAt + SPS_NODE_CLAIM_MAX_AGE_MS) };
}

export function spsNodeClaimResponse(requestId: string, kind: SpsNodeClaimKind, work: unknown) {
  return { status: 200, data: { schemaVersion: 1, claimRequestId: requestId, kind, work } } as const;
}
