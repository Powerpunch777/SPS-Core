import { api } from "./client";

export type SpsNodeCapability = {
  kind:
    | "claude_cli"
    | "codex_cli"
    | "agy_cli"
    | "gemini_cli"
    | "opencode_cli"
    | "pi_cli"
    | "ollama"
    | "lm_studio"
    | "specialist_api"
    | "custom";
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

export type SpsNodeRunnerAgentGrant = {
  id: string;
  companyId: string;
  nodeId: string;
  runnerProfileId: string;
  agentId: string;
  grantedByUserId: string;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agent: { id: string; name: string; title: string | null } | null;
};

export type SpsNodeRunnerProfile = {
  id: string;
  companyId: string;
  nodeId: string;
  runnerKey: string;
  kind: SpsNodeCapability["kind"];
  label: string;
  version: string | null;
  models: string[];
  profileLabel: string | null;
  credentialStatus: "ready" | "auth_required" | "unknown";
  availabilityStatus: "available" | "busy" | "quota_limited" | "auth_required" | "offline" | "unknown";
  availabilityDetail: string | null;
  availabilitySource: "node_probe" | "adapter" | "manual";
  availabilityConfidence: number | null;
  availabilityObservedAt: string | null;
  retryAfter: string | null;
  createdAt: string;
  updatedAt: string;
  agentGrants: SpsNodeRunnerAgentGrant[];
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
  runners: SpsNodeRunnerProfile[];
};

/** Core exposes technical membership facts only; plugins own workflow roles. */
export type SpsTechnicalMember = {
  id: string;
  accountId: string;
  isHost: boolean;
  status: "active" | "archived";
  joinedAt: string;
  archivedAt: string | null;
  nodeCount: number;
  activeNodeCount: number;
};

export type SpsTechnicalMemberRemoval = {
  member: Pick<SpsTechnicalMember, "id" | "accountId" | "status" | "joinedAt" | "archivedAt">;
  revokedNodeCount: number;
};

export const spsNodesApi = {
  list: (companyId: string) => api.get<SpsNode[]>(`/companies/${companyId}/sps-nodes`),
  listTechnicalMembers: (companyId: string) =>
    api.get<{ members: SpsTechnicalMember[] }>(`/companies/${companyId}/sps-members`),
  revokeTechnicalMember: (companyId: string, memberId: string) =>
    api.post<SpsTechnicalMemberRemoval>(`/companies/${companyId}/sps-members/${memberId}/revoke`, {}),
  approve: (nodeId: string) => api.post<SpsNode>(`/sps-nodes/${nodeId}/approve`, {}),
  revoke: (nodeId: string) => api.post<SpsNode>(`/sps-nodes/${nodeId}/revoke`, {}),
  grantAgent: (nodeId: string, agentId: string) =>
    api.put<SpsNodeAgentGrant>(`/sps-nodes/${nodeId}/agent-grants/${agentId}`, {}),
  revokeAgent: (nodeId: string, agentId: string) =>
    api.delete<void>(`/sps-nodes/${nodeId}/agent-grants/${agentId}`),
  grantAgentRunner: (nodeId: string, runnerProfileId: string, agentId: string) =>
    api.put<SpsNodeRunnerAgentGrant>(`/sps-nodes/${nodeId}/runners/${runnerProfileId}/agent-grants/${agentId}`, {}),
  revokeAgentRunner: (nodeId: string, runnerProfileId: string, agentId: string) =>
    api.delete<void>(`/sps-nodes/${nodeId}/runners/${runnerProfileId}/agent-grants/${agentId}`),
  bindPrimary: (agentId: string, nodeId: string) =>
    api.put<SpsAgentNodeBinding>(`/agents/${agentId}/sps-node-binding`, { nodeId }),
  clearPrimary: (agentId: string) => api.delete<void>(`/agents/${agentId}/sps-node-binding`),
};
