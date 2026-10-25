export type SpsMemberDeviceStatus = "pending" | "approved" | "revoked";

export interface SpsMemberDevice {
  id: string;
  hostId: string;
  ownerUserId: string;
  displayName: string;
  certificateSha256: string;
  spkiSha256: string;
  status: SpsMemberDeviceStatus;
  revision: number;
  certificateNotBefore: string;
  certificateNotAfter: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SpsMemberDeviceEvent {
  id: string;
  hostId: string;
  deviceId: string | null;
  deviceSnapshotId: string;
  ownerUserId: string;
  actorUserId: string;
  action: "request" | "approved" | "revoked";
  revision: number;
  createdAt: string;
}
