import { z } from "zod/v3";

export const createSpsModelConnectionSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().min(1).max(2_147_483_647)]).optional(),
  transport: z.object({
    endpoint: z.string().min(1).max(2_048),
    model: z.string().min(1).max(160),
    allowLoopbackHttp: z.boolean().optional(),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    maxOutputTokens: z.number().int().min(1).max(32_768).optional(),
    maxRequestBytes: z.number().int().min(256).max(1_048_576).optional(),
    maxResponseBytes: z.number().int().min(256).max(4_194_304).optional(),
    maxConcurrentRequests: z.number().int().min(1).max(16).optional(),
  }).strict(),
}).strict();

export const updateSpsModelConnectionStatusSchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();
export const grantSpsModelConnectionSchema = z.object({ pluginId: z.string().uuid() }).strict();
export type CreateSpsModelConnection = z.infer<typeof createSpsModelConnectionSchema>;
