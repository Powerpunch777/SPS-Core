import { describe, expect, it, vi } from "vitest";
import { SpsPluginRuntimeCleanupPendingError, withSpsPluginRuntimeMutation,
  type SpsPluginRuntimeMutationCoordinator } from "../services/sps-plugin-runtime-mutation.js";
import { getCompletedSpsPluginRuntimeMutationResult } from "../services/sps-plugin-runtime-mutation.js";

function coordinator(): SpsPluginRuntimeMutationCoordinator {
  return { withPluginMutation: async (_id, action) => action(), reconcileCatalogPolicy: vi.fn(async () => {}) };
}

describe("Plugin lifecycle Workspace coordination", () => {
  it("does not execute a destructive mutation when owned closure is unconfirmed", async () => {
    const runtime = coordinator();
    runtime.withPluginMutation = async () => { throw new Error("private child diagnostics"); };
    const operation = vi.fn();
    await expect(withSpsPluginRuntimeMutation(runtime, "plugin", operation)).rejects.toMatchObject({
      code: "SPS_PLUGIN_RUNTIME_CLEANUP_PENDING", operationStarted: false, operationCompleted: false,
    });
    expect(operation).not.toHaveBeenCalled();
    expect(runtime.reconcileCatalogPolicy).not.toHaveBeenCalled();
  });

  it("joins policy cleanup before returning a completed mutation without replaying it", async () => {
    const runtime = coordinator();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cleaning = new Promise<void>(resolve => { entered = resolve; });
    runtime.reconcileCatalogPolicy = vi.fn(async () => { entered(); await gate; });
    const operation = vi.fn(async () => ({ status: "uninstalled" }));
    let delivered = false;
    const result = withSpsPluginRuntimeMutation(runtime, "plugin", operation).then(value => { delivered = true; return value; });
    await cleaning;
    expect(delivered).toBe(false);
    expect(operation).toHaveBeenCalledTimes(1);
    release();
    await expect(result).resolves.toEqual({ status: "uninstalled" });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("distinguishes completed mutations from pre-mutation cleanup failure", async () => {
    const runtime = coordinator();
    runtime.reconcileCatalogPolicy = vi.fn(async () => { throw new Error("private path"); });
    const operation = vi.fn(async () => ({ status: "disabled" }));
    const error = await withSpsPluginRuntimeMutation(runtime, "plugin", operation).catch(value => value);
    expect(error).toMatchObject({ operationStarted: true, operationCompleted: true });
    expect(getCompletedSpsPluginRuntimeMutationResult(error)).toEqual({ status: "disabled" });
    expect(JSON.stringify(error)).not.toContain("disabled");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("reconciles rollback policy but preserves an operation failure when cleanup succeeds", async () => {
    const runtime = coordinator();
    const failure = new Error("upgrade failed");
    await expect(withSpsPluginRuntimeMutation(runtime, "plugin", async () => { throw failure; })).rejects.toBe(failure);
    expect(runtime.reconcileCatalogPolicy).toHaveBeenCalledTimes(1);
  });

  it("does not describe a partially failed operation as committed when cleanup also fails", async () => {
    const runtime = coordinator();
    runtime.reconcileCatalogPolicy = vi.fn(async () => { throw new Error("cleanup failed"); });
    const error = await withSpsPluginRuntimeMutation(runtime, "plugin", async () => { throw new Error("partial upgrade"); }).catch(value => value);
    expect(error).toBeInstanceOf(SpsPluginRuntimeCleanupPendingError);
    expect(error).toMatchObject({ operationStarted: true, operationCompleted: false });
    expect(getCompletedSpsPluginRuntimeMutationResult(error)).toBeUndefined();
    expect(error.message).not.toContain("partial upgrade");
  });
});
