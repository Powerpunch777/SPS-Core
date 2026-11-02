import path from "node:path";

type ProcessSessionInputFrame =
  | { type: "stdin"; data: string }
  | { type: "stdinEnd" };

export function createProcessSessionInputQueue(input: {
  stdinDir: string;
  publish: (filePath: string, body: string) => Promise<void>;
}) {
  let sequence = 0;
  let pending = Promise.resolve();
  let finishing: Promise<void> | null = null;
  const enqueue = (frame: ProcessSessionInputFrame, settleFailure = false): Promise<void> => {
    const filePath = path.posix.join(input.stdinDir, `${String(++sequence).padStart(12, "0")}.json`);
    const body = `${JSON.stringify(frame)}\n`;
    const previous = settleFailure ? pending.catch(() => undefined) : pending;
    const write = previous.then(() => input.publish(filePath, body));
    pending = write;
    return write;
  };
  return {
    write(frame: ProcessSessionInputFrame): Promise<void> {
      // Publish complete frames in receive order. In particular, EOF must not
      // overtake data, and a failed data frame must not permit a successful EOF.
      if (finishing) return Promise.reject(new Error("Process session input is closing."));
      return enqueue(frame);
    },
    finish(): Promise<void> {
      // Cleanup still closes remote stdin after a transport failure, but only
      // after all attempted uploads settle. It never turns failed input into
      // a successful normal EOF, and admits no further application frames.
      finishing ??= enqueue({ type: "stdinEnd" }, true);
      return finishing;
    },
  };
}
