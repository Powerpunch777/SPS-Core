import express from "express";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginLoader } from "./plugin-loader.js";
import { pluginUiStaticRoutes } from "../routes/plugin-ui-static.js";
import {
  assertPluginRuntimeAllowed,
  isPluginRecoveryDisableRequest,
  isPluginRecoveryStatusRequest,
  pluginRecoveryMessage,
  resolvePluginRecoveryState,
  runPluginStartupUnlessRecovering,
} from "./sps-plugin-recovery.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  delete (globalThis as Record<string, unknown>).__spsPluginRecoveryImportProbe;
});

describe("SPS Plugin recovery gate", () => {
  it("keeps unset mode normal and fails closed for every invalid nonempty value", () => {
    expect(resolvePluginRecoveryState(undefined)).toEqual({ enabled: false, invalidConfiguration: false });
    expect(resolvePluginRecoveryState("")).toEqual({ enabled: false, invalidConfiguration: false });
    expect(resolvePluginRecoveryState("all-disabled")).toEqual({ enabled: true, invalidConfiguration: false });
    expect(resolvePluginRecoveryState("disabled")).toEqual({ enabled: true, invalidConfiguration: true });
    expect(resolvePluginRecoveryState(" ")).toEqual({ enabled: true, invalidConfiguration: true });
  });

  it("does not invoke startup loader work while gated and preserves the normal callback", () => {
    const startPluginLoader = vi.fn(() => "started");

    expect(runPluginStartupUnlessRecovering(resolvePluginRecoveryState("all-disabled"), startPluginLoader)).toBeUndefined();
    expect(startPluginLoader).not.toHaveBeenCalled();
    expect(runPluginStartupUnlessRecovering(resolvePluginRecoveryState(undefined), startPluginLoader)).toBe("started");
    expect(startPluginLoader).toHaveBeenCalledOnce();
  });

  it("rejects package imports, discovery, installs, upgrades, migration inspection, and activation before DB or module access", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "sps-plugin-recovery-"));
    tempDirs.push(packageRoot);
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "paperclip-plugin-recovery-probe",
      type: "module",
      scripts: { build: "node build.mjs" },
      spsPlugin: { manifest: "manifest.mjs" },
    }));
    await writeFile(
      path.join(packageRoot, "manifest.mjs"),
      "globalThis.__spsPluginRecoveryImportProbe = true; throw new Error('Recovery canary must never load'); export default {};\n",
    );

    const db = { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() };
    const loader = pluginLoader(db as never, {
      recoveryState: resolvePluginRecoveryState("all-disabled"),
    });
    const blocked = pluginRecoveryMessage(resolvePluginRecoveryState("all-disabled"));
    const prepared = {} as never;

    await expect(loader.discoverAll()).rejects.toThrow(blocked);
    await expect(loader.discoverFromLocalFilesystem(packageRoot)).rejects.toThrow(blocked);
    await expect(loader.discoverFromNpm([packageRoot])).rejects.toThrow(blocked);
    await expect(loader.loadManifest(packageRoot)).rejects.toThrow(blocked);
    await expect(loader.installPlugin({ localPath: packageRoot })).rejects.toThrow(blocked);
    await expect(loader.previewRegistryPluginEnable({ localPath: packageRoot, staticManifest: {} as never })).rejects.toThrow(blocked);
    await expect(loader.prepareUpgrade("plugin-id", {})).rejects.toThrow(blocked);
    await expect(loader.commitPreparedUpgrade("plugin-id", prepared)).rejects.toThrow(blocked);
    await expect(loader.upgradePlugin("plugin-id", {})).rejects.toThrow(blocked);
    await expect(loader.inspectPluginMigrations("plugin-id")).rejects.toThrow(blocked);
    await expect(loader.loadAll()).rejects.toThrow(blocked);
    await expect(loader.loadSingle("plugin-id")).rejects.toThrow(blocked);

    expect((globalThis as Record<string, unknown>).__spsPluginRecoveryImportProbe).toBeUndefined();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("keeps discovery behavior unchanged when recovery mode is unset", async () => {
    const loader = pluginLoader({} as never, {
      enableLocalFilesystem: false,
      enableNpmDiscovery: false,
      recoveryState: resolvePluginRecoveryState(undefined),
    });

    await expect(loader.discoverAll()).resolves.toEqual({
      discovered: [],
      errors: [],
      sources: [],
    });
  });

  it("only permits package status and authenticated disable paths in the plugin API", () => {
    expect(isPluginRecoveryStatusRequest("GET", "/plugins")).toBe(true);
    expect(isPluginRecoveryStatusRequest("GET", "/plugins/plugin-key")).toBe(true);
    expect(isPluginRecoveryStatusRequest("GET", "/plugins/ui-contributions")).toBe(false);
    expect(isPluginRecoveryStatusRequest("GET", "/plugins/examples")).toBe(false);
    expect(isPluginRecoveryStatusRequest("GET", "/plugins/plugin-key/jobs")).toBe(false);
    expect(isPluginRecoveryDisableRequest("POST", "/plugins/plugin-key/disable")).toBe(true);
    expect(isPluginRecoveryDisableRequest("POST", "/plugins/install")).toBe(false);
    expect(() => assertPluginRuntimeAllowed(resolvePluginRecoveryState("invalid"), "install"))
      .toThrow("must be unset or exactly");
  });

  it("rejects Plugin UI static assets before resolving a registry entry", async () => {
    const db = { select: vi.fn() };
    const app = express();
    app.use(pluginUiStaticRoutes(db as never, {
      localPluginDir: os.tmpdir(),
      recoveryState: resolvePluginRecoveryState("all-disabled"),
    }));

    const response = await request(app).get("/_plugins/plugin-key/ui/index.js");
    expect(response.status).toBe(423);
    expect(response.body.code).toBe("plugin_recovery_active");
    expect(response.body.error).toContain("Plugin code and contributions are disabled");
    expect(db.select).not.toHaveBeenCalled();
  });
});
