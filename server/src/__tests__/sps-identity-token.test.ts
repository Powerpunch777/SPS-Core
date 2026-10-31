import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpsIdentityTokenVerifier, type SpsIdentityJwk } from "../auth/sps-identity-token.js";

const issuer = "https://identity.example.test";
const audience = "sps-core";
const kid = "sps-identity-test-key";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: duplicatePrivateKey, publicKey: duplicatePublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...(publicKey.export({ format: "jwk" }) as JsonWebKey),
  kid,
  alg: "RS256",
  use: "sig",
} as SpsIdentityJwk;
const duplicatePublicJwk = {
  ...(duplicatePublicKey.export({ format: "jwk" }) as JsonWebKey),
  kid,
  alg: "RS256",
  use: "sig",
} as SpsIdentityJwk;

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signingKey = privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = base64UrlJson({ alg: "RS256", typ: "JWT", kid, ...header });
  const encodedClaims = base64UrlJson({
    iss: issuer,
    aud: audience,
    sub: "user-123",
    email: "owner@example.test",
    name: "SPS Owner",
    scope: "sps.core.session",
    exp: now + 60,
    ...claims,
  });
  const signed = `${encodedHeader}.${encodedClaims}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), signingKey).toString("base64url")}`;
}

function verifier(jwks: SpsIdentityJwk[] = [publicJwk]) {
  const loadJwks = vi.fn(async () => jwks);
  return {
    loadJwks,
    verify: createSpsIdentityTokenVerifier({ issuer, audience }, loadJwks),
  };
}

describe("SPS Identity access-token verification", () => {
  beforeEach(() => vi.setSystemTime(new Date("2026-10-28T00:00:00.000Z")));
  afterEach(() => vi.useRealTimers());

  it("returns only the verified account profile and accepts array audience/scope claims", async () => {
    const { verify, loadJwks } = verifier();
    await expect(verify(token({ aud: [audience, "other"], scope: ["openid", "sps.core.session"] })))
      .resolves.toEqual({
        subject: "user-123",
        email: "owner@example.test",
        name: "SPS Owner",
        picture: null,
      });
    expect(loadJwks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["issuer", { iss: "https://other.example.test" }],
    ["audience", { aud: "other" }],
    ["scope", { scope: "openid profile" }],
    ["missing expiration", { exp: undefined }],
  ])("rejects an invalid %s claim with a fixed SPS error", async (_label, claims) => {
    const { verify } = verifier();
    await expect(verify(token(claims as Record<string, unknown>)))
      .rejects.toThrow("SPS Identity token is not valid for this Core.");
  });

  it("keeps the 30-second not-before tolerance without extending expiration", async () => {
    const { verify } = verifier();
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(token({ nbf: now + 30 }))).resolves.toMatchObject({ subject: "user-123" });
    await expect(verify(token({ nbf: now + 31 })))
      .rejects.toThrow("SPS Identity token is not valid for this Core.");
    await expect(verify(token({ exp: now })))
      .rejects.toThrow("SPS Identity token is not valid for this Core.");
    await expect(verify(token({ exp: now - 1 })))
      .rejects.toThrow("SPS Identity token is not valid for this Core.");
  });

  it("requires RS256 and a key id before loading the trusted JWKS", async () => {
    const { verify, loadJwks } = verifier();
    await expect(verify(token({}, { alg: "HS256" })))
      .rejects.toThrow("SPS Identity token uses an unsupported signature.");
    await expect(verify(token({}, { kid: "" })))
      .rejects.toThrow("SPS Identity token uses an unsupported signature.");
    expect(loadJwks).not.toHaveBeenCalled();
  });

  it("does not refetch or follow token-supplied key URLs for an unknown key id", async () => {
    const { verify, loadJwks } = verifier();
    await expect(verify(token({}, {
      kid: "unrecognized-key",
      jku: "https://attacker.example.test/jwks.json",
      x5u: "https://attacker.example.test/certificate",
    }))).rejects.toThrow("SPS Identity signing key is not recognized.");
    expect(loadJwks).toHaveBeenCalledTimes(1);
  });

  it("preserves first-match behavior for duplicate key ids in the trusted JWKS", async () => {
    const { verify } = verifier([publicJwk, duplicatePublicJwk]);
    await expect(verify(token())).resolves.toMatchObject({ subject: "user-123" });

    const reversed = verifier([duplicatePublicJwk, publicJwk]);
    await expect(reversed.verify(token({}, {}, duplicatePrivateKey)))
      .resolves.toMatchObject({ subject: "user-123" });
    await expect(reversed.verify(token()))
      .rejects.toThrow("SPS Identity token signature is invalid.");
  });

  it("normalizes bad signatures, malformed tokens, and JWKS failures", async () => {
    const valid = token();
    const [protectedHeader, payload, signature] = valid.split(".");
    const badSignature = `${protectedHeader}.${payload}.${signature![0] === "A" ? "B" : "A"}${signature!.slice(1)}`;
    await expect(verifier().verify(badSignature)).rejects.toThrow("SPS Identity token signature is invalid.");
    await expect(verifier().verify("not-a-jwt")).rejects.toThrow("SPS Identity token is invalid.");
    const unavailable = createSpsIdentityTokenVerifier({ issuer, audience }, async () => {
      throw new Error("private endpoint detail");
    });
    await expect(unavailable(token())).rejects.toThrow("SPS Identity signing keys are unavailable.");
  });
});
