import { describe, expect, it } from "vitest";
import { createPluginInitialLoadReadiness } from "./plugin-initial-load-readiness.js";

describe("plugin initial load readiness", () => {
  it("is an immediate no-op before initial loading starts", async () => {
    const readiness = createPluginInitialLoadReadiness();
    await expect(readiness.wait("plugin-a")).resolves.toBeUndefined();
  });

  it("waits for the initial list, then waits only for the requested plugin", async () => {
    const readiness = createPluginInitialLoadReadiness();
    expect(readiness.begin()).toBe(true);

    let finishA!: () => void;
    const taskA = new Promise<void>(resolve => { finishA = resolve; });
    readiness.register("plugin-a", taskA);
    readiness.register("plugin-b", Promise.resolve());

    let aFinished = false;
    const waitingA = readiness.wait("plugin-a").then(() => { aFinished = true; });
    const waitingUnknown = readiness.wait("plugin-new");
    readiness.publish();

    await waitingUnknown;
    await readiness.wait("plugin-b");
    await Promise.resolve();
    expect(aFinished).toBe(false);

    finishA();
    await waitingA;
    expect(aFinished).toBe(true);
  });

  it("swallows an initial startup failure and allows later manager recovery", async () => {
    const readiness = createPluginInitialLoadReadiness();
    readiness.begin();
    readiness.register("plugin-a", Promise.reject(new Error("private startup detail")));
    readiness.publish();

    await expect(readiness.wait("plugin-a")).resolves.toBeUndefined();
    await expect(readiness.wait("plugin-a")).resolves.toBeUndefined();
  });

  it("tracks only the first startup listing", async () => {
    const readiness = createPluginInitialLoadReadiness();
    expect(readiness.begin()).toBe(true);
    expect(readiness.begin()).toBe(false);
    readiness.publish();
    await expect(readiness.wait("plugin-a")).resolves.toBeUndefined();
  });

  it("releases a preparation-only barrier and allows a later loadAll claim", async () => {
    const readiness = createPluginInitialLoadReadiness();
    const releasePreparation = readiness.prepare();
    let firstWaitFinished = false;
    const firstWait = readiness.wait("plugin-a").then(() => { firstWaitFinished = true; });
    await Promise.resolve();
    expect(firstWaitFinished).toBe(false);

    releasePreparation();
    await firstWait;
    expect(firstWaitFinished).toBe(true);

    expect(readiness.begin()).toBe(true);
    let finishRecovery!: () => void;
    readiness.register("plugin-a", new Promise<void>(resolve => { finishRecovery = resolve; }));
    let recoveryWaitFinished = false;
    const recoveryWait = readiness.wait("plugin-a").then(() => { recoveryWaitFinished = true; });
    readiness.publish();
    await Promise.resolve();
    expect(recoveryWaitFinished).toBe(false);
    finishRecovery();
    await recoveryWait;
    expect(recoveryWaitFinished).toBe(true);
  });
});
