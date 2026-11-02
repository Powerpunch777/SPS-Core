import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createCodexAppServerStateProbeClient } from "./app-server-read-client.js";

// Mock-only JSONL protocol tests; no CLI or model process is started.

type WireMessage = Record<string, unknown>;
interface ProbeFixture {
  input: PassThrough;
  output: PassThrough;
  client: ReturnType<typeof createCodexAppServerStateProbeClient>;
  messages: WireMessage[];
  waitFor(count: number): Promise<void>;
  send(message: unknown): void;
}

const fixtures: ProbeFixture[] = [];
const threadId = "11111111-1111-4111-8111-111111111111";

function fixture(options: { timeoutMs?: number; maxFrameBytes?: number } = {}): ProbeFixture {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: WireMessage[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let buffered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/u, "");
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) messages.push(JSON.parse(line) as WireMessage);
    }
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (messages.length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  });
  const client = createCodexAppServerStateProbeClient({ input, output, ...options });
  const value: ProbeFixture = {
    input,
    output,
    client,
    messages,
    waitFor(count) {
      if (messages.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => waiters.push({ count, resolve }));
    },
    send(message) { input.write(`${JSON.stringify(message)}\n`); },
  };
  fixtures.push(value);
  return value;
}

async function initialized(options: { timeoutMs?: number; maxFrameBytes?: number } = {}) {
  const value = fixture(options);
  const handshake = value.client.initialize();
  void handshake.catch(() => {});
  await value.waitFor(1);
  expect(value.messages[0]).toEqual({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "sps_native_observer", title: "SPS native session observer", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    },
  });
  value.send({ id: 1, result: { serverInfo: { name: "fixture" } } });
  await expect(handshake).resolves.toEqual({ serverInfo: { name: "fixture" } });
  await value.waitFor(2);
  expect(value.messages[1]).toEqual({ method: "initialized", params: {} });
  return value;
}

function respond(value: ProbeFixture, id: number, result: unknown) {
  value.send({ id, result });
}

afterEach(() => {
  for (const value of fixtures.splice(0)) value.client.close();
});

