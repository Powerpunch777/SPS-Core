import { describe, expect, it, vi } from "vitest";

import type { HostServices } from "../src/host-client-factory.js";
import {
  CapabilityDeniedError,
  createHostClientHandlers,
  InvocationScopeDeniedError,
} from "../src/host-client-factory.js";
import type { WorkerHostCallContext } from "../src/protocol.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const MODEL_METHODS = [
  "sps.models.list",
  "sps.models.submit",
  "sps.models.get",
  "sps.models.cancel",
] as const;

type ModelMethod = (typeof MODEL_METHODS)[number];
type ModelCapability = "sps.models.read" | "sps.models.submit" | "sps.models.cancel";
type ModelServiceName = "list" | "submit" | "get" | "cancel";

const CAPABILITY_BY_METHOD: Record<ModelMethod, ModelCapability> = {
  "sps.models.list": "sps.models.read",
  "sps.models.submit": "sps.models.submit",
  "sps.models.get": "sps.models.read",
  "sps.models.cancel": "sps.models.cancel",
};

const SERVICE_BY_METHOD: Record<ModelMethod, ModelServiceName> = {
  "sps.models.list": "list",
  "sps.models.submit": "submit",
  "sps.models.get": "get",
  "sps.models.cancel": "cancel",
};

const PARAMS_BY_METHOD: Record<ModelMethod, Record<string, unknown>> = {
  "sps.models.list": { companyId: COMPANY_ID },
  "sps.models.submit": {
    companyId: COMPANY_ID,
    connectionId: CONNECTION_ID,
    requestKey: "worker:request-1",
    input: "Summarize this build.",
  },
  "sps.models.get": { companyId: COMPANY_ID, runId: RUN_ID },
  "sps.models.cancel": { companyId: COMPANY_ID, runId: RUN_ID },
};

function createModelServices() {
  const calls = {
    list: vi.fn(async () => undefined),
    submit: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };
  return {
    calls,
    services: { sps: { models: calls } } as unknown as HostServices,
  };
}

function invokeModelHandler(
  handlers: ReturnType<typeof createHostClientHandlers>,
  method: ModelMethod,
  params: unknown,
  context?: WorkerHostCallContext,
): Promise<unknown> {
  const handler = handlers[method] as unknown as (
    input: unknown,
    invocation?: WorkerHostCallContext,
  ) => Promise<unknown>;
  return handler(params, context);
}

function makeHandlers(capabilities: readonly ModelCapability[], services: HostServices) {
  return createHostClientHandlers({
    pluginId: "sps.model-test",
    capabilities,
    services,
  });
}

const validContext: WorkerHostCallContext = {
  invocationScope: { companyId: COMPANY_ID },
};

