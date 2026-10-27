const readline = require("node:readline");

let nextId = 1;
const pending = new Map();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(message.error.message ?? "Native connectivity call failed"));
      return;
    }
    request.resolve(message.result);
    return;
  }

  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["getData"] } });
    return;
  }

  if (message.method === "getData") {
    const invocationId = message.paperclipInvocation?.id;
    const publicSdkUrl = message.params?.params?.publicSdkUrl;
    if (typeof invocationId !== "string" || typeof publicSdkUrl !== "string") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "test invocation was incomplete" } });
      return;
    }
    void import(publicSdkUrl).then(({ createSpsRuntimeClient }) => {
      const runtime = createSpsRuntimeClient({
        request(operation, params) {
          const id = `native-connectivity-${nextId++}`;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send({ jsonrpc: "2.0", id, method: operation, params, paperclipInvocationId: invocationId });
          });
        },
      });
      return runtime.connectivity.current();
    }).then(result => {
      send({ jsonrpc: "2.0", id: message.id, result: { connectivity: result,
        nestedInvocationId: invocationId } });
    }).catch(error => {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: String(error?.message ?? error) } });
    });
    return;
  }

  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }

  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unhandled method: ${message.method}` } });
});
