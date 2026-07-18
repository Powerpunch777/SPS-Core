import { z } from "zod";

export const spsNodeCapabilitySchema = z.object({
  kind: z.enum([
    "claude_cli",
    "codex_cli",
    "agy_cli",
    "gemini_cli",
    "opencode_cli",
    "pi_cli",
    "ollama",
    "lm_studio",
    "specialist_api",
    "custom",
  ]),
  label: z.string().trim().min(1).max(120),
  version: z.string().trim().max(120).optional().nullable(),
  models: z.array(z.string().trim().min(1).max(160)).max(100).optional(),
});

export const createSpsNodeSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  publicKey: z.string().trim().min(32).max(8192),
  platform: z.string().trim().min(1).max(120),
  appVersion: z.string().trim().max(120).optional().nullable(),
  capabilities: z.array(spsNodeCapabilitySchema).max(32).default([]),
});

export const updateSpsNodeStatusSchema = z.object({
  status: z.enum(["active", "revoked"]),
});

export const bindSpsAgentNodeSchema = z.object({
  nodeId: z.string().uuid(),
});

export const spsNodeHeartbeatSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(64).max(2048),
});

export function spsNodeHeartbeatMessage(input: { nodeId: string; timestamp: string; nonce: string }) {
  return `SPS-NODE-HEARTBEAT-V1\n${input.nodeId}\n${input.timestamp}\n${input.nonce}`;
}

export const spsNodeSignedRequestSchema = z.object({
  timestamp: z.string().datetime({ offset: true }),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(64).max(2048),
});

export const spsNodeCommandEventSchema = z.object({
  sequence: z.number().int().positive(),
  stream: z.enum(["stdout", "stderr"]),
  body: z.string().min(1).max(64 * 1024),
});

export const spsNodeCommandCompleteSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  exitCode: z.number().int().nullable(),
  signal: z.string().trim().max(120).nullable().optional(),
  timedOut: z.boolean().default(false),
  error: z.string().trim().max(16_000).nullable().optional(),
});

export function spsNodeSignedRequestMessage(input: {
  nodeId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
}) {
  return [
    "SPS-NODE-REQUEST-V1",
    input.nodeId,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    input.bodySha256,
  ].join("\n");
}

export type SpsNodeCapability = z.infer<typeof spsNodeCapabilitySchema>;
export type CreateSpsNode = z.infer<typeof createSpsNodeSchema>;
export type UpdateSpsNodeStatus = z.infer<typeof updateSpsNodeStatusSchema>;
export type BindSpsAgentNode = z.infer<typeof bindSpsAgentNodeSchema>;
export type SpsNodeHeartbeat = z.infer<typeof spsNodeHeartbeatSchema>;
export type SpsNodeSignedRequest = z.infer<typeof spsNodeSignedRequestSchema>;
export type SpsNodeCommandEvent = z.infer<typeof spsNodeCommandEventSchema>;
export type SpsNodeCommandComplete = z.infer<typeof spsNodeCommandCompleteSchema>;
