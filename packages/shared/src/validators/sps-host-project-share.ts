import { z } from "zod";

// The Core routes only opaque, Node-encrypted credential envelopes. The
// plaintext Windows account and password remain exclusively on the Owner Host
// and the approved Member Node.
export const upsertSpsHostProjectShareSchema = z.object({
  sharePath: z.string().trim().min(5).max(1024),
});

export const grantSpsHostProjectShareNodeSchema = z.object({
  credentialAlgorithm: z.enum(["rsa-oaep-sha256", "rsa-oaep-sha256+a256gcm"]),
  credentialEnvelope: z.string().trim().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(128).max(32_768),
});

export type UpsertSpsHostProjectShare = z.infer<typeof upsertSpsHostProjectShareSchema>;
export type GrantSpsHostProjectShareNode = z.infer<typeof grantSpsHostProjectShareNodeSchema>;
