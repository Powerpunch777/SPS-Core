import { api } from "./client";

export type SpsNodeCapability = {
  kind: "codex_cli" | "agy_cli" | "opencode_cli" | "ollama" | "lm_studio" | "specialist_api" | "custom";
  label: string;
  version?: string | null;
  models?: string[];
};

export type SpsNodeAgentGrant = {
  id: string;
  companyId: string;
  nodeId: string;
  agentId: string;
  grantedByUserId: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agent: { id: string; name: string; title: string | null } | null;
};

export type SpsAgentNodeBinding = {
  id: string;
  companyId: string;
  agentId: string;
  nodeId: string;
  assignedByUserId: string;
  createdAt: string;
  updatedAt: string;
  agent: { id: string; name: string; title: string | null } | null;
};

export type SpsNode = {
  id: string;
  companyId: string;
  ownerUserId: string;
  displayName: string;
  platform: string;
  appVersion: string | null;
  capabilities: SpsNodeCapability[];
  status: "pending" | "active" | "revoked";
  approvedAt: string | null;
  approvedByUserId: string | null;
  revokedAt: string | null;
  keyVerifiedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentGrants: SpsNodeAgentGrant[];
  primaryAgentBindings: SpsAgentNodeBinding[];
};

export const spsNodesApi = {
  list: (companyId: string) => api.get<SpsNode[]>(`/companies/${companyId}/sps-nodes`),
  approve: (nodeId: string) => api.post<SpsNode>(`/sps-nodes/${nodeId}/approve`, {}),
  revoke: (nodeId: string) => api.post<SpsNode>(`/sps-nodes/${nodeId}/revoke`, {}),
  grantAgent: (nodeId: string, agentId: string) =>
    api.put<SpsNodeAgentGrant>(`/sps-nodes/${nodeId}/agent-grants/${agentId}`, {}),
  revokeAgent: (nodeId: string, agentId: string) =>
    api.delete<void>(`/sps-nodes/${nodeId}/agent-grants/${agentId}`),
  bindPrimary: (agentId: string, nodeId: string) =>
    api.put<SpsAgentNodeBinding>(`/agents/${agentId}/sps-node-binding`, { nodeId }),
  clearPrimary: (agentId: string) => api.delete<void>(`/agents/${agentId}/sps-node-binding`),
};
