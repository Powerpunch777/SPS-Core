import type { CreateSpsModelConnection } from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

/** Host-only model connection row returned by the SPS Core settings API. */
export type SpsModelConnection = {
  id: string;
  companyId: string;
  displayName: string;
  protocol: "responses_text_v1";
  endpoint: string;
  model: string;
  secretId: string | null;
  versionSelector: string;
  status: "active" | "disabled";
  allowLoopbackHttp: boolean;
  timeoutMs: number;
  maxOutputTokens: number;
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrentRequests: number;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

/** Host-only grant row returned by the SPS Core settings API. */
export type SpsModelGrant = {
  id: string;
  companyId: string;
  pluginId: string;
  connectionId: string;
  bindingId: string | null;
  revision: number;
  status: "active" | "revoked";
  revokedAt: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type SpsModelConnectionStatus = SpsModelConnection["status"];
export type SpsModelConnectionListOptions = RequestOptions;

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function uuidPathSegment(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return encodeURIComponent(value);
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value;
}

function companyConnectionsPath(companyId: string): string {
  return `/companies/${uuidPathSegment(companyId, "companyId")}/sps-model-connections`;
}

export const spsModelConnectionsApi = {
  list(companyId: string, options?: RequestOptions) {
    return api.get<SpsModelConnection[]>(companyConnectionsPath(companyId), options);
  },

  create(companyId: string, input: CreateSpsModelConnection, options?: RequestOptions) {
    return api.post<SpsModelConnection>(companyConnectionsPath(companyId), input, options);
  },

  setStatus(companyId: string, connectionId: string, status: SpsModelConnectionStatus, options?: RequestOptions) {
    const path = `${companyConnectionsPath(companyId)}/${uuidPathSegment(connectionId, "connectionId")}`;
    return api.patch<SpsModelConnection>(path, { status }, options);
  },

  listGrants(companyId: string, connectionId: string, options?: RequestOptions) {
    const path = `${companyConnectionsPath(companyId)}/${uuidPathSegment(connectionId, "connectionId")}/grants`;
    return api.get<SpsModelGrant[]>(path, options);
  },

  grant(companyId: string, connectionId: string, pluginId: string, options?: RequestOptions) {
    const path = `${companyConnectionsPath(companyId)}/${uuidPathSegment(connectionId, "connectionId")}/grants`;
    return api.post<SpsModelGrant>(path, { pluginId: requireUuid(pluginId, "pluginId") }, options);
  },

  revoke(companyId: string, grantId: string, options?: RequestOptions) {
    const path = `/companies/${uuidPathSegment(companyId, "companyId")}/sps-model-grants/${uuidPathSegment(grantId, "grantId")}/revoke`;
    return api.post<void>(path, {}, options);
  },
};

export type CreateSpsModelConnectionInput = CreateSpsModelConnection;
