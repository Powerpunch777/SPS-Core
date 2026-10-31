const readline = require("node:readline");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendStream(message, method, companyId) {
  send({
    jsonrpc: "2.0",
    method,
    params: {
      channel: "shared-channel",
      companyId,
      event: { type: "scope-test" },
    },
    paperclipInvocationId: message.paperclipInvocation?.id,
  });
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true, supportedMethods: ["getData"] } });
    return;
  }
  if (message.method === "getData") {
    const mode = message.params?.params?.mode;
    if (mode === "open") sendStream(message, "streams.open", message.params.companyId);
    else if (mode === "close") sendStream(message, "streams.close", message.params.companyId);
    else if (mode === "wrong-tenant") sendStream(message, "streams.emit", message.params?.params?.notificationCompanyId);
    else if (mode === "crash") {
      setTimeout(() => process.exit(17), 20);
      return;
    }
    setTimeout(() => send({ jsonrpc: "2.0", id: message.id, result: { ok: true } }), 20);
    return;
  }
  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    setImmediate(() => process.exit(0));
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
