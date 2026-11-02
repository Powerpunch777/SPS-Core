const readline = require("node:readline");
const pendingHandshakeCalls = new Map();
let nextHandshakeId = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message && pendingHandshakeCalls.has(message.id)) {
    const original = pendingHandshakeCalls.get(message.id);
    pendingHandshakeCalls.delete(message.id);
    send({
      jsonrpc: "2.0",
      id: original.id,
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "ok\n",
        stderr: "",
      },
    });
    return;
  }
  const method = message && typeof message.method === "string" ? message.method : null;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        ok: true,
        supportedMethods: ["environmentExecute"],
      },
    });
    return;
  }

  if (method === "environmentExecute") {
    if (message.params?.testHandshake === true) {
      const id = `test-handshake-${nextHandshakeId++}`;
      pendingHandshakeCalls.set(id, message);
      send({
        jsonrpc: "2.0",
        id,
        method: "config.get",
        params: {},
        ...(message.paperclipInvocation?.id
          ? { paperclipInvocationId: message.paperclipInvocation.id }
          : {}),
      });
      return;
    }
    const delayMs = Number(message.params?.delayMs ?? 0);
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "ok\n",
          stderr: "",
        },
      });
    }, delayMs);
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
