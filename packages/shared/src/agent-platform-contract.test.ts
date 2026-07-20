import { describe, expect, it } from "vitest";
import {
  AGENT_PLATFORM_CONTRACT_VERSION,
  isAgentPlatformContractCompatible,
  normalizeAgentPlatformScope,
} from "./agent-platform-contract.js";

describe("agent platform contract", () => {
  it("normalizes optional scope boundaries", () => {
    expect(normalizeAgentPlatformScope({ organizationId: "company-1", projectId: undefined })).toEqual({
      organizationId: "company-1",
      projectId: null,
      workItemId: null,
      threadId: null,
      agentId: null,
      artifactId: null,
    });
  });

  it("accepts only the current major contract version", () => {
    expect(isAgentPlatformContractCompatible(AGENT_PLATFORM_CONTRACT_VERSION)).toBe(true);
    expect(isAgentPlatformContractCompatible("1.7")).toBe(true);
    expect(isAgentPlatformContractCompatible("2.0")).toBe(false);
  });
});
