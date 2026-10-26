import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

const STOP_PIPE_TOKEN = Buffer.from("sps.owner-host.shutdown/v1\n", "ascii");
const MAX_STOP_PIPE_BYTES = 64;

/** Only the process's existing direct parent channel and its opt-in stop-only pipe. */
export function attachSpsOwnedShutdown(
  channel: unknown,
  shutdown: () => Promise<void>,
  stopPipe?: Readable,
) {
  const parent = channel as EventEmitter & { connected?: boolean; send?: unknown };
  if (!(parent instanceof EventEmitter) || parent.connected !== true || typeof parent.send !== "function") {
    return () => {};
  }

  let requested = false;
  let disposed = false;
  let ipcListening = true;
  let pipeListening = Boolean(stopPipe);
  let pipeInvalid = false;
  let pipeBuffer = Buffer.alloc(0);
  const ignoreLatePipeError = () => {};

  const detachIpc = () => {
    if (!ipcListening) return;
    ipcListening = false;
    parent.removeListener("message", onMessage);
    parent.removeListener("disconnect", detachIpc);
  };

  const cleanupPipe = (destroy: boolean) => {
    if (!pipeListening || !stopPipe) return;
    pipeListening = false;
    stopPipe.removeListener("data", onPipeData);
    stopPipe.removeListener("end", onPipeEnd);
    stopPipe.removeListener("error", onPipeError);
    stopPipe.removeListener("close", onPipeClose);
    // EOF can still be followed by an auto-close error from the owned fd.
    stopPipe.on("error", ignoreLatePipeError);
    if (destroy) {
      if (!stopPipe.destroyed) stopPipe.destroy();
    }
  };

  const requestShutdown = () => {
    if (requested || disposed) return;
    requested = true;
    cleanupPipe(true);
    void Promise.resolve().then(shutdown).catch(() => {});
  };

  const onMessage = (message: unknown) => {
    if (!ipcListening || requested || !message || typeof message !== "object"
      || Array.isArray(message) || ![Object.prototype, null].includes(Object.getPrototypeOf(message))) return;
    const fields = Object.getOwnPropertyDescriptors(message);
    if (Reflect.ownKeys(fields).length !== 2 || !fields.v?.enumerable || !("value" in fields.v)
      || fields.v.value !== 1 || !fields.kind?.enumerable || !("value" in fields.kind)
      || fields.kind.value !== "sps.owner-host.shutdown") return;
    requestShutdown();
  };

  const onPipeData = (chunk: unknown) => {
    if (pipeInvalid || !pipeListening) return;
    let bytes: Buffer;
    if (typeof chunk === "string") bytes = Buffer.from(chunk, "utf8");
    else if (Buffer.isBuffer(chunk)) bytes = chunk;
    else if (chunk instanceof Uint8Array) bytes = Buffer.from(chunk);
    else {
      pipeInvalid = true;
      cleanupPipe(true);
      return;
    }

    if (pipeBuffer.length + bytes.length > MAX_STOP_PIPE_BYTES) {
      pipeInvalid = true;
      cleanupPipe(true);
      return;
    }
    pipeBuffer = Buffer.concat([pipeBuffer, bytes]);
  };

  const onPipeEnd = () => {
    const validToken = !pipeInvalid && pipeBuffer.equals(STOP_PIPE_TOKEN);
    cleanupPipe(false);
    if (validToken) requestShutdown();
  };

  const onPipeError = () => {
    pipeInvalid = true;
    cleanupPipe(true);
  };

  const onPipeClose = () => {
    // A close without end is not a complete stop request.
    cleanupPipe(false);
  };

  parent.on("message", onMessage);
  // A final message may be queued immediately before disconnect. The independent
  // stop pipe remains live after IPC listeners are removed.
  parent.once("disconnect", detachIpc);

  if (stopPipe) {
    // Install the error listener first; createReadStream may report fd errors on
    // the next tick as soon as it starts flowing.
    stopPipe.on("error", onPipeError);
    stopPipe.on("data", onPipeData);
    stopPipe.once("end", onPipeEnd);
    stopPipe.once("close", onPipeClose);
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    requested = true;
    detachIpc();
    cleanupPipe(true);
  };

  return dispose;
}
