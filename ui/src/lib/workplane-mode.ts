export interface WorkplaneUiProfile {
  enabled: boolean;
  roomOriginPrefixes: string[];
  defaultProjectTab: string | null;
}

function metaContent(name: string): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? null;
}

function roomOriginPrefixes(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is string => (
      typeof item === "string"
      && item.length > 0
      && item.length <= 240
      && !/[\x00-\x1F\x7F]/.test(item)
      && !item.includes("%")
      && !item.includes("_")
    )))].slice(0, 32);
  } catch {
    return [];
  }
}

export function getWorkplaneUiProfile(): WorkplaneUiProfile {
  const enabled = metaContent("sps-workplane-mode") === "true";
  const defaultProjectTab = metaContent("sps-workplane-default-project-tab");
  return {
    enabled,
    roomOriginPrefixes: roomOriginPrefixes(metaContent("sps-workplane-room-origin-prefixes")),
    defaultProjectTab: defaultProjectTab && defaultProjectTab.length <= 240 && !/\s/.test(defaultProjectTab)
      ? defaultProjectTab
      : null,
  };
}

export function isWorkplaneModeEnabled(): boolean {
  return getWorkplaneUiProfile().enabled;
}

export function isWorkplaneRoomOriginKind(
  originKind: string | null | undefined,
  profile: Pick<WorkplaneUiProfile, "roomOriginPrefixes"> = getWorkplaneUiProfile(),
): boolean {
  if (!originKind) return false;
  return profile.roomOriginPrefixes.some((prefix) => originKind.startsWith(prefix));
}

export function filterWorkplaneTaskIssues<T extends { originKind?: string | null }>(
  issues: T[],
  workplaneMode = isWorkplaneModeEnabled(),
  profile: Pick<WorkplaneUiProfile, "roomOriginPrefixes"> = getWorkplaneUiProfile(),
): T[] {
  return workplaneMode ? issues.filter((issue) => !isWorkplaneRoomOriginKind(issue.originKind, profile)) : issues;
}
