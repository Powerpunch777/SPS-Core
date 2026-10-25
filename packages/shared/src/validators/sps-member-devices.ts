import { z } from "zod";

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const memberDeviceCertificateSchema = z.string().min(1).max(5_462).superRefine((value, context) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Certificate must be canonical unpadded base64url" });
    return;
  }

  const remainder = value.length % 4;
  if (remainder === 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Certificate must be canonical unpadded base64url" });
    return;
  }

  const finalSextet = BASE64URL_ALPHABET.indexOf(value[value.length - 1]!);
  if ((remainder === 2 && (finalSextet & 0b1111) !== 0)
    || (remainder === 3 && (finalSextet & 0b11) !== 0)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Certificate must use canonical base64url trailing bits" });
    return;
  }

  const decodedByteLength = Math.floor(value.length / 4) * 3 + (remainder === 2 ? 1 : remainder === 3 ? 2 : 0);
  if (decodedByteLength < 1 || decodedByteLength > 4_096) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Certificate must encode between 1 and 4096 bytes" });
  }
});

export const createSpsMemberDeviceRequestSchema = z.object({
  displayName: z.string()
    .regex(/^(?![\s\S]*[\u0000-\u001f\u007f])[\s\S]*$/, "Display name must not contain ASCII control characters")
    .trim()
    .min(1)
    .max(80),
  certificate: memberDeviceCertificateSchema,
}).strict();

export const approveSpsMemberDeviceSchema = z.object({}).strict().default({});
export const revokeSpsMemberDeviceSchema = z.object({}).strict().default({});

export type CreateSpsMemberDeviceRequest = z.infer<typeof createSpsMemberDeviceRequestSchema>;
export type ApproveSpsMemberDevice = z.infer<typeof approveSpsMemberDeviceSchema>;
export type RevokeSpsMemberDevice = z.infer<typeof revokeSpsMemberDeviceSchema>;
