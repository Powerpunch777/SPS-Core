import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { authAccounts, authSessions, authUsers, createDb } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createBetterAuthHandler, createBetterAuthInstance } from "../auth/better-auth.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const originalEnvironment = {
  instanceId: process.env.PAPERCLIP_INSTANCE_ID,
  authSecret: process.env.SPS_AUTH_SECRET,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET,
  jwtSecret: process.env.PAPERCLIP_AGENT_JWT_SECRET,
  publicUrl: process.env.PAPERCLIP_PUBLIC_URL,
};

function restoreEnvironmentValue(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function authConfig(authPublicBaseUrl: string): Config {
  return {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    authBaseUrlMode: "explicit",
    authPublicBaseUrl,
    authDisableSignUp: false,
    authGoogleClientId: undefined,
    authGoogleClientSecret: undefined,
    authGoogleHostedDomain: undefined,
    authGoogleOnly: false,
  } as Config;
}

function jsonRequest(baseUrl: string, path: string, method: "GET" | "POST", input?: {
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
}) {
  return new Request(`${baseUrl}/api/auth/${path}`, {
    method,
    headers: {
      ...(input?.body ? { "content-type": "application/json" } : {}),
      ...input?.headers,
    },
    ...(input?.body ? { body: JSON.stringify(input.body) } : {}),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("Better Auth engine compatibility", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let tempDbPromise: Promise<Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>> | null = null;
  const testEmails: string[] = [];

  beforeAll(async () => {
    if (!support.supported) {
      throw new Error(
        `Embedded PostgreSQL is required for Better Auth engine coverage: ${support.reason ?? "support unavailable"}; ` +
        `startupTermination=${JSON.stringify(support.startupTermination ?? null)}`,
      );
    }
    tempDbPromise = startEmbeddedPostgresTestDatabase("sps-better-auth-engine-");
    tempDb = await tempDbPromise;
    db = createDb(tempDb.connectionString);
  }, process.platform === "win32" ? 180_000 : 45_000);

  afterEach(async () => {
    try {
      for (const email of testEmails.splice(0)) {
        const users = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.email, email));
        for (const user of users) {
          await db.delete(authSessions).where(eq(authSessions.userId, user.id));
          await db.delete(authAccounts).where(eq(authAccounts.userId, user.id));
          await db.delete(authUsers).where(eq(authUsers.id, user.id));
        }
      }
    } finally {
      restoreEnvironmentValue("PAPERCLIP_INSTANCE_ID", originalEnvironment.instanceId);
      restoreEnvironmentValue("SPS_AUTH_SECRET", originalEnvironment.authSecret);
      restoreEnvironmentValue("BETTER_AUTH_SECRET", originalEnvironment.betterAuthSecret);
      restoreEnvironmentValue("PAPERCLIP_AGENT_JWT_SECRET", originalEnvironment.jwtSecret);
      restoreEnvironmentValue("PAPERCLIP_PUBLIC_URL", originalEnvironment.publicUrl);
    }
  }, process.platform === "win32" ? 45_000 : 10_000);

  afterAll(async () => {
    restoreEnvironmentValue("PAPERCLIP_INSTANCE_ID", originalEnvironment.instanceId);
    restoreEnvironmentValue("SPS_AUTH_SECRET", originalEnvironment.authSecret);
    restoreEnvironmentValue("BETTER_AUTH_SECRET", originalEnvironment.betterAuthSecret);
    restoreEnvironmentValue("PAPERCLIP_AGENT_JWT_SECRET", originalEnvironment.jwtSecret);
    restoreEnvironmentValue("PAPERCLIP_PUBLIC_URL", originalEnvironment.publicUrl);
    if (!tempDb && tempDbPromise) {
      try {
        tempDb = await tempDbPromise;
      } catch {
        // A failed fixture startup owns and cleans its partial resources internally.
      }
    }
    try {
      await db?.$client.end();
    } finally {
      await tempDb?.cleanup();
    }
  }, 180_000);

  it("signs up, signs in, resolves and revokes a persisted session through the actual auth engine", async () => {
    const baseUrl = "http://127.0.0.1:31310";
    const origin = baseUrl;
    const email = `engine-${randomUUID()}@example.test`;
    testEmails.push(email);
    process.env.PAPERCLIP_INSTANCE_ID = "auth-engine-test";
    process.env.SPS_AUTH_SECRET = "better-auth-engine-test-secret-which-is-long-enough";
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_PUBLIC_URL;

    const auth = createBetterAuthInstance(db, authConfig(baseUrl), [origin]);
    const signUpResponse = await auth.handler(jsonRequest(baseUrl, "sign-up/email", "POST", {
      body: { name: "Engine Test", email, password: "a-long-test-password" },
      headers: { origin },
    }));
    expect(signUpResponse.status).toBe(200);
    const cookieName = "paperclip-auth-engine-test.session_token";
    const setCookie = signUpResponse.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${cookieName}=`);
    expect(setCookie).not.toMatch(/;\s*secure(?:;|$)/i);
    const sessionCookie = setCookie.split(";", 1)[0]!;
    expect(sessionCookie.startsWith(`${cookieName}=`)).toBe(true);

    const sessionResponse = await auth.handler(jsonRequest(baseUrl, "get-session", "GET", {
      headers: { cookie: sessionCookie, origin },
    }));
    expect(sessionResponse.status).toBe(200);
    const sessionBody = await responseJson(sessionResponse);
    expect(sessionBody.user).toMatchObject({ email, name: "Engine Test" });
    expect(sessionBody.session).toMatchObject({ userId: (sessionBody.user as { id: string }).id });
    const userId = (sessionBody.user as { id: string }).id;

    await expect(db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)))
      .resolves.toHaveLength(1);
    await expect(db.select({ id: authAccounts.id }).from(authAccounts).where(eq(authAccounts.userId, userId)))
      .resolves.toHaveLength(1);
    await expect(db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId)))
      .resolves.toHaveLength(1);

    const rejectedOrigin = await auth.handler(jsonRequest(baseUrl, "sign-in/email", "POST", {
      body: { email, password: "a-long-test-password" },
      headers: { origin: "https://untrusted.example.test" },
    }));
    expect(rejectedOrigin.status).toBe(403);

    const signOutResponse = await auth.handler(jsonRequest(baseUrl, "sign-out", "POST", {
      headers: { cookie: sessionCookie, origin },
    }));
    expect(signOutResponse.status).toBe(200);
    await expect(db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId)))
      .resolves.toHaveLength(0);

    const signInResponse = await auth.handler(jsonRequest(baseUrl, "sign-in/email", "POST", {
      body: { email, password: "a-long-test-password" },
      headers: { origin },
    }));
    expect(signInResponse.status).toBe(200);
    const signInCookie = signInResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(signInCookie.startsWith(`${cookieName}=`)).toBe(true);
    const signedInSession = await auth.handler(jsonRequest(baseUrl, "get-session", "GET", {
      headers: { cookie: signInCookie, origin },
    }));
    expect(signedInSession.status).toBe(200);
    expect(await responseJson(signedInSession)).toMatchObject({
      user: { id: userId, email },
      session: { userId },
    });
    await expect(db.select({ id: authAccounts.id }).from(authAccounts).where(eq(authAccounts.userId, userId)))
      .resolves.toHaveLength(1);
    await expect(db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId)))
      .resolves.toHaveLength(1);

    const finalSignOut = await auth.handler(jsonRequest(baseUrl, "sign-out", "POST", {
      headers: { cookie: signInCookie, origin },
    }));
    expect(finalSignOut.status).toBe(200);
    await expect(db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId)))
      .resolves.toHaveLength(1);
    await expect(db.select({ id: authAccounts.id }).from(authAccounts).where(eq(authAccounts.userId, userId)))
      .resolves.toHaveLength(1);
    await expect(db.select({ id: authSessions.id }).from(authSessions).where(eq(authSessions.userId, userId)))
      .resolves.toHaveLength(0);
  });

  it("preserves Express-parsed JSON for Better Auth and emits a secure instance-scoped cookie on HTTPS", async () => {
    const baseUrl = "https://auth-engine.example.test";
    const email = `https-${randomUUID()}@example.test`;
    testEmails.push(email);
    process.env.PAPERCLIP_INSTANCE_ID = "auth-engine-https";
    process.env.SPS_AUTH_SECRET = "better-auth-engine-test-secret-which-is-long-enough";
    delete process.env.BETTER_AUTH_SECRET;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    delete process.env.PAPERCLIP_PUBLIC_URL;

    const auth = createBetterAuthInstance(db, authConfig(baseUrl), [baseUrl]);
    const app = express();
    app.use(express.json({
      verify(req, _res, buffer) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
      },
    }));
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));

    const signUp = await request(app)
      .post("/api/auth/sign-up/email")
      .set("Origin", baseUrl)
      .send({ name: "HTTPS Engine Test", email, password: "a-long-test-password" });
    expect(signUp.status).toBe(200);
    const cookieName = "paperclip-auth-engine-https.session_token";
    const setCookie = signUp.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toContain(`${cookieName}=`);
    expect(setCookie).toMatch(/;\s*secure(?:;|$)/i);
    const cookie = setCookie.split(";", 1)[0]!;

    const getSession = await request(app)
      .get("/api/auth/get-session")
      .set("Origin", baseUrl)
      .set("Cookie", cookie);
    expect(getSession.status).toBe(200);
    expect(getSession.body).toMatchObject({ user: { email }, session: { userId: expect.any(String) } });
  });
});
