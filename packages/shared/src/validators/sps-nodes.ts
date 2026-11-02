import { z } from "zod/v3";

// This is the public, capability-only contract between the Hub and SPS
// Desktop. Keep it shared so the Node management screen cannot offer a grant
// that the Hub will later reject at dispatch time.
export const SPS_NODE_CAPABILITY_BY_ADAPTER = {
  claude_local: "claude_cli",
  codex_local: "codex_cli",
  sps_agy_local: "agy_cli",
  gemini_local: "gemini_cli",
  opencode_local: "opencode_cli",
  pi_local: "pi_cli",
  sps_ollama_local: "ollama",
  sps_lm_studio_local: "lm_studio",
} as const;

export function spsNodeCapabilityForAdapter(adapterType: string): string | null {
  return SPS_NODE_CAPABILITY_BY_ADAPTER[adapterType as keyof typeof SPS_NODE_CAPABILITY_BY_ADAPTER] ?? null;
}

export function spsNodeSupportsAdapter(
  capabilities: ReadonlyArray<{ kind: string }>,
  adapterType: string,
): boolean {
  const capabilityKind = spsNodeCapabilityForAdapter(adapterType);
  return capabilityKind !== null && capabilities.some((capability) => capability.kind === capabilityKind);
}

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

export const spsNodeRunnerAvailabilityStatusSchema = z.enum([
  "available",
  "busy",
  "quota_limited",
  "auth_required",
  "offline",
  "unknown",
]);

export const spsNodeRunnerCredentialStatusSchema = z.enum(["ready", "auth_required", "unknown"]);
export const spsNodeRunnerAvailabilitySourceSchema = z.enum(["node_probe", "adapter", "manual"]);

// These are the Node-local runtimes SPS Desktop may execute directly. Other
// advertised capability kinds remain useful metadata, but cannot be treated
// as an arbitrary shell command by a plugin execution request.
export const spsNodeExecutableRuntimeKindSchema = z.enum([
  "claude_cli",
  "codex_cli",
  "agy_cli",
  "gemini_cli",
  "opencode_cli",
  "pi_cli",
  "ollama",
  "lm_studio",
]);

// These fields are intentionally operational summaries only. The Hub must
// never receive a CLI token, API key, cookie, home directory, or account ID.
export const spsNodeRunnerAvailabilitySchema = z.object({
  status: spsNodeRunnerAvailabilityStatusSchema,
  observedAt: z.string().datetime({ offset: true }),
  source: spsNodeRunnerAvailabilitySourceSchema,
  confidence: z.number().int().min(0).max(100).optional().nullable(),
  retryAfter: z.string().datetime({ offset: true }).optional().nullable(),
  detail: z.string().trim().min(1).max(500).optional().nullable(),
});

export const spsNodeRunnerProfileSchema = spsNodeCapabilitySchema.extend({
  runnerKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
  profileLabel: z.string().trim().min(1).max(120).optional().nullable(),
  credentialStatus: spsNodeRunnerCredentialStatusSchema.optional(),
  availability: spsNodeRunnerAvailabilitySchema.optional(),
});

const uniqueRunnerKeys = (profiles: ReadonlyArray<{ runnerKey: string }>) =>
  new Set(profiles.map((profile) => profile.runnerKey)).size === profiles.length;

export const createSpsNodeSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  publicKey: z.string().trim().min(32).max(8192),
  transportPublicKey: z.string().trim().min(64).max(8192).optional().nullable(),
  platform: z.string().trim().min(1).max(120),
  appVersion: z.string().trim().max(120).optional().nullable(),
  capabilities: z.array(spsNodeCapabilitySchema).max(32).default([]),
  runners: z.array(spsNodeRunnerProfileSchema).max(64).optional(),
}).superRefine((value, context) => {
  if (value.runners && !uniqueRunnerKeys(value.runners)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runners"], message: "Runner keys must be unique per Node" });
  }
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

export const SPS_NODE_CLAIM_REQUEST_ID_PATTERN = "^v1:([1-9][0-9]{12}):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
export const spsNodeClaimRequestSchema = spsNodeSignedRequestSchema.extend({
  claimRequestId: z.string().max(80).regex(new RegExp(SPS_NODE_CLAIM_REQUEST_ID_PATTERN)).optional(),
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

const spsNodeUsageTokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const spsNodeUsageReportSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("claude_model_usage_v1"),
  inputTokens: spsNodeUsageTokenCountSchema.nullable(),
  cachedInputTokens: spsNodeUsageTokenCountSchema.nullable(),
  outputTokens: spsNodeUsageTokenCountSchema.nullable(),
}).strict().refine(
  (report) => report.inputTokens !== null || report.cachedInputTokens !== null || report.outputTokens !== null,
  { message: "At least one token count must be reported" },
);

export const spsPluginNodeRunCompleteSchema = spsNodeCommandCompleteSchema.extend({
  usageReport: spsNodeUsageReportSchema.optional(),
});

export const reportSpsNodeRunnerAvailabilitySchema = z.object({
  runners: z.array(z.object({
    runnerKey: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/),
    credentialStatus: spsNodeRunnerCredentialStatusSchema.optional(),
    availability: spsNodeRunnerAvailabilitySchema,
  })).min(1).max(64),
}).superRefine((value, context) => {
  if (!uniqueRunnerKeys(value.runners)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["runners"], message: "Runner keys must be unique per Node" });
  }
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
export type SpsNodeRunnerAvailabilityStatus = z.infer<typeof spsNodeRunnerAvailabilityStatusSchema>;
export type SpsNodeRunnerCredentialStatus = z.infer<typeof spsNodeRunnerCredentialStatusSchema>;
export type SpsNodeRunnerAvailabilitySource = z.infer<typeof spsNodeRunnerAvailabilitySourceSchema>;
export type SpsNodeExecutableRuntimeKind = z.infer<typeof spsNodeExecutableRuntimeKindSchema>;
export type SpsNodeRunnerAvailability = z.infer<typeof spsNodeRunnerAvailabilitySchema>;
export type SpsNodeRunnerProfile = z.infer<typeof spsNodeRunnerProfileSchema>;
export type CreateSpsNode = z.infer<typeof createSpsNodeSchema>;
export type UpdateSpsNodeStatus = z.infer<typeof updateSpsNodeStatusSchema>;
export type BindSpsAgentNode = z.infer<typeof bindSpsAgentNodeSchema>;
export type SpsNodeHeartbeat = z.infer<typeof spsNodeHeartbeatSchema>;
export type SpsNodeSignedRequest = z.infer<typeof spsNodeSignedRequestSchema>;
export type SpsNodeCommandEvent = z.infer<typeof spsNodeCommandEventSchema>;
export type SpsNodeCommandComplete = z.infer<typeof spsNodeCommandCompleteSchema>;
export type SpsNodeUsageReport = z.infer<typeof spsNodeUsageReportSchema>;
export type SpsPluginNodeRunComplete = z.infer<typeof spsPluginNodeRunCompleteSchema>;
export type ReportSpsNodeRunnerAvailability = z.infer<typeof reportSpsNodeRunnerAvailabilitySchema>;
