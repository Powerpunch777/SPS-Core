import { z } from "zod/v3";

const spsWorkspaceSourceNameSchema = z.string().trim().min(1).max(96);
const spsWorkspaceSourceSharePathSchema = z.string().trim().min(5).max(1024);

export const createSpsWorkspaceSourceSchema = z.object({
  displayName: spsWorkspaceSourceNameSchema,
});

export const updateSpsWorkspaceSourceSchema = z.object({
  displayName: spsWorkspaceSourceNameSchema.optional(),
  status: z.enum(["active", "paused"]).optional(),
  // This is a Host-managed network route, never the Host's local folder path.
  sharePath: spsWorkspaceSourceSharePathSchema.nullable().optional(),
}).refine((value) => value.displayName !== undefined || value.status !== undefined || value.sharePath !== undefined, {
  message: "Provide a Workspace Source display name, status, or route.",
});

export const grantSpsWorkspaceSourceNodeSchema = z.object({
  credentialAlgorithm: z.enum(["rsa-oaep-sha256", "rsa-oaep-sha256+a256gcm"]),
  credentialEnvelope: z.string().trim().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(128).max(32_768),
});

export type CreateSpsWorkspaceSource = z.infer<typeof createSpsWorkspaceSourceSchema>;
export type UpdateSpsWorkspaceSource = z.infer<typeof updateSpsWorkspaceSourceSchema>;
export type GrantSpsWorkspaceSourceNode = z.infer<typeof grantSpsWorkspaceSourceNodeSchema>;