describe("createHostClientHandlers model-request RPCs", () => {
  it("forwards all four methods with their exact params under a valid UUID invocation", async () => {
    const { calls, services } = createModelServices();
    const handlers = makeHandlers(
      ["sps.models.read", "sps.models.submit", "sps.models.cancel"],
      services,
    );

    for (const method of MODEL_METHODS) {
      await invokeModelHandler(handlers, method, PARAMS_BY_METHOD[method], validContext);
      expect(calls[SERVICE_BY_METHOD[method]]).toHaveBeenCalledExactlyOnceWith(PARAMS_BY_METHOD[method]);
    }
  });

  it.each(MODEL_METHODS)("denies %s without its declared capability before service calls", async (method) => {
    const { calls, services } = createModelServices();
    const capabilities = (["sps.models.read", "sps.models.submit", "sps.models.cancel"] as const)
      .filter((capability) => capability !== CAPABILITY_BY_METHOD[method]);
    const handlers = makeHandlers(capabilities, services);

    await expect(
      invokeModelHandler(handlers, method, PARAMS_BY_METHOD[method], validContext),
    ).rejects.toMatchObject({
      name: CapabilityDeniedError.name,
      message: expect.stringContaining(CAPABILITY_BY_METHOD[method]),
    });
    expect(calls[SERVICE_BY_METHOD[method]]).not.toHaveBeenCalled();
  });

  it.each(MODEL_METHODS)("denies %s for absent, malformed, invalid, or foreign invocation scope", async (method) => {
    const { calls, services } = createModelServices();
    const handlers = makeHandlers(
      ["sps.models.read", "sps.models.submit", "sps.models.cancel"],
      services,
    );
    const invalidContexts: Array<WorkerHostCallContext | undefined> = [
      undefined,
      {},
      { invocationScope: null },
      { invocationScope: { companyId: "" } },
      { invocationScope: { companyId: "not-a-uuid" } },
      { invocationScope: { companyId: OTHER_COMPANY_ID } },
      { invocationScope: { companyId: COMPANY_ID }, invalidInvocationScope: true },
    ];

    for (const context of invalidContexts) {
      await expect(
        invokeModelHandler(handlers, method, PARAMS_BY_METHOD[method], context),
      ).rejects.toBeInstanceOf(InvocationScopeDeniedError);
    }
    expect(calls[SERVICE_BY_METHOD[method]]).not.toHaveBeenCalled();
  });

  it.each(MODEL_METHODS)("rejects missing and malformed companyId for %s before service calls", async (method) => {
    const { calls, services } = createModelServices();
    const handlers = makeHandlers(
      ["sps.models.read", "sps.models.submit", "sps.models.cancel"],
      services,
    );
    const base = PARAMS_BY_METHOD[method];
    const missing = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "companyId"));
    const malformed = { ...base, companyId: "company-a" };

    await expect(invokeModelHandler(handlers, method, missing, validContext)).rejects.toThrow();
    await expect(invokeModelHandler(handlers, method, malformed, validContext)).rejects.toThrow();
    expect(calls[SERVICE_BY_METHOD[method]]).not.toHaveBeenCalled();
  });

  it.each(["endpoint", "key", "tools"] as const)(
    "rejects extra submit field %s before calling the service",
    async (field) => {
      const { calls, services } = createModelServices();
      const handlers = makeHandlers(["sps.models.submit"], services);
      const params = { ...PARAMS_BY_METHOD["sps.models.submit"], [field]: "forbidden" };

      await expect(
        invokeModelHandler(handlers, "sps.models.submit", params, validContext),
      ).rejects.toThrow(/Invalid model request fields/);
      expect(calls.submit).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["connectionId", "sps.models.submit", { ...PARAMS_BY_METHOD["sps.models.submit"], connectionId: "not-a-uuid" }],
    ["runId", "sps.models.get", { ...PARAMS_BY_METHOD["sps.models.get"], runId: "not-a-uuid" }],
    ["cancel runId", "sps.models.cancel", { ...PARAMS_BY_METHOD["sps.models.cancel"], runId: "not-a-uuid" }],
    ["requestKey", "sps.models.submit", { ...PARAMS_BY_METHOD["sps.models.submit"], requestKey: "_invalid" }],
    ["oversize UTF-8 input", "sps.models.submit", { ...PARAMS_BY_METHOD["sps.models.submit"], input: "😀".repeat(16_385) }],
    ["newline-terminated connectionId", "sps.models.submit", { ...PARAMS_BY_METHOD["sps.models.submit"], connectionId: `${CONNECTION_ID}\n` }],
    ["newline-terminated requestKey", "sps.models.submit", { ...PARAMS_BY_METHOD["sps.models.submit"], requestKey: "request-1\n" }],
  ] as const)("rejects malformed model %s before service calls", async (_label, methodValue, params) => {
    const { calls, services } = createModelServices();
    const method: ModelMethod = methodValue;
    const handlers = makeHandlers(["sps.models.read", "sps.models.submit", "sps.models.cancel"], services);

    await expect(invokeModelHandler(handlers, method, params, validContext)).rejects.toThrow();
    expect(calls[SERVICE_BY_METHOD[method]]).not.toHaveBeenCalled();
  });

  it.each(MODEL_METHODS)("returns explicit unsupported when %s has no model service", async (method) => {
    const handlers = makeHandlers(
      ["sps.models.read", "sps.models.submit", "sps.models.cancel"],
      { sps: {} } as unknown as HostServices,
    );

    await expect(
      invokeModelHandler(handlers, method, PARAMS_BY_METHOD[method], validContext),
    ).rejects.toThrow("This SPS host does not expose model requests");
  });
});
