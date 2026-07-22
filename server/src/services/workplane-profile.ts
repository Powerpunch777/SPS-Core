const MAX_ORIGIN_PREFIXES = 32;
const MAX_ORIGIN_PREFIX_LENGTH = 240;
const MAX_DEFAULT_PROJECT_TAB_LENGTH = 240;

export interface WorkplaneRuntimeProfile {
  enabled: boolean;
  roomOriginPrefixes: string[];
  defaultProjectTab: string | null;
}

function truthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => (
      item.length > 0
      && item.length <= MAX_ORIGIN_PREFIX_LENGTH
      && !/[\u0000-\u001f%_]/.test(item)
    ));
  return [...new Set(values)].slice(0, MAX_ORIGIN_PREFIXES);
}

function projectTab(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_DEFAULT_PROJECT_TAB_LENGTH || /[\u0000-\u001f\s]/.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * The Core only understands a neutral room/task visibility profile. A bundled
 * or third-party Workplane supplies concrete origin prefixes and its preferred
 * project tab through runtime configuration; Core never imports a plugin id.
 */
export function getWorkplaneRuntimeProfile(
  env: NodeJS.ProcessEnv = process.env,
): WorkplaneRuntimeProfile {
  return {
    enabled: truthy(env.SPS_WORKPLANE_MODE) || truthy(env.PAPERCLIP_WORKPLANE_MODE),
    roomOriginPrefixes: splitList(
      env.SPS_WORKPLANE_ROOM_ORIGIN_PREFIXES
      ?? env.PAPERCLIP_WORKPLANE_ROOM_ORIGIN_PREFIXES,
    ),
    defaultProjectTab: projectTab(
      env.SPS_WORKPLANE_DEFAULT_PROJECT_TAB
      ?? env.PAPERCLIP_WORKPLANE_DEFAULT_PROJECT_TAB,
    ),
  };
}
