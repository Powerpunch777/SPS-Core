import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  plugins,
} from "@paperclipai/db";
import type { PaperclipPluginManifestV1, PluginStatus } from "@paperclipai/shared";
import { assertSpsPluginAvailable } from "../services/sps-plugin-availability.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const unavailableMessage = "Plugin is unavailable in this Workspace";

type Db = ReturnType<typeof createDb>;

function makeManifest(
  id: string,
  overrides: Partial<PaperclipPluginManifestV1> = {},
): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Availability fixture",
    description: "Isolated availability test package",
    author: "SPS test",
    categories: ["automation"],
    capabilities: ["sps.models.request"],
    entrypoints: { worker: "./worker.js" },
    ...overrides,
  };
}

describeEmbeddedPostgres("SPS Plugin availability", () => {
  let db!: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("sps-plugin-availability-");
    db = createDb(temporary.connectionString);
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  async function createWorkspace(status = "active"): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "Availability fixture Workspace",
      issuePrefix: `AV${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status,
    });
    return id;
  }

  async function installPlugin(options: {
    manifest?: Partial<PaperclipPluginManifestV1>;
    status?: PluginStatus;
  } = {}) {
    const id = randomUUID();
    const pluginManifest = makeManifest(`sps.availability-${id}`, options.manifest);
    await db.insert(plugins).values({
      id,
      pluginKey: pluginManifest.id,
      packageName: `@sps/${id}`,
      version: pluginManifest.version,
      apiVersion: pluginManifest.apiVersion,
      categories: pluginManifest.categories,
      manifestJson: pluginManifest,
      status: options.status ?? "ready",
    });
    return { id, pluginKey: pluginManifest.id, manifest: pluginManifest };
  }

  async function setActivation(companyId: string, pluginId: string, enabled: boolean): Promise<void> {
    await db.insert(pluginCompanySettings).values({
      companyId,
      pluginId,
      enabled,
      settingsJson: {},
    });
  }

  async function expectUnavailable(operation: Promise<unknown>): Promise<void> {
    const error = await operation.then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(unavailableMessage);
  }

  it("allows a ready plugin enabled by default and re-reads an explicit disable", async () => {
    const companyId = await createWorkspace();
    const plugin = await installPlugin();

    await expect(assertSpsPluginAvailable(db, { companyId, pluginId: plugin.id }, "sps.models.request"))
      .resolves.toEqual({ pluginKey: plugin.pluginKey });

    await setActivation(companyId, plugin.id, false);
    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));
  });

  it.each(["all-disabled", "invalid-recovery-mode"])("blocks even an active Plugin while recovery is %s", async mode => {
    const companyId = await createWorkspace();
    const plugin = await installPlugin();
    await setActivation(companyId, plugin.id, true);
    vi.stubEnv("SPS_PLUGIN_RECOVERY_MODE", mode);
    await expectUnavailable(assertSpsPluginAvailable(db, { companyId, pluginId: plugin.id }, "sps.models.request"));
  });

  it("honors a disabled manifest default and an explicit Workspace enable", async () => {
    const companyId = await createWorkspace();
    const plugin = await installPlugin({ manifest: { companyActivation: { defaultEnabled: false } } });

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));

    await setActivation(companyId, plugin.id, true);
    await expect(assertSpsPluginAvailable(db, { companyId, pluginId: plugin.id }, "sps.models.request"))
      .resolves.toEqual({ pluginKey: plugin.pluginKey });
  });

  it.each(["installed", "disabled", "error", "upgrade_pending", "uninstalled"] as const)("requires a ready Host package (status: %s)", async (status) => {
    const companyId = await createWorkspace();
    const plugin = await installPlugin({ status });

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));
  });

  it("requires an active Workspace", async () => {
    const companyId = await createWorkspace("paused");
    const plugin = await installPlugin();

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));
  });

  it("rejects a missing capability without disclosing identifiers", async () => {
    const companyId = await createWorkspace();
    const plugin = await installPlugin();

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.manage",
    ));
  });

  it("rejects a missing Workspace and does not reuse activation from another Workspace", async () => {
    const companyId = await createWorkspace();
    const foreignCompanyId = await createWorkspace();
    const plugin = await installPlugin({ manifest: { companyActivation: { defaultEnabled: false } } });
    await setActivation(foreignCompanyId, plugin.id, true);

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));
    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId: randomUUID(), pluginId: plugin.id },
      "sps.models.request",
    ));
  });

  it.each(["missing", "disabled", "incompatible"])("requires a current compatible active dependency (%s)", async (mode) => {
    const companyId = await createWorkspace();
    const dependencyId = "sps.availability-dependency";
    const requiredDependencies = [{ id: dependencyId, minVersion: "1.0.0", maxVersion: "1.5.0" }];
    const plugin = await installPlugin({ manifest: { requiredDependencies } });

    if (mode !== "missing") {
      const dependency = await installPlugin({
        manifest: {
          id: dependencyId,
          version: mode === "incompatible" ? "2.0.0" : "1.2.0",
        },
      });
      if (mode === "disabled") await setActivation(companyId, dependency.id, false);
    }

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));
  });

  it("allows a required dependency when its current package and activation are compatible", async () => {
    const companyId = await createWorkspace();
    const dependencyId = "sps.availability-compatible-dependency";
    const plugin = await installPlugin({
      manifest: {
        requiredDependencies: [{ id: dependencyId, minVersion: "1.0.0", maxVersion: "1.5.0" }],
      },
    });
    const dependency = await installPlugin({
      manifest: {
        id: dependencyId,
        version: "1.2.0",
        companyActivation: { defaultEnabled: false },
      },
    });
    await setActivation(companyId, dependency.id, true);

    await expect(assertSpsPluginAvailable(db, { companyId, pluginId: plugin.id }, "sps.models.request"))
      .resolves.toEqual({ pluginKey: plugin.pluginKey });
  });

  it("rejects an active manifest conflict", async () => {
    const companyId = await createWorkspace();
    const plugin = await installPlugin({
      manifest: { conflicts: [{ id: "sps.availability-conflict", minVersion: "1.0.0" }] },
    });
    await installPlugin({ manifest: { id: "sps.availability-conflict" } });

    await expectUnavailable(assertSpsPluginAvailable(
      db,
      { companyId, pluginId: plugin.id },
      "sps.models.request",
    ));
  });
});
