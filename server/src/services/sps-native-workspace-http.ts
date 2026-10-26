import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type ActualRequest = { method: string; target: string; body: Buffer; cookie: string; contentType: string };
type Reader = { read(proof: string, actual: ActualRequest): Promise<unknown> };
const FAILURE = "Native Workspace access is unavailable.";

function singleHeader(request: IncomingMessage, name: string, required = true): string {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? "");
  }
  if (values.length > 1 || (required && values.length !== 1)) throw new Error(FAILURE);
  return values[0] ?? "";
}

/** Private Core HTTP adapter, explicitly constructed by the owned-parent
 * composition only. This is not a public TLS listener or the full Workspace UI.
 * The supplied reader authenticates Main proof/session/device/membership and
 * owns the exact route manifest. No ordinary Core app or Owner proof is mounted.
 */
export function createSpsNativeWorkspaceHttpServer(options: {
  reader: Reader;
  assertCurrent(): void;
}) {
  if (!options || typeof options.reader?.read !== "function" || typeof options.assertCurrent !== "function") {
    throw new TypeError("Invalid private Native Workspace HTTP configuration.");
  }
  const reader = options.reader;
  const assertion = options.assertCurrent;
  let disposed = false;
  let pending = 0;
  let starting: Promise<Readonly<{ host: "127.0.0.1"; port: number }>> | undefined;
  let stopping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const sockets = new Set<Socket>();
  const operations = new Set<Promise<void>>();
  function checkCurrent() {
    if (disposed) throw new Error(FAILURE);
    const result = assertion() as unknown;
    if (result !== undefined) {
      if (result && typeof (result as { then?: unknown }).then === "function") void Promise.resolve(result).catch(() => {});
      throw new Error(FAILURE);
    }
    if (disposed) throw new Error(FAILURE);
  }

  const server = createServer({ maxHeaderSize: 16_384, requireHostHeader: true }, (request, response) => {
    const operation = handle(request, response);
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => {});
  });
  function closeListener() {
    if (!closing) closing = new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
        else resolve();
      });
    });
    return closing;
  }
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1;
  server.maxRequestsPerSocket = 1;
  server.maxConnections = 16;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(12_000, () => socket.destroy());
  });
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", () => {
    disposed = true;
    for (const socket of sockets) socket.destroy();
    void closeListener().catch(() => {});
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    let admitted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkCurrent();
      if (request.socket.remoteAddress !== "127.0.0.1" || request.method !== "GET"
        || typeof request.url !== "string" || pending >= 4) throw new Error(FAILURE);
      if (singleHeader(request, "transfer-encoding", false)
        || !["", "0"].includes(singleHeader(request, "content-length", false))
        || ["authorization", "x-sps-desktop-access", "x-sps-desktop-owner-bootstrap"]
          .some(name => Object.hasOwn(request.headers, name))) throw new Error(FAILURE);
      const proof = singleHeader(request, "x-sps-native-workspace-proof");
      const cookie = singleHeader(request, "cookie");
      const contentType = singleHeader(request, "content-type", false);
      if (contentType !== "") throw new Error(FAILURE);
      pending++;
      admitted = true;
      timer = setTimeout(() => response.destroy(), 10_000);
      const result = await reader.read(proof, {
        method: request.method, target: request.url, body: Buffer.alloc(0), cookie, contentType,
      });
      checkCurrent();
      if (request.aborted || response.destroyed) return;
      const json = JSON.stringify(result);
      if (typeof json !== "string" || Buffer.byteLength(json) > 256 * 1024) throw new Error(FAILURE);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Connection": "close",
      });
      response.end(json);
    } catch {
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
        response.end(JSON.stringify({ error: FAILURE }));
      } else response.destroy();
    } finally {
      if (timer) clearTimeout(timer);
      if (admitted) pending--;
    }
  }

  return Object.freeze({
    start() {
      checkCurrent();
      if (!starting) starting = new Promise((resolve, reject) => {
        const onError = () => { disposed = true; reject(new Error(FAILURE)); };
        server.once("error", onError);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", onError);
          try {
            checkCurrent();
            const address = server.address();
            if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new Error(FAILURE);
            resolve(Object.freeze({ host: "127.0.0.1", port: address.port }));
          } catch {
            void closeListener().catch(() => {});
            reject(new Error(FAILURE));
          }
        });
      });
      return starting;
    },
    isAvailable() {
      try { checkCurrent(); return server.listening; }
      catch { return false; }
    },
    dispose() {
      disposed = true;
      if (!stopping) stopping = (async () => {
        for (const socket of sockets) socket.destroy();
        if (starting) await starting.catch(() => {});
        await closeListener();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([...operations]),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error(FAILURE)), 12_000);
            }),
          ]);
        } finally { if (timer) clearTimeout(timer); }
      })();
      return stopping;
    },
  });
}
