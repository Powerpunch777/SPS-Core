import { describe, expect, it } from "vitest";
import {
  assertSpsWorkspaceAgentSessionInvocation,
  withSpsWorkspaceAgentSessionInvocation,
} from "../services/sps-workspace-agent-session-invocation.js";

const workspaceA = "11111111-1111-4111-8111-111111111111";
const workspaceB = "22222222-2222-4222-8222-222222222222";
const pluginA = "33333333-3333-4333-8333-333333333333";
const pluginB = "44444444-4444-4444-8444-444444444444";

function invoke(
  workspaceId: string,
  pluginId: string,
  assertCurrent: () => void | Promise<void> = async () => undefined,
  action: () => Promise<unknown> = async () => undefined,
) {
  return withSpsWorkspaceAgentSessionInvocation({ workspaceId, pluginId, assertCurrent }, action);
}

describe("SPS Workspace Agent session invocation scope", () => {
  it("allows valid UUID scopes when the Host authority callback resolves undefined before and after the action", async () => {
    let authorityChecks = 0;

    await expect(invoke(workspaceA, pluginA, async () => {
      authorityChecks += 1;
      return undefined;
    }, async () => {
      await expect(assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA)).resolves.toBeUndefined();
      return "action result";
    })).resolves.toBe("action result");

    expect(authorityChecks).toBe(3);
  });

  it("rejects missing, malformed, and foreign scope identities", async () => {
    await expect(assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA)).rejects.toThrow();
    await expect(invoke("not-a-uuid", pluginA)).rejects.toThrow();
    await expect(invoke(workspaceA, "not-a-uuid")).rejects.toThrow();

    await invoke(workspaceA, pluginA, async () => undefined, async () => {
      await expect(assertSpsWorkspaceAgentSessionInvocation(pluginB, workspaceA)).rejects.toThrow();
      await expect(assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceB)).rejects.toThrow();
    });
  });

  it("isolates concurrently active async contexts", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let readyCount = 0;
    let allReady!: () => void;
    const ready = new Promise<void>(resolve => { allReady = resolve; });

    const run = (workspaceId: string, pluginId: string, foreignWorkspaceId: string, foreignPluginId: string) =>
      invoke(workspaceId, pluginId, async () => undefined, async () => {
        await assertSpsWorkspaceAgentSessionInvocation(pluginId, workspaceId);
        await expect(assertSpsWorkspaceAgentSessionInvocation(pluginId, foreignWorkspaceId)).rejects.toThrow();
        await expect(assertSpsWorkspaceAgentSessionInvocation(foreignPluginId, workspaceId)).rejects.toThrow();
        readyCount += 1;
        if (readyCount === 2) allReady();
        await gate;
        await assertSpsWorkspaceAgentSessionInvocation(pluginId, workspaceId);
      });

    const first = run(workspaceA, pluginA, workspaceB, pluginB);
    const second = run(workspaceB, pluginB, workspaceA, pluginA);
    await ready;
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("restores the outer scope after a nested invocation finishes", async () => {
    await invoke(workspaceA, pluginA, async () => undefined, async () => {
      await assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA);
      await invoke(workspaceB, pluginB, async () => undefined, async () => {
        await assertSpsWorkspaceAgentSessionInvocation(pluginB, workspaceB);
        await expect(assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA)).rejects.toThrow();
      });
      await assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA);
      await expect(assertSpsWorkspaceAgentSessionInvocation(pluginB, workspaceB)).rejects.toThrow();
    });
  });

  it("rejects a detached async descendant after its parent action returns", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let descendant!: Promise<void>;

    await invoke(workspaceA, pluginA, async () => undefined, async () => {
      descendant = (async () => {
        await gate;
        await assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA);
      })();
    });

    release();
    await expect(descendant).rejects.toThrow();
  });

  it("rejects stale authority before delegation and after authority changes during the action", async () => {
    let actionStarted = false;
    await expect(invoke(workspaceA, pluginA, async () => {
      throw new Error("stale before action");
    }, async () => {
      actionStarted = true;
    })).rejects.toThrow();
    expect(actionStarted).toBe(false);

    let current = true;
    await expect(invoke(workspaceA, pluginA, async () => {
      if (!current) throw new Error("stale authority");
    }, async () => {
      await assertSpsWorkspaceAgentSessionInvocation(pluginA, workspaceA);
      current = false;
    })).rejects.toThrow();
  });

  it.each([false, true])("rejects Host authority callbacks that resolve %s instead of undefined", async value => {
    let actionCalled = false;
    const assertCurrent = async () => value as unknown as void;

    await expect(invoke(workspaceA, pluginA, assertCurrent, async () => {
      actionCalled = true;
    })).rejects.toThrow();

    expect(actionCalled).toBe(false);
  });
});
