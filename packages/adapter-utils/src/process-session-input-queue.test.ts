import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProcessSessionInputQueue } from "./process-session-input-queue.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("process session input queue", () => {
  it("publishes stdin and EOF frames in receive order after each publish completes", async () => {
    const firstPublish = deferred<void>();
    const calls: Array<[string, string]> = [];
    const publish = vi.fn((filePath: string, body: string) => {
      calls.push([filePath, body]);
      return calls.length === 1 ? firstPublish.promise : Promise.resolve();
    });
    const queue = createProcessSessionInputQueue({ stdinDir: "/session/stdin", publish });

    const first = queue.write({ type: "stdin", data: "SGVsbG8g4pyT" });
    const second = queue.write({ type: "stdin", data: "bmV4dA==" });
    const eof = queue.write({ type: "stdinEnd" });

    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    expect(calls.map(([filePath]) => path.posix.basename(filePath))).toEqual(["000000000001.json"]);

    firstPublish.resolve();
    await Promise.all([first, second, eof]);

    expect(calls.map(([filePath]) => path.posix.basename(filePath))).toEqual([
      "000000000001.json",
      "000000000002.json",
      "000000000003.json",
    ]);
    expect(calls.map(([, body]) => JSON.parse(body))).toEqual([
      { type: "stdin", data: "SGVsbG8g4pyT" },
      { type: "stdin", data: "bmV4dA==" },
      { type: "stdinEnd" },
    ]);
  });

  it("propagates a failed publish to EOF without publishing it", async () => {
    const firstPublish = deferred<void>();
    const failure = new Error("stdin publication failed");
    const publish = vi.fn(() => firstPublish.promise);
    const queue = createProcessSessionInputQueue({ stdinDir: "/session/stdin", publish });

    const first = queue.write({ type: "stdin", data: "cGF5bG9hZA==" });
    const eof = queue.write({ type: "stdinEnd" });
    const settled = Promise.all([first, eof].map(promise => promise.then(
      () => ({ error: null }),
      error => ({ error }),
    )));

    await Promise.resolve();
    expect(publish).toHaveBeenCalledTimes(1);
    firstPublish.reject(failure);
    const results = await settled;

    expect(results.map(result => result.error)).toEqual([failure, failure]);
    expect(results[0].error).toBe(failure);
    expect(results[1].error).toBe(failure);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("waits for an EOF publish before resolving its returned promise", async () => {
    const eofPublish = deferred<void>();
    const publish = vi.fn(() => eofPublish.promise);
    const queue = createProcessSessionInputQueue({ stdinDir: "/session/stdin", publish });
    let settled = false;
    const eof = queue.write({ type: "stdinEnd" }).then(() => { settled = true; });

    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
    expect(settled).toBe(false);

    eofPublish.resolve();
    await eof;
    expect(settled).toBe(true);
  });

  it("snapshots a frame before the caller can mutate it", async () => {
    const published: string[] = [];
    const queue = createProcessSessionInputQueue({
      stdinDir: "/session/stdin",
      publish: async (_filePath, body) => { published.push(body); },
    });
    const frame = { type: "stdin" as const, data: "original-base64" };

    const write = queue.write(frame);
    frame.data = "mutated-base64";
    await write;

    expect(published).toEqual(['{"type":"stdin","data":"original-base64"}\n']);
  });

  it("waits for uploads before publishing one idempotent cleanup EOF and rejects later writes", async () => {
    const upload = deferred<void>();
    const published: string[] = [];
    const publish = vi.fn((_filePath: string, body: string) => {
      published.push(body);
      return published.length === 1 ? upload.promise : Promise.resolve();
    });
    const queue = createProcessSessionInputQueue({ stdinDir: "/session/stdin", publish });

    const stdin = queue.write({ type: "stdin", data: "upload" });
    const finishing = queue.finish();
    const repeatedFinish = queue.finish();
    const rejectedWrite = queue.write({ type: "stdin", data: "too-late" });
    const rejectedWriteResult = rejectedWrite.then(
      () => null,
      error => error,
    );

    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
    expect(finishing).toBe(repeatedFinish);
    expect(published.map(body => JSON.parse(body))).toEqual([
      { type: "stdin", data: "upload" },
    ]);
    expect(await rejectedWriteResult).toBeInstanceOf(Error);

    upload.resolve();
    await Promise.all([stdin, finishing]);
    expect(published.map(body => JSON.parse(body))).toEqual([
      { type: "stdin", data: "upload" },
      { type: "stdinEnd" },
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("preserves failed input and normal EOF while finish sends a separate cleanup EOF", async () => {
    const firstPublish = deferred<void>();
    const failure = new Error("stdin publication failed");
    const published: string[] = [];
    const publish = vi.fn((_filePath: string, body: string) => {
      published.push(body);
      return published.length === 1 ? firstPublish.promise : Promise.resolve();
    });
    const queue = createProcessSessionInputQueue({ stdinDir: "/session/stdin", publish });

    const stdin = queue.write({ type: "stdin", data: "cGF5bG9hZA==" });
    const normalEof = queue.write({ type: "stdinEnd" });
    const inputResults = Promise.all([stdin, normalEof].map(promise => promise.then(
      () => ({ error: null }),
      error => ({ error }),
    )));
    const cleanupEof = queue.finish();
    const cleanupResult = cleanupEof.then(
      () => ({ error: null }),
      error => ({ error }),
    );

    await Promise.resolve();
    expect(publish).toHaveBeenCalledOnce();
    firstPublish.reject(failure);
    const [inputs, cleanup] = await Promise.all([inputResults, cleanupResult]);

    expect(inputs.map(result => result.error)).toEqual([failure, failure]);
    expect(inputs[0].error).toBe(failure);
    expect(inputs[1].error).toBe(failure);
    expect(cleanup.error).toBeNull();
    expect(published.map(body => JSON.parse(body))).toEqual([
      { type: "stdin", data: "cGF5bG9hZA==" },
      { type: "stdinEnd" },
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
