import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { desktopLocalAccessGuard, SPS_DESKTOP_ACCESS_HEADER } from "./desktop-local-access.js";

function request(path: string, headers: Record<string, string> = {}): Request {
  return {
    path,
    header: (name: string) => headers[name.toLowerCase()]
  } as unknown as Request;
}

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
    type: vi.fn(),
    send: vi.fn()
  };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  return res as unknown as Response & typeof res;
}

describe("desktopLocalAccessGuard", () => {
  const token = "desktop-launch-token";

  it("rejects direct loopback browser requests", () => {
    const guard = desktopLocalAccessGuard({ token });
    const res = response();
    const next = vi.fn();

    guard(request("/SPS/projects", { host: "127.0.0.1:31310" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith("This local SPS Owner Host is available only through SPS Desktop.");
  });

  it("allows the Electron Workspace token and the lifecycle health probe", () => {
    const guard = desktopLocalAccessGuard({ token });
    const next = vi.fn();

    guard(request("/SPS/projects", {
      host: "localhost:31310",
      [SPS_DESKTOP_ACCESS_HEADER]: token
    }), response(), next);
    guard(request("/api/health", { host: "127.0.0.1:31310" }), response(), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it("leaves the authenticated Tailscale hostname path available", () => {
    const guard = desktopLocalAccessGuard({ token });
    const next = vi.fn();

    guard(request("/SPS/projects", { host: "main-computer.tailnet.ts.net" }), response(), next);

    expect(next).toHaveBeenCalledOnce();
  });
});
