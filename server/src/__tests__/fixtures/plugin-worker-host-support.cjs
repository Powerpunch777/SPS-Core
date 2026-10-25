const readline = require("node:readline");
let support;
const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  let result;
  if (request.method === "initialize") {
    support = request.params?.spsHost;
    result = { ok: true, supportedMethods: ["getData"] };
  } else if (request.method === "getData") {
    result = { support };
  } else if (request.method === "shutdown") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }) + "\n");
    setImmediate(() => process.exit(0));
    return;
  } else {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown fixture method" } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
