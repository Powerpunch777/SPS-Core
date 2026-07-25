import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "./auth.js";
import {
  SPS_DESKTOP_ACCESS_HEADER,
  SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER,
} from "./desktop-local-access.js";

describe("actorMiddleware Desktop Owner bootstrap", () => {
  it("uses the two loopback launch proofs instead of a stale session membership", async () => {
    const resolveSession = vi.fn();
    const previousToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
    process.env.SPS_DESKTOP_ACCESS_TOKEN = "desktop-launch-token";
    const request = {
      header: (name: string) => ({
        host: "127.0.0.1:31310",
        [SPS_DESKTOP_ACCESS_HEADER]: "desktop-launch-token",
        [SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER]: "desktop-launch-token",
      })[name.toLowerCase()],
    } as unknown as Request;
    const next = vi.fn();
    const middleware = actorMiddleware({} as never, {
      deploymentMode: "authenticated",
      resolveSession,
    });

    try {
      await middleware(request, {} as Response, next);

      expect(resolveSession).not.toHaveBeenCalled();
      expect(request.actor).toMatchObject({
        type: "board",
        userId: "local-board",
        isInstanceAdmin: true,
        source: "local_implicit",
      });
      expect(next).toHaveBeenCalledOnce();
    } finally {
      if (previousToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
      else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousToken;
    }
  });
});
