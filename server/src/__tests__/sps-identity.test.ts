import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { authSessions, authUsers, createDb } from "@paperclipai/db";
import type { Config } from "../config.js";
import { createSpsIdentityAuth } from "../auth/sps-identity.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const issuer = "https://auth.example.test";
const audience = "sps-core";
const keyId = "test-sps-identity-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey;

function base64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function createAccessToken(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: keyId }));
  const payload = base64Url(JSON.stringify({
    iss: issuer,
    aud: audience,
    sub: `google-${randomUUID()}`,
    email: "owner@example.test",
    name: "SPS Owner",
    scope: "sps.core.session",
    exp: now + 60,
    ...overrides,
  }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function createConfig(): Config {
  return {
    authIdentityEnabled: true,
    authIdentityIssuer: issuer,
    authIdentityAudience: audience,
    authIdentityJwksUrl: `${issuer}/.well-known/jwks.json`,
    authPublicBaseUrl: "http://127.0.0.1:31310",
  } as Config;
}

function firstCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) throw new Error("Expected SPS Identity session cookie.");
  return value.split(";", 1)[0]!;
}

describeEmbeddedPostgres("SPS Identity Core bridge", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("sps-identity-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await db.delete(authSessions);
    await db.delete(authUsers).where(eq(authUsers.email, "owner@example.test"));
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await tempDb?.cleanup();
  });

  function createApp() {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ ...publicJwk, kty: "RSA", kid: keyId, alg: "RS256", use: "sig" }],
    }), { status: 200 })) as typeof fetch;
    const identity = createSpsIdentityAuth(db, createConfig());
    const app = express();
    app.use(express.json());
    app.use("/api/sps-identity", identity.routes);
    return { app, identity };
  }

  it("creates a Core-only HTTP-only session from a valid SPS Identity access token", async () => {
    const { app, identity } = createApp();
    const response = await request(app)
      .post("/api/sps-identity/session")
      .set("Authorization", `Bearer ${createAccessToken()}`)
      .send({});

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.account).toEqual({ email: "owner@example.test", name: "SPS Owner" });
    expect(response.headers["set-cookie"]).toEqual(expect.arrayContaining([
      expect.stringContaining("sps_identity_session="),
    ]));
    expect(firstCookie(response)).toContain("sps_identity_session=");
    expect(response.headers["set-cookie"][0]).toContain("HttpOnly");

    const session = await identity.resolveSessionFromHeaders(new Headers({ cookie: firstCookie(response) }));
    expect(session?.user).toMatchObject({ email: "owner@example.test", name: "SPS Owner" });
  });

  it("rejects a token that lacks the Core session scope", async () => {
    const { app } = createApp();
    const response = await request(app)
      .post("/api/sps-identity/session")
      .set("Authorization", `Bearer ${createAccessToken({ scope: "openid profile email" })}`)
      .send({});

    expect(response.status).toBe(401);
    expect(response.body.error).toContain("not valid for this Core");
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("removes the Core session on logout", async () => {
    const { app, identity } = createApp();
    const signedIn = await request(app)
      .post("/api/sps-identity/session")
      .set("Authorization", `Bearer ${createAccessToken()}`)
      .send({});
    const cookie = firstCookie(signedIn);

    const loggedOut = await request(app)
      .post("/api/sps-identity/logout")
      .set("Cookie", cookie)
      .send({});
    expect(loggedOut.status).toBe(204);
    expect(loggedOut.headers["set-cookie"][0]).toContain("sps_identity_session=;");
    await expect(identity.resolveSessionFromHeaders(new Headers({ cookie }))).resolves.toBeNull();
  });
});
