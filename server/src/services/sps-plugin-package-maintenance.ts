/** Managed package maintenance is lifecycle coordination, not an OS sandbox. */
export class PluginPackageMaintenanceRequiredError extends Error {
  readonly code = "plugin_package_maintenance_required";

  constructor() {
    super("This package requires a maintenance window. Stop other plugins before removing it, then refresh and retry.");
    this.name = "PluginPackageMaintenanceRequiredError";
  }
}

const permitBrand: unique symbol = Symbol("PluginPackageMutationPermit");

/** Opaque proof that cleanup is running inside the manager's admission fence. */
export interface PluginPackageMutationPermit {
  readonly [permitBrand]: true;
}

type PermitMetadata = {
  pluginId: string;
  exclusive: boolean;
  active: boolean;
};

const permitMetadata = new WeakMap<object, PermitMetadata>();

/**
 * Issue a permit only for the dynamic extent of a caller-provided fenced
 * package mutation. WeakMap membership makes structural lookalikes useless.
 */
export async function withPluginPackageMutationPermit<T>(
  pluginId: string,
  exclusive: boolean,
  action: (permit: PluginPackageMutationPermit) => Promise<T>,
): Promise<T> {
  if (!pluginId || typeof action !== "function") throw new PluginPackageMaintenanceRequiredError();
  const permit = Object.freeze({ [permitBrand]: true as const });
  const metadata: PermitMetadata = { pluginId, exclusive, active: true };
  permitMetadata.set(permit, metadata);
  try {
    return await action(permit);
  } finally {
    metadata.active = false;
    permitMetadata.delete(permit);
  }
}

/** Require a live, matching permit at the artifact-deletion boundary. */
export function assertPluginPackageMutationPermit(
  permit: PluginPackageMutationPermit | undefined,
  pluginId: string,
  requiresExclusive: boolean,
): void {
  const metadata = permit && typeof permit === "object" ? permitMetadata.get(permit) : undefined;
  if (!metadata || !metadata.active || metadata.pluginId !== pluginId
    || (requiresExclusive && !metadata.exclusive)) {
    throw new PluginPackageMaintenanceRequiredError();
  }
}
