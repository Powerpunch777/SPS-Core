/** Safe model metadata. Provider endpoints and credential references are Host-only. */
export interface PluginSpsModelConnection {
  id: string; displayName: string; protocol: "responses_text_v1"; model: string;
  state: "configured" | "disabled"; executionOwner: "host"; authorization: "grant_required"; readiness: "unknown";
  limits: { timeoutMs: number; maxOutputTokens: number; maxRequestBytes: number; maxResponseBytes: number };
}
export interface PluginSpsModelTextResult {
  status: "completed" | "incomplete"; text: string; refusal: string | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}
export interface PluginSpsModelRun {
  id: string; companyId: string; connectionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  externalEffects: "not_dispatched" | "unknown"; errorCode: string | null;
  cancellationRequested: boolean; cleanupPending: boolean;
  resultState: "available" | "not_ready" | "withheld"; result: PluginSpsModelTextResult | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface PluginSpsModelSubmitInput {
  companyId: string; connectionId: string; requestKey: string; input: string;
}
