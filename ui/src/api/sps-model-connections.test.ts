import { beforeEach, describe, expect, it, vi } from "vitest";

const mockApi = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", () => ({ api: mockApi }));

import { spsModelConnectionsApi } from "./sps-model-connections";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const PLUGIN_ID = "33333333-3333-4333-8333-333333333333";
const GRANT_ID = "44444444-4444-4444-8444-444444444444";

describe("spsModelConnectionsApi", () => {
  beforeEach(() => {
    mockApi.get.mockReset().mockResolvedValue([]);
    mockApi.post.mockReset().mockResolvedValue({});
    mockApi.patch.mockReset().mockResolvedValue({});
  });

  it("lists Host model connections with only the optional request signal", async () => {
    const options = { signal: new AbortController().signal };
    await spsModelConnectionsApi.list(COMPANY_ID, options);

    expect(mockApi.get).toHaveBeenCalledWith(
      `/companies/${COMPANY_ID}/sps-model-connections`,
      options,
    );
  });

  it("creates a connection with the shared input body unchanged", async () => {
    const input = {
      displayName: "Primary model",
      secretId: GRANT_ID,
      version: "latest" as const,
      transport: {
        endpoint: "https://models.example/v1",
        model: "model-v1",
        timeoutMs: 30_000,
      },
    };
    const options = { signal: new AbortController().signal };

    await spsModelConnectionsApi.create(COMPANY_ID, input, options);

    expect(mockApi.post).toHaveBeenCalledWith(
      `/companies/${COMPANY_ID}/sps-model-connections`,
      input,
      options,
    );
  });

  it("uses the status PATCH endpoint and exact status body", async () => {
    const options = { signal: new AbortController().signal };
    await spsModelConnectionsApi.setStatus(COMPANY_ID, CONNECTION_ID, "disabled", options);

    expect(mockApi.patch).toHaveBeenCalledWith(
      `/companies/${COMPANY_ID}/sps-model-connections/${CONNECTION_ID}`,
      { status: "disabled" },
      options,
    );
  });

  it("lists and grants plugins on a connection", async () => {
    const options = { signal: new AbortController().signal };
    await spsModelConnectionsApi.listGrants(COMPANY_ID, CONNECTION_ID, options);
    await spsModelConnectionsApi.grant(COMPANY_ID, CONNECTION_ID, PLUGIN_ID, options);

    const path = `/companies/${COMPANY_ID}/sps-model-connections/${CONNECTION_ID}/grants`;
    expect(mockApi.get).toHaveBeenCalledWith(path, options);
    expect(mockApi.post).toHaveBeenCalledWith(path, { pluginId: PLUGIN_ID }, options);
  });

  it("revokes through the dedicated endpoint with an empty body", async () => {
    const options = { signal: new AbortController().signal };
    await spsModelConnectionsApi.revoke(COMPANY_ID, GRANT_ID, options);

    expect(mockApi.post).toHaveBeenCalledWith(
      `/companies/${COMPANY_ID}/sps-model-grants/${GRANT_ID}/revoke`,
      {},
      options,
    );
  });

  it("rejects malformed UUID path and grant input before making requests", async () => {
    expect(() => spsModelConnectionsApi.list("company/../x")).toThrow("companyId must be a UUID");
    expect(() => spsModelConnectionsApi.setStatus(COMPANY_ID, "bad", "active")).toThrow("connectionId must be a UUID");
    expect(() => spsModelConnectionsApi.grant(COMPANY_ID, CONNECTION_ID, "bad")).toThrow("pluginId must be a UUID");
    expect(() => spsModelConnectionsApi.revoke(COMPANY_ID, "bad")).toThrow("grantId must be a UUID");
    expect(mockApi.get).not.toHaveBeenCalled();
    expect(mockApi.post).not.toHaveBeenCalled();
    expect(mockApi.patch).not.toHaveBeenCalled();
  });
});
