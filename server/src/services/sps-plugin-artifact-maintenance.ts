/** Private process coordination, not Host approval, filesystem authority or an OS sandbox. */
export interface SpsPluginArtifactMaintenance {
  withActivity<T>(action: () => Promise<T>): Promise<T>;
  assertAdmissionAllowed(): void;
  withMaintenance<T>(action: () => Promise<T>): Promise<T>;
}

export class SpsPluginArtifactMaintenanceBusyError extends Error {
  readonly code = "SPS_PLUGIN_ARTIFACT_MAINTENANCE_BUSY";

  constructor() {
    super("Plugin artifact maintenance is busy. Wait for the current operation, refresh and retry.");
    this.name = "SpsPluginArtifactMaintenanceBusyError";
  }
}

export function createSpsPluginArtifactMaintenance(): SpsPluginArtifactMaintenance {
  let activities = 0;
  let maintaining = false;
  const assertAdmissionAllowed = () => {
    if (maintaining) throw new SpsPluginArtifactMaintenanceBusyError();
  };
  return Object.freeze({
    assertAdmissionAllowed,
    async withActivity<T>(action: () => Promise<T>): Promise<T> {
      assertAdmissionAllowed();
      if (typeof action !== "function") throw new TypeError("Plugin artifact activity requires an action.");
      // Admission and accounting happen before invoking any asynchronous work.
      activities += 1;
      try { return await action(); }
      finally { activities -= 1; }
    },
    async withMaintenance<T>(action: () => Promise<T>): Promise<T> {
      if (maintaining || activities !== 0) throw new SpsPluginArtifactMaintenanceBusyError();
      if (typeof action !== "function") throw new TypeError("Plugin artifact maintenance requires an action.");
      maintaining = true;
      try { return await action(); }
      finally { maintaining = false; }
    },
  });
}
