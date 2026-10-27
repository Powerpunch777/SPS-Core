const readline = require("node:readline");

let nextRequestId = 1;
const pendingNested = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendNestedHostRequest(originalRequest, invocationId) {
  const nestedId = `nested-${nextRequestId++}`;
  const params = originalRequest.params?.params ?? originalRequest.params?.job ?? {};
  const mode = params.mode;
  const requestedCompanyId = params.requestedCompanyId;
  const nestedRequest = {
    jsonrpc: "2.0",
    id: nestedId,
    method: "companies.get",
    params: {
      companyId: requestedCompanyId,
    },
  };

  if (mode === "echo" || mode === "waitEcho") {
    nestedRequest.paperclipInvocationId = invocationId;
  } else if (mode === "unknown") {
    nestedRequest.paperclipInvocationId = "unknown-invocation";
  } else if (mode === "late") {
    nestedRequest.paperclipInvocationId = invocationId;
  }

  pendingNested.set(nestedId, { originalId: originalRequest.id, originalRequest });
  send(nestedRequest);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id && pendingNested.has(message.id)) {
    const pending = pendingNested.get(message.id);
    pendingNested.delete(message.id);
    if (message.error) {
      send({
        jsonrpc: "2.0",
        id: pending.originalId,
        error: message.error,
      });
      return;
    }

    send({
      jsonrpc: "2.0",
      id: pending.originalId,
      result: message.result,
    });
    const originalRequest = pending.originalRequest;
    if (originalRequest?.params?.params?.mode === "late") {
      setTimeout(() => sendNestedHostRequest(originalRequest, originalRequest.paperclipInvocation?.id), 10);
    }
    return;
  }

  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["getData", "performAction", "runJob"],
      },
    });
    return;
  }

  if (method === "getData" || method === "performAction" || method === "runJob") {
    const mode = message.params?.params?.mode ?? message.params?.job?.mode;
    if (mode === "returnInvocation") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { invocationId: message.paperclipInvocation?.id },
      });
      return;
    }
    if (mode === "waitThenCall" || mode === "waitEcho") {
      setTimeout(() => sendNestedHostRequest(message, message.paperclipInvocation?.id), Number(message.params?.params?.delayMs ?? 50));
      return;
    }
    if (mode === "stream") {
      send({
        jsonrpc: "2.0",
        method: "streams.emit",
        params: {
          channel: "guard-test",
          companyId: message.params?.companyId,
          event: { type: "guard-test" },
        },
        paperclipInvocationId: message.paperclipInvocation?.id,
      });
      setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { ok: true } }), 10);
      return;
    }
    sendNestedHostRequest(message, message.paperclipInvocation?.id);
    return;
  }

  if (method === "shutdown") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    setImmediate(() => process.exit(0));
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: {
      code: -32601,
      message: `Unhandled method: ${method}`,
    },
  });
});
