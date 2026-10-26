import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpsNativeWorkspaceHttpServer } from "../services/sps-native-workspace-http.js";

const owned: Array<ReturnType<typeof createSpsNativeWorkspaceHttpServer>> = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(server => server.dispose())); });

function call(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: unknown; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: options.method ?? "GET",
      path: options.path ?? "/api/companies/22222222-2222-4222-8222-222222222222/workspace-shell", agent: false,
      headers: { "X-SPS-Native-Workspace-Proof": "test-proof", Cookie: "test-cookie", ...options.headers },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.once("error", reject);
      res.once("end", () => {
        try { resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()), headers: res.headers }); }
        catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.end(options.body);
  });
}

describe("private Native Workspace HTTP adapter", () => {
  it("binds only ephemeral IPv4 loopback and delegates exact bytes without Owner credentials", async () => {
    const read = vi.fn(async () => ({ mode: "neutral" }));
    const server = createSpsNativeWorkspaceHttpServer({ reader: { read }, assertCurrent() {} });
    owned.push(server);
    const first = server.start();
    expect(server.start()).toBe(first);
    const address = await first;
    expect(server.isAvailable()).toBe(true);
    expect(address.host).toBe("127.0.0.1");
    expect(address.port).toBeGreaterThan(0);
    const response = await call(address.port);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ mode: "neutral" });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.connection).toBe("close");
    expect(read).toHaveBeenCalledWith("test-proof", {
      method: "GET", target: "/api/companies/22222222-2222-4222-8222-222222222222/workspace-shell",
      body: Buffer.alloc(0), cookie: "test-cookie", contentType: "",
    });
  });

  it("denies body-bearing or privileged requests before calling the authenticated reader", async () => {
    const read = vi.fn(async () => ({ secret: "must not be returned" }));
    const server = createSpsNativeWorkspaceHttpServer({ reader: { read }, assertCurrent() {} });
    owned.push(server);
    const { port } = await server.start();
    for (const options of [
      { method: "POST" },
      { headers: { Authorization: "" } },
      { headers: { "X-SPS-Desktop-Access": "local-owner-secret" } },
      { headers: { "X-SPS-Desktop-Owner-Bootstrap": "local-owner-secret" } },
      { headers: { "Content-Type": "application/json" } },
      { headers: { "Content-Length": "2" }, body: "{}" },
    ]) {
      const response = await call(port, options);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Native Workspace access is unavailable." });
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("frames only bounded inbox-state PATCH bodies and rejects PATCH on every other path", async () => {
    const read = vi.fn(async (_proof: string, actual: { method: string; target: string; body: Buffer; cookie: string; contentType: string }) => ({
      method: actual.method, target: actual.target, body: actual.body.toString("utf8"), contentType: actual.contentType,
    }));
    const server = createSpsNativeWorkspaceHttpServer({ reader: { read }, assertCurrent() {} });
    owned.push(server);
    const { port } = await server.start();
    const target = "/api/companies/22222222-2222-4222-8222-222222222222/workspace-inbox/33333333-3333-4333-8333-333333333333";
    const body = '{"read":true}';
    const response = await call(port, {
      method: "PATCH",
      path: target,
      body,
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ method: "PATCH", target, body, contentType: "application/json" });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[1].body).toEqual(Buffer.from(body));

    for (const options of [
      { method: "PATCH", path: "/api/companies/22222222-2222-4222-8222-222222222222/workspace-dashboard", body, headers: { "Content-Type": "application/json" } },
      { method: "PATCH", path: target, body: "x".repeat(129), headers: { "Content-Type": "application/json" } },
      { method: "PATCH", path: target, body, headers: { "Content-Type": "text/plain" } },
    ]) {
      expect(await call(port, options)).toMatchObject({ status: 403, body: { error: "Native Workspace access is unavailable." } });
    }
    expect(read).toHaveBeenCalledOnce();
  });

  it("does not publish a completed read after parent authority changes", async () => {
    let current = true;
    const read = vi.fn(async () => { current = false; return { secret: "stale data" }; });
    const server = createSpsNativeWorkspaceHttpServer({ reader: { read },
      assertCurrent() { if (!current) throw new Error("private parent detail"); },
    });
    owned.push(server);
    const { port } = await server.start();
    expect(await call(port)).toMatchObject({ status: 403, body: { error: "Native Workspace access is unavailable." } });
    expect(() => server.start()).toThrow();
  });

  it("joins in-flight reads on disposal and never returns their result to a closed socket", async () => {
    let release!: () => void;
    let entered!: () => void;
    const began = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createSpsNativeWorkspaceHttpServer({ reader: { async read() {
      entered(); await gate; return { secret: "discarded" };
    } }, assertCurrent() {} });
    owned.push(server);
    const { port } = await server.start();
    const result = call(port).then(() => "published", () => "closed");
    await began;
    let stopped = false;
    const stop = server.dispose().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(await result).toBe("closed");
    expect(server.dispose()).toBe(server.dispose());
    expect(() => server.start()).toThrow();
  });

  it("bounds serialized responses and hides reader failures", async () => {
    const read = vi.fn().mockResolvedValueOnce({ huge: "x".repeat(256 * 1024) })
      .mockRejectedValueOnce(new Error("private database details"));
    const server = createSpsNativeWorkspaceHttpServer({ reader: { read }, assertCurrent() {} });
    owned.push(server);
    const { port } = await server.start();
    for (let index = 0; index < 2; index++) expect(await call(port))
      .toMatchObject({ status: 403, body: { error: "Native Workspace access is unavailable." } });
  });

  it("awaits listener closure when disposal races startup", async () => {
    const server = createSpsNativeWorkspaceHttpServer({ reader: { async read() { return {}; } }, assertCurrent() {} });
    owned.push(server);
    const started = server.start();
    const stopping = server.dispose();
    await expect(started).rejects.toThrow();
    await stopping;
    expect(server.isAvailable()).toBe(false);
    expect(() => server.start()).toThrow();
  });

  it("publishes no endpoint when authority is lost during bind and can dispose before start", async () => {
    let checks = 0;
    const server = createSpsNativeWorkspaceHttpServer({ reader: { async read() { return {}; } },
      assertCurrent() { if (++checks > 1) throw new Error("authority changed"); },
    });
    owned.push(server);
    await expect(server.start()).rejects.toThrow();
    await server.dispose();
    expect(server.isAvailable()).toBe(false);
    const neverStarted = createSpsNativeWorkspaceHttpServer({ reader: { async read() { return {}; } }, assertCurrent() {} });
    owned.push(neverStarted);
    await neverStarted.dispose();
    expect(neverStarted.isAvailable()).toBe(false);
  });
});
