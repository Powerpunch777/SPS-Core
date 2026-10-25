import { and, eq, ne } from "drizzle-orm";
import { companies, pluginCompanySettings, plugins, type Db } from "../compat/paperclip/db.js";
import { analyzePluginDependencies, isPluginDependencyAvailable } from "./plugin-dependencies.js";
import { defaultPluginCompanyActivation } from "./plugin-company-activation.js";
import { resolvePluginRecoveryState } from "./sps-plugin-recovery.js";

const unavailableMessage = "Plugin is unavailable in this Workspace";

export async function assertSpsPluginAvailable(
  db: Db,
  input: { companyId: string; pluginId: string },
  requiredCapability: string,
): Promise<{ pluginKey: string }> {
  try {
    if (resolvePluginRecoveryState().enabled) throw new Error(unavailableMessage);
    const [company] = await db.select({ id: companies.id })
      .from(companies)
      .where(and(
        eq(companies.id, input.companyId),
        eq(companies.status, "active"),
      ))
      .limit(1);
    if (!company) throw new Error(unavailableMessage);

    const installed = await db.select({
      plugin: plugins,
      enabled: pluginCompanySettings.enabled,
    })
      .from(plugins)
      .leftJoin(pluginCompanySettings, and(
        eq(pluginCompanySettings.pluginId, plugins.id),
        eq(pluginCompanySettings.companyId, input.companyId),
      ))
      .where(ne(plugins.status, "uninstalled"));

    const target = installed.find(({ plugin }) => plugin.id === input.pluginId);
    if (!target || target.plugin.status !== "ready") throw new Error(unavailableMessage);
    if (!target.plugin.manifestJson.capabilities.some((capability) => capability === requiredCapability)) {
      throw new Error(unavailableMessage);
    }
    if (!(target.enabled ?? defaultPluginCompanyActivation(target.plugin))) {
      throw new Error(unavailableMessage);
    }

    const candidates = installed.map(({ plugin, enabled }) => ({
      id: plugin.id,
      version: plugin.version,
      manifest: plugin.manifestJson,
      available: plugin.status === "ready",
      active: plugin.status === "ready"
        && (enabled ?? defaultPluginCompanyActivation(plugin)),
    }));

    const report = analyzePluginDependencies(candidates);
    if (!isPluginDependencyAvailable(report, target.plugin.manifestJson.id)) {
      throw new Error(unavailableMessage);
    }

    return { pluginKey: target.plugin.pluginKey };
  } catch {
    throw new Error(unavailableMessage);
  }
}
