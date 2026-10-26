import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  desktopLocalAccessGuard,
  hasTrustedDesktopOwnerBootstrap,
  SPS_DESKTOP_ACCESS_HEADER,
  SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER,
} from "./desktop-local-access.js";

function request(path: string, headers: Record<string, string> = {}, remoteAddress = "127.0.0.1"): Request {
  return {
    path,
    header: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress },
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
  const agentClaims = {
    sub: "agent-1",
    company_id: "company-1",
    adapter_type: "codex_local",
    run_id: "run-1",
    iat: 1,
    exp: 2,
  };

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

  it("rejects a direct Tailscale-looking Host on a loopback socket", () => {
    const guard = desktopLocalAccessGuard({ token });
    const res = response();
    const next = vi.fn();

    guard(request("/SPS/projects", { host: "main-computer.tailnet.ts.net" }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("leaves a direct private Host available only for a real remote peer", () => {
    const guard = desktopLocalAccessGuard({ token });
    const next = vi.fn();

    guard(
      request("/SPS/projects", { host: "main-computer.tailnet.ts.net" }, "100.64.0.10"),
      response(),
      next,
    );

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a forged forwarded hostname without Tailscale Serve identity proof", () => {
    const guard = desktopLocalAccessGuard({ token });
    const res = response();
    const next = vi.fn();

    guard(request("/SPS/projects", {
      host: "127.0.0.1:31310",
      "x-forwarded-host": "owner.tailnet.ts.net",
    }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("accepts a loopback Tailscale Serve request with stripped-and-replaced identity proof", () => {
    const guard = desktopLocalAccessGuard({ token });
    const next = vi.fn();

    guard(request("/SPS/projects", {
      host: "owner.tailnet.ts.net",
      "x-forwarded-host": "owner.tailnet.ts.net",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.64.0.10",
      "tailscale-user-login": "member@example.com",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    }), response(), next);

    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a Serve-looking request when the original and forwarded hosts differ", () => {
    const guard = desktopLocalAccessGuard({ token });
    const res = response();
    const next = vi.fn();

    guard(request("/SPS/projects", {
      host: "owner.tailnet.ts.net",
      "x-forwarded-host": "attacker.tailnet.ts.net",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.64.0.10",
      "tailscale-user-login": "member@example.com",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows a valid local Agent JWT through the API transport gate without exposing the Desktop token", () => {
    const verifyAgentToken = vi.fn((value: string) => value === "valid-agent-jwt" ? agentClaims : null);
    const guard = desktopLocalAccessGuard({ token, verifyAgentToken });
    const allowedNext = vi.fn();
    const deniedResponse = response();

    guard(request("/api/companies/company-1/marketplace/assistant/tools/search_marketplace_plugins", {
      host: "127.0.0.1:31310",
      authorization: "Bearer valid-agent-jwt",
    }), response(), allowedNext);
    guard(request("/api/companies/company-1/marketplace/assistant/tools/search_marketplace_plugins", {
      host: "127.0.0.1:31310",
      authorization: "Bearer invalid-agent-jwt",
    }), deniedResponse, vi.fn());

    expect(allowedNext).toHaveBeenCalledOnce();
    expect(verifyAgentToken).toHaveBeenCalledWith("valid-agent-jwt");
    expect(deniedResponse.status).toHaveBeenCalledWith(403);
  });

  it("never lets an Agent bearer token open a browser surface", () => {
    const verifyAgentToken = vi.fn(() => agentClaims);
    const res = response();
    desktopLocalAccessGuard({ token, verifyAgentToken })(request("/SPS/projects", {
      host: "127.0.0.1:31310",
      authorization: "Bearer valid-agent-jwt",
    }), res, vi.fn());

    expect(verifyAgentToken).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("requires two matching launch proofs for authenticated Owner recovery", () => {
    const headers = {
      host: "127.0.0.1:31310",
      [SPS_DESKTOP_ACCESS_HEADER]: token,
      [SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER]: token,
    };
    expect(hasTrustedDesktopOwnerBootstrap(request("/api/companies", headers), { token })).toBe(true);
    expect(hasTrustedDesktopOwnerBootstrap(request("/api/companies", {
      host: "127.0.0.1:31310",
      [SPS_DESKTOP_ACCESS_HEADER]: token,
    }), { token })).toBe(false);
    expect(hasTrustedDesktopOwnerBootstrap(request("/api/companies", {
      host: "main-computer.tailnet.ts.net",
      [SPS_DESKTOP_ACCESS_HEADER]: token,
      [SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER]: token,
    }), { token })).toBe(false);
  });
});
