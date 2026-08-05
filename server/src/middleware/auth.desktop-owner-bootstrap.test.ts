import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "./auth.js";
import {
  SPS_DESKTOP_ACCESS_HEADER,
  SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER,
} from "./desktop-local-access.js";
import { hasSpsCoreHostAuthority } from "../routes/authz.js";

describe("actorMiddleware Desktop Owner bootstrap", () => {
  it("recognizes the physical Desktop Host independently of legacy instance-admin rows", () => {
    const previousBaseline = process.env.SPS_CORE_BASELINE_MODE;
    const previousToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    process.env.SPS_DESKTOP_ACCESS_TOKEN = "desktop-launch-token";
    const request = {
      actor: { type: "board", source: "session", isInstanceAdmin: false },
      socket: { remoteAddress: "127.0.0.1" },
      header: (name: string) => ({
        host: "127.0.0.1:31310",
        [SPS_DESKTOP_ACCESS_HEADER]: "desktop-launch-token",
        [SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER]: "desktop-launch-token",
      })[name.toLowerCase()],
    } as unknown as Request;

    try {
      expect(hasSpsCoreHostAuthority(request)).toBe(true);
    } finally {
      if (previousBaseline === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previousBaseline;
      if (previousToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
      else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousToken;
    }
  });

  it("uses the signed-in Owner identity with the two loopback launch proofs", async () => {
    const resolveSession = vi.fn(async () => ({
      session: { id: "session-owner", userId: "sps-owner" },
      user: { id: "sps-owner", name: "SPS Owner", email: "owner@example.test" },
    }));
    const previousToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
    process.env.SPS_DESKTOP_ACCESS_TOKEN = "desktop-launch-token";
    const request = {
      socket: { remoteAddress: "127.0.0.1" },
      header: (name: string) => ({
        host: "127.0.0.1:31310",
        [SPS_DESKTOP_ACCESS_HEADER]: "desktop-launch-token",
        [SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER]: "desktop-launch-token",
      })[name.toLowerCase()],
    } as unknown as Request;
    const selectRows = [
      [{ id: "sps-owner", name: "SPS Owner", email: "owner@example.test" }],
      [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      [{ id: "instance-admin" }],
    ];
    const db = {
      select: () => {
        const rows = selectRows.shift() ?? [];
        return {
          from: () => ({
            where: () => ({
              then: async (resolve: (value: unknown) => unknown) => resolve(rows),
            }),
          }),
        };
      },
    };
    const next = vi.fn();
    const claimDesktopBootstrapAdmin = vi.fn(async () => true);
    const middleware = actorMiddleware(db as never, {
      deploymentMode: "authenticated",
      resolveSession,
      claimDesktopBootstrapAdmin,
    });

    try {
      await middleware(request, {} as Response, next);

      expect(resolveSession).toHaveBeenCalledOnce();
      expect(claimDesktopBootstrapAdmin).toHaveBeenCalledWith({ userId: "sps-owner" });
      expect(request.actor).toMatchObject({
        type: "board",
        userId: "sps-owner",
        companyIds: ["company-1"],
        memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
        isInstanceAdmin: true,
        source: "session",
      });
      expect(next).toHaveBeenCalledOnce();
    } finally {
      if (previousToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
      else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousToken;
    }
  });

  it("does not grant bootstrap authority without an SPS Identity session", async () => {
    const previousToken = process.env.SPS_DESKTOP_ACCESS_TOKEN;
    process.env.SPS_DESKTOP_ACCESS_TOKEN = "desktop-launch-token";
    const request = {
      socket: { remoteAddress: "127.0.0.1" },
      header: (name: string) => ({
        host: "127.0.0.1:31310",
        [SPS_DESKTOP_ACCESS_HEADER]: "desktop-launch-token",
        [SPS_DESKTOP_OWNER_BOOTSTRAP_HEADER]: "desktop-launch-token",
      })[name.toLowerCase()],
    } as unknown as Request;
    const next = vi.fn();
    const claimDesktopBootstrapAdmin = vi.fn(async () => true);
    const middleware = actorMiddleware({} as never, {
      deploymentMode: "authenticated",
      resolveSession: vi.fn(async () => null),
      claimDesktopBootstrapAdmin,
    });

    try {
      await middleware(request, {} as Response, next);

      expect(request.actor).toMatchObject({ type: "none", source: "none" });
      expect(claimDesktopBootstrapAdmin).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledOnce();
    } finally {
      if (previousToken === undefined) delete process.env.SPS_DESKTOP_ACCESS_TOKEN;
      else process.env.SPS_DESKTOP_ACCESS_TOKEN = previousToken;
    }
  });

  it("does not expose a stale instance-admin row to a remote SPS baseline session", async () => {
    const previousBaseline = process.env.SPS_CORE_BASELINE_MODE;
    process.env.SPS_CORE_BASELINE_MODE = "true";
    const resolveSession = vi.fn(async () => ({
      session: { id: "session-member", userId: "legacy-admin" },
      user: { id: "legacy-admin", name: "Legacy Admin", email: "legacy@example.test" },
    }));
    const query = {
      from: () => ({
        where: () => ({
          then: async (resolve: (rows: Array<Record<string, unknown>>) => unknown) => resolve([{}]),
        }),
      }),
    };
    const request = {
      header: () => undefined,
    } as unknown as Request;
    const next = vi.fn();
    const middleware = actorMiddleware({ select: () => query } as never, {
      deploymentMode: "authenticated",
      resolveSession,
    });

    try {
      await middleware(request, {} as Response, next);

      expect(request.actor).toMatchObject({
        type: "board",
        userId: "legacy-admin",
        isInstanceAdmin: false,
        source: "session",
      });
      expect(next).toHaveBeenCalledOnce();
    } finally {
      if (previousBaseline === undefined) delete process.env.SPS_CORE_BASELINE_MODE;
      else process.env.SPS_CORE_BASELINE_MODE = previousBaseline;
    }
  });
});
