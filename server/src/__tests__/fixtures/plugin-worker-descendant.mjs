import { spawn } from "node:child_process";

let buffered = "";
let descendant;

function writeResponse(id, result, onWritten) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`, onWritten);
}

function startDescendant() {
  const childCode = [
    "const net = require('node:net');",
    "const socket = net.connect(Number(process.env.SPS_TEST_HEARTBEAT_PORT), '127.0.0.1', () => {",
    "  const beat = () => socket.write(process.env.SPS_TEST_HEARTBEAT_NONCE + '\\n');",
    "  beat();",
    "  setInterval(beat, 75);",
    "});",
    "socket.on('error', () => process.exit(1));",
  ].join("\n");

  descendant = spawn(process.execPath, ["-e", childCode], {
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT || "C:\\Windows",
      WINDIR: process.env.WINDIR || process.env.SYSTEMROOT || "C:\\Windows",
      SPS_TEST_HEARTBEAT_PORT: process.env.SPS_TEST_HEARTBEAT_PORT ?? "",
      SPS_TEST_HEARTBEAT_NONCE: process.env.SPS_TEST_HEARTBEAT_NONCE ?? "",
    },
    stdio: "ignore",
    windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    descendant.once("spawn", resolve);
    descendant.once("error", reject);
  });
}

async function handleMessage(message) {
  if (message.method === "initialize") {
    await startDescendant();
    writeResponse(message.id, { ok: true, supportedMethods: ["health"] });
    return;
  }
  if (message.method === "health") {
    if (message.params?.crash === true) {
      writeResponse(message.id, { alive: true }, () => setTimeout(() => process.exit(17), 0));
      return;
    }
    writeResponse(message.id, { alive: true });
    return;
  }
  if (message.method === "shutdown") {
    // Leave the ignored-stdio descendant running. The owner must close the
    // complete process tree before acknowledging worker shutdown.
    writeResponse(message.id, {}, () => process.exit(0));
    return;
  }
  writeResponse(message.id, null);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  for (;;) {
    const newline = buffered.indexOf("\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    try {
      const message = JSON.parse(line);
      if (message && typeof message === "object" && (typeof message.id === "string" || typeof message.id === "number")) {
        void handleMessage(message).catch(() => process.exit(1));
      }
    } catch {
      process.exit(1);
    }
  }
});
