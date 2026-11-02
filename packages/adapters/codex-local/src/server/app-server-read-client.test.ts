import { PassThrough } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerReadClient } from "./app-server-read-client.js";

type WireMessage = Record<string, unknown>;
interface ClientFixture {
  input: PassThrough;
  output: PassThrough;
  client: ReturnType<typeof createCodexAppServerReadClient>;
  messages: WireMessage[];
  waitFor(count: number): Promise<void>;
  send(message: unknown): void;
  sendRaw(frame: string | Buffer): void;
}

const fixtures: ClientFixture[] = [];

function fixture(
  options: { timeoutMs?: number; maxFrameBytes?: number } = {},
  configureInput?: (input: PassThrough) => void,
): ClientFixture {
  const input = new PassThrough();
  configureInput?.(input);
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
  const client = createCodexAppServerReadClient({ input, output, ...options });
  const value = {
    input,
    output,
    client,
    messages,
    waitFor(count: number) {
      if (messages.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => waiters.push({ count, resolve }));
    },
    send(message: unknown) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(frame: string | Buffer) {
      input.write(frame);
    },
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
  value.send({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "fixture" } } });
  await expect(handshake).resolves.toEqual({ serverInfo: { name: "fixture" } });
  await value.waitFor(2);
  expect(value.messages[1]).toEqual({ method: "initialized", params: {} });
  return value;
}

function response(value: ClientFixture, id: number, result: unknown) {
  value.send({ jsonrpc: "2.0", id, result });
}

afterEach(() => {
  for (const value of fixtures.splice(0)) value.client.close();
  vi.useRealTimers();
});