describe("createCodexAppServerStateProbeClient", () => {
  it("uses the same initialization metadata and reads state after the handshake", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/goal/get", { threadId: "thread-1" });
    await value.waitFor(3);
    expect(value.messages[2]).toEqual({ id: 2, method: "thread/goal/get", params: { threadId: "thread-1" } });
    respond(value, 2, { goal: { status: "paused", objective: "Observe the existing session." } });
    await expect(pending).resolves.toEqual({ goal: { status: "paused", objective: "Observe the existing session." } });
  });

  it("allows a paused goal update and then reads the updated state", async () => {
    const value = await initialized();
    const write = value.client.request("thread/goal/set", {
      threadId, status: "paused", objective: "Review the existing thread safely. 📝", tokenBudget: 512,
    });
    await value.waitFor(3);
    expect(value.messages[2]).toEqual({
      id: 2,
      method: "thread/goal/set",
      params: { threadId, status: "paused", objective: "Review the existing thread safely. 📝", tokenBudget: 512 },
    });
    respond(value, 2, { goal: { threadId, status: "paused", objective: "Review the existing thread safely. 📝", tokenBudget: 512 } });
    await expect(write).resolves.toEqual({ goal: { threadId, status: "paused", objective: "Review the existing thread safely. 📝", tokenBudget: 512 } });

    const read = value.client.request("thread/goal/get", { threadId: "thread-1" });
    await value.waitFor(4);
    respond(value, 3, { goal: { threadId, status: "paused", objective: "Review the existing thread safely. 📝", tokenBudget: 512 } });
    await expect(read).resolves.toEqual({ goal: { threadId, status: "paused", objective: "Review the existing thread safely. 📝", tokenBudget: 512 } });
  });

  it.each([
    ["active", { threadId, status: "active", objective: "Do not accept this." }],
    ["default", { threadId, status: "default", objective: "Do not accept this." }],
    ["omitted", { threadId, objective: "Do not accept this." }],
  ])("rejects a %s goal write before it reaches the wire", async (_label, params) => {
    const value = await initialized();
    await expect(value.client.request("thread/goal/set", params)).rejects.toThrow(/paused/i);
    expect(value.messages).toHaveLength(2);
  });

  it("rejects null params asynchronously instead of throwing at the call site", async () => {
    const value = await initialized();
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = value.client.request("thread/goal/get", null as unknown as Record<string, unknown>);
    }).not.toThrow();
    await expect(pending).rejects.toThrow(/params|object/i);
    expect(value.messages).toHaveLength(2);
  });

  it("rejects unsafe goal params without invoking getters or toJSON and without writing", async () => {
    const value = await initialized();
    let toJSONCalls = 0;
    const withToJSON = {
      threadId, status: "paused", objective: "Must not serialize.",
      toJSON() { toJSONCalls += 1; return { threadId, status: "active", objective: "malicious" }; },
    };
    await expect(value.client.request("thread/goal/set", withToJSON)).rejects.toThrow();
    expect(toJSONCalls).toBe(0);

    let getterCalls = 0;
    const withGetter = { threadId, objective: "Must not read an accessor." };
    Object.defineProperty(withGetter, "status", {
      enumerable: true,
      get() { getterCalls += 1; return "paused"; },
    });
    await expect(value.client.request("thread/goal/set", withGetter)).rejects.toThrow();
    expect(getterCalls).toBe(0);

    await expect(value.client.request("thread/goal/set", {
      threadId, status: "paused", objective: "Known fields only.", unexpected: true,
    })).rejects.toThrow();
    const inherited = Object.assign(Object.create({ injected: true }), { threadId, status: "paused" });
    await expect(value.client.request("thread/goal/set", inherited)).rejects.toThrow();
    expect(value.messages).toHaveLength(2);
  });

  it.each([
    ["non-UUID thread ID", { threadId: "thread-1", status: "paused", objective: "Valid objective." }],
    ["blank objective", { threadId, status: "paused", objective: "  " }],
    ["oversized objective", { threadId, status: "paused", objective: "x".repeat(4_001) }],
  ])("rejects %s before writing a goal", async (_label, params) => {
    const value = await initialized();
    await expect(value.client.request("thread/goal/set", params)).rejects.toThrow();
    expect(value.messages).toHaveLength(2);
  });

  it("accepts null or positive-integer tokenBudget and rejects other values before writing", async () => {
    for (const tokenBudget of [null, 128]) {
      const value = await initialized();
      const params = { threadId, status: "paused", tokenBudget };
      const pending = value.client.request("thread/goal/set", params);
      await value.waitFor(3);
      expect(value.messages[2]?.params).toEqual(params);
      respond(value, 2, { goal: params });
      await expect(pending).resolves.toEqual({ goal: params });
    }
    for (const tokenBudget of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "128"]) {
      const value = await initialized();
      await expect(value.client.request("thread/goal/set", { threadId, status: "paused", tokenBudget })).rejects.toThrow();
      expect(value.messages).toHaveLength(2);
    }
  });

  it("rejects runtime-cast turn/start and command methods without writing them", async () => {
    const value = await initialized();
    for (const method of ["turn/start", "shell/exec", "command/exec"]) {
      await expect(value.client.request(method as "thread/goal/get", {})).rejects.toThrow(/unsupported|probe|method|permits/i);
    }
    expect(value.messages).toHaveLength(2);
  });

  it("denies server tool requests generically and keeps the connection read-only", async () => {
    const value = await initialized();
    value.send({ id: 70, method: "servertool/request", params: { name: "execute", payload: "private" } });
    await value.waitFor(3);
    expect(value.messages[2]).toEqual({
      id: 70, error: { code: -32601, message: expect.any(String) },
    });
    expect(JSON.stringify(value.messages[2])).not.toContain("private");
    const pending = value.client.request("thread/goal/get", { threadId: "thread-1" });
    await value.waitFor(4);
    respond(value, 2, { goal: { status: "paused", objective: "Current objective." } });
    await expect(pending).resolves.toEqual({ goal: { status: "paused", objective: "Current objective." } });
  });

  it("does not retry a failed first reply and close prevents later writes", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/goal/get", { threadId: "thread-1" });
    const rejected = expect(pending).rejects.toThrow();
    await value.waitFor(3);
    value.send({ id: 2, error: { code: -32000, message: "private provider failure" } });
    await rejected;
    expect(value.messages.filter(message => message.method === "thread/goal/get")).toHaveLength(1);
    value.client.close();
    value.client.close();
    await expect(value.client.request("thread/goal/get", { threadId: "thread-1" })).rejects.toThrow();
    expect(value.messages.filter(message => message.method === "thread/goal/get")).toHaveLength(1);
    expect(value.input.destroyed).toBe(false);
    expect(value.output.destroyed).toBe(false);
  });
});
