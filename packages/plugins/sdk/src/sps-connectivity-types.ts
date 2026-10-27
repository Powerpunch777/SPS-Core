/** Current request evidence only; never a socket probe, durable grant or Node/AI permission. */
export type PluginSpsConnectivity = Readonly<{
  transport: "native_tls";
  workspaceId: string;
  observedAt: string;
} & ({
  state: "verified";
  hostId: string;
  authorization: "authorized";
  evidence: "authenticated_request";
} | {
  state: "unavailable";
  hostId: null;
  authorization: "unknown";
  evidence: "none";
})>;
