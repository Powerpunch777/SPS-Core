import { conflict } from "../errors.js";
import { SpsPluginArtifactMaintenanceBusyError, type SpsPluginArtifactMaintenance } from "./sps-plugin-artifact-maintenance.js";

/** Join the caller's existing private gate; this grants no resource authority. */
export async function withSpsPluginArtifactMutation<T>(
  maintenance: SpsPluginArtifactMaintenance | undefined,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await (maintenance ? maintenance.withActivity(action) : action());
  } catch (error) {
    if (error instanceof SpsPluginArtifactMaintenanceBusyError) {
      throw conflict(error.message, { code: error.code });
    }
    throw error;
  }
}