describe("createCodexAppServerReadClient", () => {
  it("performs the exact read-only initialization handshake", async () => {
    const value = fixture();
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
    response(value, 1, { protocolVersion: "fixture" });
    await expect(handshake).resolves.toEqual({ protocolVersion: "fixture" });
    await value.waitFor(2);
    expect(value.messages[1]).toEqual({ method: "initialized", params: {} });
    expect(value.messages[1]).not.toHaveProperty("id");
  });

  it("makes initialize idempotent and shares the in-flight handshake", async () => {
    const value = fixture();
    const first = value.client.initialize();
    const second = value.client.initialize();
    expect(second).toBe(first);
    await value.waitFor(1);
    expect(value.messages.filter(message => message.method === "initialize")).toHaveLength(1);
    response(value, 1, { ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    await value.waitFor(2);
    expect(value.messages.filter(message => message.method === "initialized")).toHaveLength(1);
  });

  it("rejects requests before initialize succeeds without writing them", async () => {
    const value = fixture();
    await expect(value.client.request("thread/list", {})).rejects.toThrow(/initialize/i);
    expect(value.messages).toEqual([]);
  });

  it("sends allowlisted read requests with their params and returns the matching result", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/read", { threadId: "thread-1", includeTurns: true });
    await value.waitFor(3);
    expect(value.messages[2]).toEqual({
      id: 2, method: "thread/read", params: { threadId: "thread-1", includeTurns: true },
    });
    response(value, 2, { thread: { id: "thread-1" } });
    await expect(pending).resolves.toEqual({ thread: { id: "thread-1" } });
  });

  it.each(["thread/list", "thread/read", "thread/turns/list", "thread/items/list"] as const)(
    "supports read method %s only after initialization",
    async method => {
      const value = await initialized();
      const pending = value.client.request(method, { cursor: "safe-cursor" });
      await value.waitFor(3);
      expect(value.messages[2]).toMatchObject({ id: 2, method, params: { cursor: "safe-cursor" } });
      response(value, 2, { data: [] });
      await expect(pending).resolves.toEqual({ data: [] });
    },
  );

  it("does not expose shell or thread/turn creation through the request API", async () => {
    const value = await initialized();
    for (const method of ["shell/exec", "thread/start", "thread/turn/start"]) {
      await expect(value.client.request(method as "thread/read", {})).rejects.toThrow(/unsupported|read-only|only permits|method/i);
    }
    expect(value.messages).toHaveLength(2);
  });

  it("decodes fragmented UTF-8 frames and accepts CRLF delimiters", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/read", { threadId: "t" });
    await value.waitFor(3);
    const frame = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { title: "한글😀" } })}\r\n`);
    for (const byte of frame) value.sendRaw(Buffer.from([byte]));
    await expect(pending).resolves.toEqual({ title: "한글😀" });
  });

  it("ignores well-formed notifications while still resolving the matching response", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/list", {});
    await value.waitFor(3);
    value.send({ jsonrpc: "2.0", method: "turn/completed", params: { secret: "notification payload" } });
    response(value, 2, { threads: [] });
    await expect(pending).resolves.toEqual({ threads: [] });
    expect(value.messages).toHaveLength(3);
  });

  it("denies unknown server requests without executing them or closing the connection", async () => {
    const value = await initialized();
    value.send({ jsonrpc: "2.0", id: 71, method: "thread/start", params: { prompt: "must not execute" } });
    await value.waitFor(3);
    expect(value.messages[2]).toMatchObject({ id: 71, error: { code: -32601 } });
    expect(JSON.stringify(value.messages[2])).not.toContain("must not execute");
    const pending = value.client.request("thread/list", {});
    await value.waitFor(4);
    response(value, 2, { threads: [] });
    await expect(pending).resolves.toEqual({ threads: [] });
  });

  it("rejects JSON-RPC error replies without echoing provider payloads", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/read", {});
    const rejected = pending.then(
      () => { throw new Error("Expected the protocol error to reject the request."); },
      error => error,
    );
    await value.waitFor(3);
    value.send({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "secret provider payload", data: { token: "secret" } } });
    const error = await rejected;
    expect(String(error)).not.toContain("secret provider payload");
    expect(String(error)).not.toContain("secret");
    const next = value.client.request("thread/list", {});
    await value.waitFor(4);
    response(value, 3, { threads: [] });
    await expect(next).resolves.toEqual({ threads: [] });
  });

  it("treats malformed JSON and fatal UTF-8 as terminal without echoing frame contents", async () => {
    for (const badFrame of ["{private malformed payload}\n", Buffer.from([0xc3, 0x28, 0x0a])]) {
      const value = await initialized();
      const pending = value.client.request("thread/list", {});
      const rejected = expect(pending).rejects.toThrow();
      await value.waitFor(3);
      value.sendRaw(badFrame);
      await rejected;
      await expect(value.client.request("thread/read", {})).rejects.toThrow();
      expect(value.messages.some(message => JSON.stringify(message).includes("private malformed payload"))).toBe(false);
    }
  });

  it("rejects pre-decoded streams where invalid UTF-8 could already have been replaced", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/read", {});
    const rejected = expect(pending).rejects.toThrow();
    await value.waitFor(3);
    value.input.setEncoding("utf8");
    value.sendRaw(Buffer.from([0xc3, 0x28, 0x0a]));
    await rejected;
    await expect(value.client.request("thread/list", {})).rejects.toThrow();
  });

  it.each([
    ["non-integer response ID", { jsonrpc: "2.0", id: "1", result: {} }],
    ["both result and error", { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "private" } }],
    ["neither result nor error", { jsonrpc: "2.0", id: 1 }],
    ["unexpected response fields", { jsonrpc: "2.0", id: 1, result: {}, providerPayload: "private" }],
    ["malformed error payload", { jsonrpc: "2.0", id: 1, error: { code: "bad", message: "private" } }],
  ])("treats malformed response envelope (%s) as terminal", async (_label, invalid) => {
    const value = fixture();
    const handshake = value.client.initialize();
    const rejected = expect(handshake).rejects.toThrow();
    await value.waitFor(1);
    value.send(invalid);
    await rejected;
    await expect(value.client.request("thread/list", {})).rejects.toThrow();
  });

  it("closes terminally on unknown and duplicate response IDs", async () => {
    const unknown = await initialized();
    const pendingUnknown = unknown.client.request("thread/list", {});
    const unknownRejected = expect(pendingUnknown).rejects.toThrow();
    await unknown.waitFor(3);
    response(unknown, 999, {});
    await unknownRejected;
    await expect(unknown.client.request("thread/read", {})).rejects.toThrow();

    const duplicate = await initialized();
    const pendingDuplicate = duplicate.client.request("thread/list", {});
    await duplicate.waitFor(3);
    response(duplicate, 2, { ok: true });
    await expect(pendingDuplicate).resolves.toEqual({ ok: true });
    response(duplicate, 2, { ok: "duplicate" });
    await expect(duplicate.client.request("thread/read", {})).rejects.toThrow();
  });

  it("fails closed on a valid response frame larger than maxFrameBytes", async () => {
    const value = await initialized({ maxFrameBytes: 256 });
    const pending = value.client.request("thread/list", {});
    const rejected = expect(pending).rejects.toThrow();
    await value.waitFor(3);
    const frame = JSON.stringify({ id: 2, result: { payload: "x".repeat(300) } });
    expect(Buffer.byteLength(frame)).toBeGreaterThan(256);
    value.sendRaw(`${frame}\n`);
    await rejected;
    await expect(value.client.request("thread/read", {})).rejects.toThrow();
  });

  it("rejects an oversized valid outgoing request without writing it", async () => {
    const value = await initialized({ maxFrameBytes: 256 });
    const params = { payload: "x".repeat(300) };
    expect(Buffer.byteLength(JSON.stringify({ id: 2, method: "thread/read", params }) + "\n")).toBeGreaterThan(256);
    await expect(value.client.request("thread/read", params)).rejects.toThrow(/could not be sent/i);
    expect(value.messages).toHaveLength(2);
    await expect(value.client.request("thread/list", {})).rejects.toThrow();
  });

  it("accepts a single chunk whose individual valid frames fit though their sum exceeds the limit", async () => {
    const value = await initialized({ maxFrameBytes: 256 });
    const pending = [
      value.client.request("thread/read", { index: 0 }),
      value.client.request("thread/read", { index: 1 }),
      value.client.request("thread/read", { index: 2 }),
    ];
    await value.waitFor(5);
    const frames = pending.map((_, index) => Buffer.from(`${JSON.stringify({
      id: index + 2, result: { payload: "x".repeat(90) },
    })}\n`));
    expect(frames.every(frame => frame.byteLength - 1 < 256)).toBe(true);
    expect(Buffer.concat(frames).byteLength).toBeGreaterThan(256);
    value.sendRaw(Buffer.concat(frames));
    await expect(Promise.all(pending)).resolves.toEqual(Array.from({ length: 3 }, () => ({ payload: "x".repeat(90) })));
  });

  it("treats a blank line as a malformed frame and closes pending requests", async () => {
    const value = await initialized();
    const pending = value.client.request("thread/list", {});
    const rejected = expect(pending).rejects.toThrow();
    await value.waitFor(3);
    value.sendRaw("\n");
    await rejected;
    await expect(value.client.request("thread/read", {})).rejects.toThrow();
  });

  it.each(["destroyed", "ended"] as const)("rejects initialize immediately when input was already %s before construction", async state => {
    const input = new PassThrough();
    if (state === "destroyed") input.destroy();
    else {
      input.resume();
      input.end();
      await once(input, "end");
    }
    const inputDestroyedBeforeCreate = input.destroyed;
    const output = new PassThrough();
    const client = createCodexAppServerReadClient({ input, output });
    await expect(client.initialize()).rejects.toThrow();
    expect(output.readableLength).toBe(0);
    client.close();
    expect(input.destroyed).toBe(inputDestroyedBeforeCreate);
    expect(output.destroyed).toBe(false);
  });

  it("validates transport bounds", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    for (const timeoutMs of [9, 60_001, Number.NaN, Number.POSITIVE_INFINITY, 10.5]) {
      expect(() => createCodexAppServerReadClient({ input, output, timeoutMs })).toThrow();
    }
    for (const maxFrameBytes of [255, 8 * 1_024 * 1_024 + 1, Number.NaN, Number.POSITIVE_INFINITY, 256.5]) {
      expect(() => createCodexAppServerReadClient({ input, output, maxFrameBytes })).toThrow();
    }
  });

  it("limits concurrent requests to sixteen", async () => {
    const value = await initialized();
    const pending = Array.from({ length: 16 }, (_, index) => value.client.request("thread/list", { index }));
    const settled = Promise.all(pending);
    await expect(value.client.request("thread/list", { index: 16 })).rejects.toThrow(/pending|limit|capacity/i);
    await value.waitFor(18);
    for (let id = 2; id <= 17; id += 1) response(value, id, { id });
    await expect(settled).resolves.toEqual(Array.from({ length: 16 }, (_, index) => ({ id: index + 2 })));
  });

  it("makes a request timeout terminal and does not retry", async () => {
    const value = await initialized();
    vi.useFakeTimers();
    const first = value.client.request("thread/list", {});
    const second = value.client.request("thread/read", {});
    const firstRejected = first.then(
      () => { throw new Error("Expected the request timeout to reject."); }, error => error,
    );
    const secondRejected = second.then(
      () => { throw new Error("Expected the pending request to close."); }, error => error,
    );
    await value.waitFor(4);
    await vi.advanceTimersByTimeAsync(10_000);
    const [firstError, secondError] = await Promise.all([firstRejected, secondRejected]);
    expect(String(firstError)).toMatch(/timed out|timeout/i);
    expect(secondError).toBeInstanceOf(Error);
    await expect(value.client.request("thread/list", {})).rejects.toThrow();
    expect(value.messages.filter(message => message.method === "thread/list" || message.method === "thread/read"))
      .toEqual([
        { id: 2, method: "thread/list", params: {} },
        { id: 3, method: "thread/read", params: {} },
      ]);
  });

  it("close is idempotent, rejects every pending request, detaches only owned listeners, and leaves streams alive", async () => {
    const value = await initialized();
    const ownInputListener = () => {};
    const ownOutputListener = () => {};
    value.input.on("data", ownInputListener);
    value.output.on("drain", ownOutputListener);
    const inputListeners = value.input.listenerCount("data");
    const outputListeners = value.output.listenerCount("drain");
    const first = value.client.request("thread/list", {});
    const second = value.client.request("thread/read", {});
    const firstRejected = expect(first).rejects.toThrow();
    const secondRejected = expect(second).rejects.toThrow();
    await value.waitFor(4);
    value.client.close();
    value.client.close();
    await Promise.all([firstRejected, secondRejected]);
    expect(value.input.destroyed).toBe(false);
    expect(value.output.destroyed).toBe(false);
    expect(value.input.listenerCount("data")).toBeLessThan(inputListeners);
    expect(value.input.listenerCount("data")).toBeGreaterThanOrEqual(1);
    expect(value.output.listenerCount("drain")).toBe(outputListeners);
    value.input.off("data", ownInputListener);
    value.output.off("drain", ownOutputListener);
  });

  it.each(["end", "input error", "output error"] as const)("closes and rejects pending work after %s", async event => {
    const value = await initialized();
    const pending = value.client.request("thread/list", {});
    const rejected = expect(pending).rejects.toThrow();
    await value.waitFor(3);
    if (event === "end") value.input.end();
    else if (event === "input error") value.input.emit("error", new Error("private input failure"));
    else value.output.emit("error", new Error("private output failure"));
    await rejected;
    await expect(value.client.request("thread/read", {})).rejects.toThrow();
  });
});
