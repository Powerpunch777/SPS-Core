import { z } from "zod/v3";

/**
 * Stable, product-neutral vocabulary for agent platforms.
 *
 * The current core can continue to use domain-specific storage names internally
 * (for example, issues and agent task sessions). Plugins and future core modules
 * should exchange this contract instead of assuming a particular workplane.
 */
export const AGENT_PLATFORM_CONTRACT_VERSION = "1.0";

export const agentPlatformScopeSchema = z.object({
  organizationId: z.string().min(1),
  projectId: z.string().min(1).nullable().optional(),
  workItemId: z.string().min(1).nullable().optional(),
  threadId: z.string().min(1).nullable().optional(),
  agentId: z.string().min(1).nullable().optional(),
  artifactId: z.string().min(1).nullable().optional(),
});

export type AgentPlatformScope = z.infer<typeof agentPlatformScopeSchema>;

export const agentPlatformThreadStatusSchema = z.enum(["active", "closed", "archived"]);
export type AgentPlatformThreadStatus = z.infer<typeof agentPlatformThreadStatusSchema>;

export const agentPlatformRunStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "timed_out",
]);
export type AgentPlatformRunStatus = z.infer<typeof agentPlatformRunStatusSchema>;

export const agentPlatformBackendKindSchema = z.enum([
  "adapter",
  "node",
  "sandbox",
  "remote_service",
]);
export type AgentPlatformBackendKind = z.infer<typeof agentPlatformBackendKindSchema>;

export const agentPlatformWorkItemStatusSchema = z.enum([
  "open",
  "active",
  "blocked",
  "in_review",
  "completed",
  "cancelled",
]);
export type AgentPlatformWorkItemStatus = z.infer<typeof agentPlatformWorkItemStatusSchema>;

export const agentPlatformStoreKindSchema = z.enum([
  "memory",
  "state",
  "artifact",
  "external",
]);
export type AgentPlatformStoreKind = z.infer<typeof agentPlatformStoreKindSchema>;

export const agentPlatformStoreHealthSchema = z.enum(["unknown", "ready", "degraded", "unavailable"]);
export type AgentPlatformStoreHealth = z.infer<typeof agentPlatformStoreHealthSchema>;

export const agentPlatformExtensionKindSchema = z.enum([
  "workplane",
  "store_provider",
  "backend_provider",
  "surface",
  // A tool provider can assist an Agent without selecting a work model,
  // storage strategy, backend, or UI surface for the Company.
  "tool_provider",
]);
export type AgentPlatformExtensionKind = z.infer<typeof agentPlatformExtensionKindSchema>;

export const agentPlatformThreadSchema = z.object({
  id: z.string().min(1),
  scope: agentPlatformScopeSchema,
  agentId: z.string().min(1),
  status: agentPlatformThreadStatusSchema,
  backendId: z.string().min(1).nullable(),
  lastRunId: z.string().min(1).nullable(),
  lastError: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentPlatformThread = z.infer<typeof agentPlatformThreadSchema>;

export const agentPlatformRunSchema = z.object({
  id: z.string().min(1),
  scope: agentPlatformScopeSchema,
  threadId: z.string().min(1).nullable(),
  agentId: z.string().min(1),
  backendId: z.string().min(1).nullable(),
  status: agentPlatformRunStatusSchema,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type AgentPlatformRun = z.infer<typeof agentPlatformRunSchema>;

export const agentPlatformBackendSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  kind: agentPlatformBackendKindSchema,
  displayName: z.string().min(1),
  status: z.enum(["configured", "ready", "offline", "degraded", "disabled"]),
  capabilities: z.array(z.string().min(1)),
});
export type AgentPlatformBackend = z.infer<typeof agentPlatformBackendSchema>;

export const agentPlatformWorkItemSchema = z.object({
  id: z.string().min(1),
  scope: agentPlatformScopeSchema,
  title: z.string().min(1),
  status: agentPlatformWorkItemStatusSchema,
  assigneeAgentId: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AgentPlatformWorkItem = z.infer<typeof agentPlatformWorkItemSchema>;

export const agentPlatformStoreSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  kind: agentPlatformStoreKindSchema,
  displayName: z.string().min(1),
  health: agentPlatformStoreHealthSchema,
  capabilities: z.array(z.string().min(1)),
  supportedScopes: z.array(z.enum(["organization", "project", "agent", "thread", "work_item", "artifact", "user"])),
});
export type AgentPlatformStore = z.infer<typeof agentPlatformStoreSchema>;

export const agentPlatformExtensionSchema = z.object({
  id: z.string().min(1),
  contractVersion: z.string().min(1),
  kind: agentPlatformExtensionKindSchema,
  displayName: z.string().min(1),
});
export type AgentPlatformExtension = z.infer<typeof agentPlatformExtensionSchema>;

/**
 * Keeps optional scope keys deterministic at extension boundaries. This avoids
 * treating undefined and null as different memory or execution scopes.
 */
export function normalizeAgentPlatformScope(scope: AgentPlatformScope): AgentPlatformScope {
  return {
    organizationId: scope.organizationId,
    projectId: scope.projectId ?? null,
    workItemId: scope.workItemId ?? null,
    threadId: scope.threadId ?? null,
    agentId: scope.agentId ?? null,
    artifactId: scope.artifactId ?? null,
  };
}

/**
 * Contract versions are additive within a major version. A provider declaring
 * 1.x can participate in a 1.y core without claiming compatibility with v2.
 */
export function isAgentPlatformContractCompatible(version: string): boolean {
  const major = version.trim().split(".", 1)[0];
  return major === AGENT_PLATFORM_CONTRACT_VERSION.split(".", 1)[0];
}
