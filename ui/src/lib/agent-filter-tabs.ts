export const AGENT_FILTER_TABS = [
  "all",
  "active",
  "paused",
  "error",
  "builtin",
] as const;

export type AgentFilterTab = (typeof AGENT_FILTER_TABS)[number];
