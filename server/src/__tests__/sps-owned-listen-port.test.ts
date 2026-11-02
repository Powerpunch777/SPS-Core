import { createServer } from "node:net";
import detectPort from "detect-port";
import { describe, expect, it, vi } from "vitest";
import { requireSpsOwnedListenPort } from "../services/sps-owned-listen-port.js";

const unavailableCode = "SPS_DESKTOP_PORT_UNAVAILABLE";

describe("requireSpsOwnedListenPort", () => {
  it("returns the requested port when the detector reports that exact port", async () => {
    const detector = vi.fn(async (port: number) => port);

    await expect(requireSpsOwnedListenPort(43127, detector)).resolves.toBe(43127);
    expect(detector).toHaveBeenCalledOnce();
    expect(detector).toHaveBeenCalledWith(43127);
  });

  it("rejects a different available port instead of silently falling back", async () => {
    const detector = vi.fn(async () => 43128);

    await expect(requireSpsOwnedListenPort(43127, detector)).rejects.toMatchObject({
      code: unavailableCode,
    });
    expect(detector).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid requested port %s without calling the detector",
    async (requestedPort) => {
      const detector = vi.fn(async (port: number) => port);

      await expect(requireSpsOwnedListenPort(requestedPort, detector)).rejects.toMatchObject({
        code: unavailableCode,
      });
      expect(detector).not.toHaveBeenCalled();
    },
  );

  it.each([Number.NaN, 0, 65_536, 43127.5, "43127"])(
    "rejects malformed detector result %s",
    async (detectedPort) => {
      const detector = vi.fn(async () => detectedPort as number);

      await expect(requireSpsOwnedListenPort(43127, detector)).rejects.toMatchObject({
        code: unavailableCode,
      });
      expect(detector).toHaveBeenCalledOnce();
    },
  );

  it("preserves detector failures", async () => {
    const failure = new Error("port detection failed");
    const detector = vi.fn(async () => {
      throw failure;
    });

    await expect(requireSpsOwnedListenPort(43127, detector)).rejects.toBe(failure);
    expect(detector).toHaveBeenCalledOnce();
  });

  it("rejects an actually occupied loopback port and leaves its listener open", async () => {
    const listener = createServer();
    listener.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      listener.once("listening", resolve);
      listener.once("error", reject);
    });

    try {
      const address = listener.address();
      if (address === null || typeof address === "string") {
        throw new Error("Expected the loopback listener to have a TCP address");
      }

      await expect(
        requireSpsOwnedListenPort(address.port, (port) =>
          detectPort({ port, hostname: "127.0.0.1" }),
        ),
      ).rejects.toMatchObject({ code: unavailableCode });
      expect(listener.listening).toBe(true);
      expect(listener.address()).toMatchObject({ port: address.port, address: "127.0.0.1" });
    } finally {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
