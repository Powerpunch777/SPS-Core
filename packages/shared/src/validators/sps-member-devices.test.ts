import { describe, expect, it } from "vitest";
import type { SpsMemberDevice, SpsMemberDeviceEvent } from "../types/sps-member-devices.js";
import {
  approveSpsMemberDeviceSchema,
  createSpsMemberDeviceRequestSchema,
  revokeSpsMemberDeviceSchema,
} from "./sps-member-devices.js";

const validRequest = {
  displayName: "  Work laptop  ",
  certificate: "AQ",
} as const;

describe("createSpsMemberDeviceRequestSchema", () => {
  it("trims display names and accepts canonical one-byte base64url", () => {
    expect(createSpsMemberDeviceRequestSchema.parse(validRequest)).toEqual({
      displayName: "Work laptop",
      certificate: "AQ",
    });
  });

  it("accepts the encoded 4096-byte maximum", () => {
    const certificate = `${"A".repeat(5_460)}AA`;
    expect(certificate).toHaveLength(5_462);
    expect(createSpsMemberDeviceRequestSchema.parse({ ...validRequest, certificate }).certificate).toBe(certificate);
  });

  it("accepts the URL-safe alphabet", () => {
    expect(createSpsMemberDeviceRequestSchema.parse({ ...validRequest, certificate: "-_8" }).certificate).toBe("-_8");
  });

  it.each([
    ["empty values", ""],
    ["padding", "AQ=="],
    ["the standard-base64 plus character", "AQ+"],
    ["the standard-base64 slash character", "AQ/"],
    ["invalid length remainder", "A"],
    ["noncanonical one-byte trailing bits", "AR"],
    ["noncanonical two-byte trailing bits", "AAB"],
    ["encoded values above 4096 bytes", "A".repeat(5_464)],
    ["values above the character prelimit", "A".repeat(5_463)],
  ])("rejects %s", (_description, certificate) => {
    expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, certificate })).toThrow();
  });

  it("rejects blank or overlong trimmed display names", () => {
    expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, displayName: " \t " })).toThrow();
    expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, displayName: "x".repeat(81) })).toThrow();
  });

  it.each(["\u0000", "\t", "\n", "\r", "\u001f", "\u007f"])(
    "rejects ASCII control character %j even at an edge",
    (control) => {
      expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, displayName: `${control}Laptop` })).toThrow();
      expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, displayName: `Lap${control}top` })).toThrow();
      expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, displayName: `Laptop${control}` })).toThrow();
    },
  );

  it.each(["hostId", "ownerUserId", "status", "revision", "nodeId", "privateKey", "privateKeyPem", "approvedByUserId"])(
    "rejects unexpected field %s",
    (field) => {
      expect(() => createSpsMemberDeviceRequestSchema.parse({ ...validRequest, [field]: "not allowed" })).toThrow();
    },
  );
});

describe("member-device action schemas", () => {
  it("accepts an empty action body, including an omitted body", () => {
    expect(approveSpsMemberDeviceSchema.parse({})).toEqual({});
    expect(approveSpsMemberDeviceSchema.parse(undefined)).toEqual({});
    expect(revokeSpsMemberDeviceSchema.parse({})).toEqual({});
    expect(revokeSpsMemberDeviceSchema.parse(undefined)).toEqual({});
  });

  it("rejects fields on approve and revoke requests", () => {
    expect(() => approveSpsMemberDeviceSchema.parse({ status: "approved" })).toThrow();
    expect(() => revokeSpsMemberDeviceSchema.parse({ nodeId: "node" })).toThrow();
  });
});

describe("member-device shared types", () => {
  it("keeps the DTO and public event snapshots typed as data-only contracts", () => {
    const device: SpsMemberDevice = {
      id: "device-id",
      hostId: "host-id",
      ownerUserId: "user-id",
      displayName: "Work laptop",
      certificateSha256: "certificate-digest",
      spkiSha256: "spki-digest",
      status: "pending",
      revision: 1,
      certificateNotBefore: "2026-01-01T00:00:00.000Z",
      certificateNotAfter: "2027-01-01T00:00:00.000Z",
      approvedAt: null,
      approvedByUserId: null,
      revokedAt: null,
      createdAt: "2026-10-25T00:00:00.000Z",
      updatedAt: "2026-10-25T00:00:00.000Z",
    };
    const event: SpsMemberDeviceEvent = {
      id: "event-id",
      hostId: "host-id",
      deviceId: null,
      deviceSnapshotId: "snapshot-id",
      ownerUserId: "user-id",
      actorUserId: "actor-id",
      action: "request",
      revision: 1,
      createdAt: "2026-10-25T00:00:00.000Z",
    };

    expect(device.status).toBe("pending");
    expect(event.deviceId).toBeNull();
  });
});
