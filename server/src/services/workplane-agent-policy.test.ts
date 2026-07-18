import { describe, expect, it } from "vitest";
import { configuredWorkplaneAgentKind, configuredWorkplaneWorker } from "./workplane-agent-policy.js";

describe("configuredWorkplaneAgentKind", () => {
  it("only enables an explicit, supported Workplane kind", () => {
    expect(configuredWorkplaneAgentKind({})).toBeNull();
    expect(configuredWorkplaneAgentKind({ adapterConfig: { workplane: { kind: "lead" } } })).toBe("lead");
    expect(configuredWorkplaneAgentKind({ adapterConfig: { workplane: { kind: "worker" } } })).toBe("worker");
    expect(configuredWorkplaneAgentKind({ adapterConfig: { workplane: { kind: "hybrid" } } })).toBe("hybrid");
    expect(configuredWorkplaneAgentKind({ adapterConfig: { workplane: { kind: "manager" } } })).toBeNull();
  });

  it("does not treat malformed or unrelated adapter config as Workplane policy", () => {
    expect(configuredWorkplaneWorker({ adapterConfig: null })).toBe(false);
    expect(configuredWorkplaneWorker({ adapterConfig: { workplane: "worker" } })).toBe(false);
    expect(configuredWorkplaneWorker({ adapterConfig: { nested: { kind: "worker" } } })).toBe(false);
  });
});
