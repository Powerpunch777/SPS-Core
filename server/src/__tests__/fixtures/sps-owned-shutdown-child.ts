import { createReadStream } from "node:fs";
import { attachSpsOwnedShutdown } from "../../services/sps-owned-shutdown.js";

const request = { v: 1, kind: "sps.owner-host.shutdown" };
let shutdownCount = 0;
const pipeMode = process.argv.includes("--pipe");
const canAttachStopPipe = pipeMode
  && process.connected === true
  && typeof process.send === "function"
  && process.env.SPS_DESKTOP_OWNED_SHUTDOWN_PIPE === "1";
const stopPipe = canAttachStopPipe
  ? createReadStream(null as unknown as string, { fd: 4, autoClose: true })
  : undefined;

attachSpsOwnedShutdown(process, async () => {
  shutdownCount += 1;
  if (pipeMode) {
    setImmediate(() => {
      process.exitCode = shutdownCount === 1 ? 0 : 71;
    });
  }
}, stopPipe);

if (!pipeMode) {
  process.once("disconnect", () => {
    process.emit("message", request);
    setImmediate(() => {
      process.exitCode = shutdownCount === 1 ? 0 : 71;
    });
  });
}

process.send?.("ready");
