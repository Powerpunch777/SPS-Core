import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

type ActualRequest = { method: string; target: string; body: Buffer; cookie: string; contentType: string };
type Reader = { read(proof: string, actual: ActualRequest, signal?: AbortSignal): Promise<unknown> };
const FAILURE = "Native Workspace access is unavailable.";
const INBOX_STATE_TARGET = /^\/api\/companies\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/workspace-inbox\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

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
    const controller = new AbortController();
    const onClose = () => { if (!response.writableFinished) controller.abort(); };
    response.once("close", onClose);
    let admitted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      checkCurrent();
      if (request.socket.remoteAddress !== "127.0.0.1"
        || (request.method !== "GET" && request.method !== "PATCH" && request.method !== "POST")
        || typeof request.url !== "string" || pending >= 4) throw new Error(FAILURE);
      const patchState = request.method === "PATCH" && INBOX_STATE_TARGET.test(request.url);
      const pluginRequest = request.method === "POST" && request.url === "/sps-native/v1/plugin-runtime";
      if (request.method === "POST" && !pluginRequest) throw new Error(FAILURE);
      if (request.method === "PATCH" && !patchState) throw new Error(FAILURE);
      const transferEncoding = singleHeader(request, "transfer-encoding", false);
      const contentLengthText = singleHeader(request, "content-length", false);
      if (transferEncoding
        || (pluginRequest ? !/^[1-9][0-9]{0,4}$/.test(contentLengthText) || Number(contentLengthText) > 64 * 1024 : patchState
          ? !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(contentLengthText)
          : !["", "0"].includes(contentLengthText))
        || ["authorization", "x-sps-desktop-access", "x-sps-desktop-owner-bootstrap"]
          .some(name => Object.hasOwn(request.headers, name))) throw new Error(FAILURE);
      const proof = singleHeader(request, "x-sps-native-workspace-proof");
      const cookie = singleHeader(request, "cookie");
      const contentType = singleHeader(request, "content-type", false);
      if (patchState || pluginRequest ? contentType !== "application/json" : contentType !== "") throw new Error(FAILURE);
      pending++;
      admitted = true;
      timer = setTimeout(() => { controller.abort(); response.destroy(); }, 10_000);
      let body = Buffer.alloc(0);
      if (patchState || pluginRequest) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += part.length;
          if (bytes > (pluginRequest ? 64 * 1024 : 128)) throw new Error(FAILURE);
          chunks.push(part);
        }
        if (bytes !== Number(contentLengthText)) throw new Error(FAILURE);
        body = Buffer.concat(chunks, bytes);
      }
      const actual = {
        method: request.method, target: request.url, body, cookie, contentType,
      };
      const result = await (pluginRequest ? reader.read(proof, actual, controller.signal) : reader.read(proof, actual));
      checkCurrent();
      if (request.aborted || response.destroyed) return;
      const json = JSON.stringify(result);
      const assetRequest = pluginRequest && JSON.parse(body.toString("utf8")).operation === "asset";
      if (typeof json !== "string" || Buffer.byteLength(json) > (assetRequest ? 6 * 1024 * 1024 : 256 * 1024)) throw new Error(FAILURE);
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Connection": "close",
        "Content-Length": String(Buffer.byteLength(json)),
      });
      response.end(json);
    } catch {
      if (!response.destroyed && !response.headersSent) {
        response.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close" });
        response.end(JSON.stringify({ error: FAILURE }));
      } else response.destroy();
    } finally {
      controller.abort(); response.removeListener("close", onClose);
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
