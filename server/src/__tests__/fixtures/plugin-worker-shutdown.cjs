const fs = require("node:fs");
const readline = require("node:readline");

function mark(path) {
  if (path) fs.writeFileSync(path, "ready");
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

if (process.env.SPS_TEST_PID_FILE) {
  fs.appendFileSync(process.env.SPS_TEST_PID_FILE, `${process.pid}\n`);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    mark(process.env.SPS_TEST_INITIALIZE_MARKER);
    if (process.env.SPS_TEST_EXIT_DURING_INITIALIZE === "1") {
      process.exit(1);
      return;
    }

    const delayMs = Number(process.env.SPS_TEST_INITIALIZE_DELAY_MS ?? 0);
    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          ok: process.env.SPS_TEST_FAIL_INITIALIZE !== "1",
          supportedMethods: [],
        },
      });
    }, delayMs);
    return;
  }

  if (message.method === "shutdown") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    mark(process.env.SPS_TEST_SHUTDOWN_MARKER);
    const delayMs = Number(process.env.SPS_TEST_SHUTDOWN_EXIT_DELAY_MS ?? 0);
    setTimeout(() => process.exit(0), delayMs);
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unhandled method: ${message.method}` },
  });
});
