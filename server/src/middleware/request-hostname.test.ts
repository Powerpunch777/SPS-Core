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

  it("accepts the complete Tailscale Serve proxy shape from a loopback peer", () => {
    const headers = {
      host: "owner.tailnet.ts.net",
      "x-forwarded-host": "owner.tailnet.ts.net",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.64.0.10",
      "tailscale-user-login": "member@example.com",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
    };
    expect(requestHostname(request(headers))).toBe("owner.tailnet.ts.net");
    expect(requestHostIdentity(request(headers, "100.64.0.10"))).toEqual({
      hostname: "owner.tailnet.ts.net",
      source: "direct",
      peer: "remote",
      identity: null,
    });
    expect(requestHostIdentity(request(headers))).toEqual({
      hostname: "owner.tailnet.ts.net",
      source: "tailscale-serve",
      peer: "loopback",
      identity: { userLogin: "member@example.com" },
    });
  });

  it("keeps a direct Tailscale-looking Host untrusted even with partial forged headers", () => {
    expect(requestHostIdentity(request({
      host: "owner.tailnet.ts.net",
      "x-forwarded-host": "owner.tailnet.ts.net",
      "tailscale-user-login": "member@example.com",
    }))).toEqual({
      hostname: "owner.tailnet.ts.net",
      source: "direct",
      peer: "loopback",
      identity: null,
    });
  });

  it.each([
    ["mismatched host", { "x-forwarded-host": "attacker.tailnet.ts.net" }],
    ["ambiguous host chain", { "x-forwarded-host": "owner.tailnet.ts.net, attacker.invalid" }],
    ["non-HTTPS proxy", { "x-forwarded-proto": "http" }],
    ["ambiguous source chain", { "x-forwarded-for": "100.64.0.10, 127.0.0.1" }],
    ["invalid source address", { "x-forwarded-for": "not-an-ip" }],
    ["missing identity contract", { "tailscale-headers-info": "https://attacker.invalid" }],
  ])("rejects a Serve-looking request with %s", (_label, override) => {
    const identity = requestHostIdentity(request({
      host: "owner.tailnet.ts.net",
      "x-forwarded-host": "owner.tailnet.ts.net",
      "x-forwarded-proto": "https",
      "x-forwarded-for": "100.64.0.10",
      "tailscale-user-login": "member@example.com",
      "tailscale-headers-info": "https://tailscale.com/s/serve-headers",
      ...override,
    }));
    expect(identity.source).toBe("direct");
    expect(identity.identity).toBeNull();
  });

  it("normalizes bracketed IPv6 loopback Hosts", () => {
    expect(requestHostname(request({ host: "[::1]:31310" }, "::1"))).toBe("::1");
  });
});
