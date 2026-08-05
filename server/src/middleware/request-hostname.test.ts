import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { requestHostIdentity, requestHostname } from "./request-hostname.js";

function request(headers: Record<string, string>, remoteAddress = "127.0.0.1"): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress },
  } as unknown as Request;
}

describe("requestHostname", () => {
  it("ignores forwarded hostnames without Tailscale Serve identity proof", () => {
    expect(requestHostname(request({
      host: "127.0.0.1:31310",
      "x-forwarded-host": "owner.tailnet.ts.net",
    }))).toBe("127.0.0.1");
  });

  it("accepts a single Tailscale hostname only from a loopback Serve request", () => {
    const headers = {
      host: "127.0.0.1:31310",
      "x-forwarded-host": "owner.tailnet.ts.net",
      "tailscale-user-login": "member@example.com",
    };
    expect(requestHostname(request(headers))).toBe("owner.tailnet.ts.net");
    expect(requestHostname(request(headers, "100.64.0.10"))).toBe("127.0.0.1");
    expect(requestHostIdentity(request(headers))).toEqual({
      hostname: "owner.tailnet.ts.net",
      source: "tailscale-serve",
      peer: "loopback",
      identity: { userLogin: "member@example.com" },
    });
  });

  it("keeps a direct Tailscale-looking Host untrusted on a loopback socket", () => {
    expect(requestHostIdentity(request({ host: "owner.tailnet.ts.net" }))).toEqual({
      hostname: "owner.tailnet.ts.net",
      source: "direct",
      peer: "loopback",
      identity: null,
    });
  });

  it("rejects ambiguous forwarded chains and non-Tailscale forwarded hosts", () => {
    expect(requestHostname(request({
      host: "localhost:31310",
      "x-forwarded-host": "owner.tailnet.ts.net, attacker.invalid",
      "tailscale-user-login": "member@example.com",
    }))).toBe("localhost");
    expect(requestHostname(request({
      host: "localhost:31310",
      "x-forwarded-host": "attacker.invalid",
      "tailscale-user-login": "member@example.com",
    }))).toBe("localhost");
  });
});
