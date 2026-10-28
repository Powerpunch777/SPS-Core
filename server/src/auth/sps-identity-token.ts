import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import type { JWTPayload } from "jose";

export type SpsIdentityJwk = {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
};

export type SpsIdentityTokenProfile = {
  subject: string;
  email: string;
  name: string;
  picture: string | null;
};

type SpsIdentityTokenClaims = {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  name?: unknown;
  picture?: unknown;
  scope?: unknown;
  exp?: unknown;
  nbf?: unknown;
};

type SpsIdentityTokenConfig = {
  issuer: string;
  audience: string;
};

type SpsIdentityJwksLoader = () => Promise<SpsIdentityJwk[]>;

function value(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function hasRequiredScope(input: unknown): boolean {
  const scopes = typeof input === "string"
    ? input.split(/\s+/)
    : Array.isArray(input) ? input : [];
  return scopes.includes("sps.core.session");
}

function profileFromClaims(claims: SpsIdentityTokenClaims): SpsIdentityTokenProfile {
  const subject = value(claims.sub);
  const email = value(claims.email);
  if (!subject || !email) throw new Error("SPS Identity token has no verified account.");
  return {
    subject,
    email,
    name: value(claims.name) || email,
    picture: value(claims.picture) || null,
  };
}
function joseErrorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function normalizeJoseError(error: unknown): Error {
  const code = joseErrorCode(error);
  if (code === "ERR_JWKS_NO_MATCHING_KEY") {
    return new Error("SPS Identity signing key is not recognized.");
  }
  if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
    return new Error("SPS Identity token signature is invalid.");
  }
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED" || code === "ERR_JWT_EXPIRED") {
    return new Error("SPS Identity token is not valid for this Core.");
  }
  return new Error("SPS Identity token is invalid.");
}

/** Verify an SPS Identity access token against Core's already-fetched trusted JWKS. */
export function createSpsIdentityTokenVerifier(
  config: SpsIdentityTokenConfig,
  loadJwks: SpsIdentityJwksLoader,
) {
  return async function verifyAccessToken(token: string): Promise<SpsIdentityTokenProfile> {
    const compactToken = value(token);
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      if (!compactToken) {
        throw new Error("invalid compact token");
      }
      header = decodeProtectedHeader(compactToken);
    } catch {
      throw new Error("SPS Identity token is invalid.");
    }

    if (header.alg !== "RS256" || !value(header.kid)) {
      throw new Error("SPS Identity token uses an unsupported signature.");
    }

    let jwks: SpsIdentityJwk[];
    try {
      jwks = await loadJwks();
    } catch {
      throw new Error("SPS Identity signing keys are unavailable.");
    }
    const key = jwks.find((candidate) => candidate.kid === header.kid);
    if (!key) throw new Error("SPS Identity signing key is not recognized.");

    let payload: JWTPayload;
    try {
      const keySet = createLocalJWKSet({ keys: [key] });
      ({ payload } = await jwtVerify(compactToken, keySet, {
        algorithms: ["RS256"],
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ["exp"],
        clockTolerance: 30,
      }));
    } catch (error) {
      throw normalizeJoseError(error);
    }

    const claims = payload as SpsIdentityTokenClaims;
    const now = Math.floor(Date.now() / 1000);
    // jose's clockTolerance applies to exp as well as nbf. Core historically
    // allows 30 seconds of nbf skew but rejects expiration at the exact second.
    if (claims.iss !== config.issuer
      || typeof claims.exp !== "number"
      || !Number.isFinite(claims.exp)
      || claims.exp <= now
      || !hasRequiredScope(claims.scope)) {
      throw new Error("SPS Identity token is not valid for this Core.");
    }
    return profileFromClaims(claims);
  };
}
