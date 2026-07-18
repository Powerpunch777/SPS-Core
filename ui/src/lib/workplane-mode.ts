export const WORKPLANE_PROJECT_TAB = "plugin:local.room-chat:project-workplane" as const;

const WORKPLANE_ROOM_ORIGIN_KINDS = new Set([
  "plugin:local.room-chat:agent-room-provisioning",
  "plugin:local.room-chat:project-room-provisioning",
]);

export function isWorkplaneModeEnabled(): boolean {
  if (typeof document === "undefined") return false;
  return document.querySelector('meta[name="sps-workplane-mode"]')?.getAttribute("content") === "true";
}

export function isWorkplaneRoomOriginKind(originKind: string | null | undefined): boolean {
  if (!originKind) return false;
  return WORKPLANE_ROOM_ORIGIN_KINDS.has(originKind)
    || originKind.startsWith("plugin:local.room-chat:operation:agent-room");
}

export function filterWorkplaneTaskIssues<T extends { originKind?: string | null }>(
  issues: T[],
  workplaneMode = isWorkplaneModeEnabled(),
): T[] {
  return workplaneMode ? issues.filter((issue) => !isWorkplaneRoomOriginKind(issue.originKind)) : issues;
}
