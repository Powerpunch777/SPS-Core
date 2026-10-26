import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemberTlsFixture, type MemberTlsFixture } from "./helpers/member-tls.js";
import { createSpsNativeWorkspaceProofVerifier } from "../services/sps-native-workspace-proof.js";

const HOST_ID = "a1111111-b111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const COOKIE = `sps_identity_session=${"a".repeat(64)}`;
const EMPTY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const DEFAULT_TARGET = `/api/companies/${WORKSPACE_ID}/workspace-shell`;
let clientCertificate: MemberTlsFixture;
let serverCertificate: MemberTlsFixture;

type ProofFields = [1, string, string, string, string, string, number, string, string, string, string];

function fields(overrides: Partial<ProofFields> = {}, now = Date.now(), certificate = clientCertificate.certificate): ProofFields {
  return [1, HOST_ID, WORKSPACE_ID, "GET", DEFAULT_TARGET, randomBytes(32).toString("base64url"), now,
    EMPTY_HASH, COOKIE, "", certificate].map((value, index) => overrides[index] ?? value) as ProofFields;
}

function encode(values: unknown, key: Buffer): string {
  const bytes = Buffer.from(JSON.stringify(values), "utf8");
  return `${bytes.toString("base64url")}.${createHmac("sha256", key).update(bytes).digest("base64url")}`;
}

function actual(overrides: Partial<{ method: string; target: string; body: Buffer; cookie: string; contentType: string }> = {}) {
  return {
    method: "GET",
    target: DEFAULT_TARGET,
    body: Buffer.alloc(0),
    cookie: COOKIE,
    contentType: "",
    ...overrides,
  };
}

function verifier(options: { key?: Buffer; hostId?: string; now?: () => number; maxReplay?: number; assertCurrent?: () => void } = {}) {
  return createSpsNativeWorkspaceProofVerifier({
    hostId: options.hostId ?? HOST_ID,
    key: options.key ?? randomBytes(32),
    assertCurrent: options.assertCurrent ?? (() => {}),
    now: options.now,
    maxReplay: options.maxReplay,
  });
}

function replaceField(value: ProofFields, index: number, replacement: unknown) {
  const copy = [...value] as unknown[];
  copy[index] = replacement;
  return copy;
}

beforeAll(async () => {
  clientCertificate = await createMemberTlsFixture({ purpose: "clientAuth" });
  serverCertificate = await createMemberTlsFixture({ purpose: "serverAuth" });
}, 30_000);

afterAll(async () => {
  await clientCertificate?.cleanup();
  await serverCertificate?.cleanup();
});

describe("SPS Native Workspace request proof codec", () => {
  it("verifies a signed canonical request and returns an isolated frozen proof", () => {
    const key = randomBytes(32);
    const suppliedKey = Buffer.from(key);
    const verify = verifier({ key: suppliedKey });
    suppliedKey.fill(0);
    const signed = fields();
    const result = verify.verify(encode(signed, key), actual());
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toMatchObject({ v: 1, hostId: HOST_ID, workspaceId: WORKSPACE_ID,
      method: "GET", target: DEFAULT_TARGET, bodySha256: EMPTY_HASH, cookie: COOKIE, contentType: "" });
    expect(result.peerCertificateDer.toString("base64url")).toBe(clientCertificate.certificate);
    expect(result.peerCertificateDer).not.toBe(Buffer.from(clientCertificate.certificate, "base64url"));
    result.peerCertificateDer.fill(0);
    expect(verify.verify(encode(fields(), key), actual()).peerCertificateDer.toString("base64url"))
      .toBe(clientCertificate.certificate);
    verify.dispose();
  });

  it("binds the actual method, target, body digest, session cookie and content type", () => {
    const key = randomBytes(32);
    const verify = verifier({ key });
    const body = Buffer.from("{\"items\":[]}");
    const signed = fields({ 3: "PATCH", 4: `/api/companies/${WORKSPACE_ID}/workspace-inbox/item`,
      7: createHash("sha256").update(body).digest("hex"), 8: `sps_identity_session=${"b".repeat(64)}`,
      9: "application/json" });
    const request = actual({ method: "PATCH", target: signed[4], body, cookie: signed[8], contentType: signed[9] });
    expect(verify.verify(encode(signed, key), request).method).toBe("PATCH");
    for (const mutation of [
      actual({ method: "PUT", target: request.target, body, cookie: request.cookie, contentType: request.contentType }),
      actual({ method: request.method, target: `${request.target}?different=1`, body, cookie: request.cookie, contentType: request.contentType }),
      actual({ method: request.method, target: request.target, body: Buffer.from("changed"), cookie: request.cookie, contentType: request.contentType }),
      actual({ method: request.method, target: request.target, body, cookie: COOKIE, contentType: request.contentType }),
      actual({ method: request.method, target: request.target, body, cookie: request.cookie, contentType: "application/json; charset=utf-8" }),
    ]) {
      expect(() => verify.verify(encode(fields({ ...({} as Partial<ProofFields>), 3: request.method,
        4: request.target, 7: createHash("sha256").update(body).digest("hex"), 8: request.cookie, 9: request.contentType }), key), mutation))
        .toThrow("Native Workspace request proof is unavailable.");
    }
    verify.dispose();
  });

  it("rejects host mismatch, wrong key, altered MAC, malformed envelope and unknown payload shape", () => {
    const key = randomBytes(32);
    const verify = verifier({ key });
    const signed = fields();
    const header = encode(signed, key);
    expect(() => verifier({ key, hostId: randomUUID() }).verify(header, actual())).toThrow();
    expect(() => verify.verify(encode(signed, randomBytes(32)), actual())).toThrow();
    const [payload, mac] = header.split(".");
    const alteredMac = Buffer.from(mac!, "base64url");
    alteredMac[0] = alteredMac[0]! ^ 1;
    const alteredHeader = `${payload}.${alteredMac.toString("base64url")}`;
    expect(alteredHeader).not.toBe(header);
    expect(() => verify.verify(alteredHeader, actual())).toThrow();
    for (const malformed of ["", "a", `${header}.x`, `${header.split(".")[0]}.${"A".repeat(42)}`,
      encode({ ...Object.fromEntries(signed.map((value, index) => [String(index), value])), extra: true }, key),
      encode([...signed, "extra"], key), encode(replaceField(signed, 0, 2), key)]) {
      expect(() => verify.verify(malformed, actual())).toThrow("Native Workspace request proof is unavailable.");
    }
    verify.dispose();
  });

  it("rejects noncanonical UUIDs, methods, targets, nonce, timestamp, digest, cookie and content type", () => {
    const key = randomBytes(32);
    const verify = verifier({ key });
    const valid = fields();
    const invalid: Array<[number, unknown]> = [
      [1, HOST_ID.toUpperCase()], [2, "../workspace"], [3, "DELETE"], [4, "https://example.test/path"],
      [4, `//${WORKSPACE_ID}/workspace`], [4, `${DEFAULT_TARGET}#frag`], [4, `${DEFAULT_TARGET.replace("workspace-shell", "%2e%2e")}`],
      [4, `${DEFAULT_TARGET}/%2fsecret`], [4, DEFAULT_TARGET.replace("/", "\\")],
      [5, "x".repeat(43)], [6, 1.5], [6, Number.MAX_SAFE_INTEGER + 1], [7, "A".repeat(64)],
      [8, "sps_identity_session=bad"], [9, "application/json; charset=utf-8"],
      [10, "not-base64url="],
    ];
    for (const [index, value] of invalid) {
      const signed = replaceField(valid, index, value);
      try { verify.verify(encode(signed, key), actual()); }
      catch (error) {
        expect(error).toMatchObject({ message: "Native Workspace request proof is unavailable." });
        continue;
      }
      throw new Error(`Invalid proof field ${index} was accepted.`);
    }
    verify.dispose();
  });

  it("rejects unknown/accessor actual request fields without invoking getters", () => {
    const key = randomBytes(32);
    const verify = verifier({ key });
    const signed = fields();
    let getterCalls = 0;
    const accessor = { ...actual() };
    Object.defineProperty(accessor, "cookie", { enumerable: true, get() { getterCalls++; return COOKIE; } });
    expect(() => verify.verify(encode(signed, key), accessor)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() => verify.verify(encode(signed, key), { ...actual(), extra: true })).toThrow();
    verify.dispose();
  });

  it("requires a current, non-CA clientAuth certificate and rejects serverAuth-only, CA and malformed DER", () => {
    const key = randomBytes(32);
    const verify = verifier({ key });
    for (const der of [serverCertificate.certificate, Buffer.from("not a certificate").toString("base64url"),
      Buffer.concat([Buffer.from(clientCertificate.certificate, "base64url"), Buffer.from([0])]).toString("base64url")]) {
      expect(() => verify.verify(encode(fields({ 10: der }), key), actual())).toThrow();
    }
    verify.dispose();
  });

  it("enforces the 30-second age and 5-second future window, including boundary values", () => {
    const key = randomBytes(32);
    let currentTime = Date.now();
    const verify = verifier({ key, now: () => currentTime });
    expect(() => verify.verify(encode(fields({ 6: currentTime - 30_000 }), key), actual())).not.toThrow();
    currentTime++;
    expect(() => verify.verify(encode(fields({ 6: currentTime - 30_001 }), key), actual())).toThrow();
    expect(() => verify.verify(encode(fields({ 6: currentTime + 5_000 }), key), actual())).not.toThrow();
    expect(() => verify.verify(encode(fields({ 6: currentTime + 5_001 }), key), actual())).toThrow();
    verify.dispose();
  });

  it("consumes nonces once, never evicts live entries, and prunes only expired timestamps", () => {
    const key = randomBytes(32);
    let currentTime = Date.now();
    const verify = verifier({ key, now: () => currentTime, maxReplay: 1 });
    const first = fields({ 6: currentTime });
    const firstHeader = encode(first, key);
    expect(() => verify.verify(firstHeader, actual())).not.toThrow();
    expect(() => verify.verify(firstHeader, actual())).toThrow();
    expect(() => verify.verify(encode(fields({ 6: currentTime }), key), actual())).toThrow();
    currentTime += 30_001;
    expect(() => verify.verify(firstHeader, actual())).toThrow();
    const fresh = fields({ 6: currentTime });
    expect(() => verify.verify(encode(fresh, key), actual())).not.toThrow();
    verify.dispose();
  });

  it("checks synchronous authority before and after verification and disposes terminally", () => {
    const key = randomBytes(32);
    const assertCurrent = vi.fn();
    const verify = verifier({ key, assertCurrent });
    const signed = fields();
    verify.verify(encode(signed, key), actual());
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    const asyncGuard = verifier({ key, assertCurrent: (() => Promise.resolve()) as unknown as () => void });
    expect(() => asyncGuard.verify(encode(fields(), key), actual())).toThrow();
    asyncGuard.dispose();
    verify.dispose();
    expect(() => verify.verify(encode(fields(), key), actual())).toThrow();
    verify.dispose();

    let disposingVerifier: ReturnType<typeof verifier>;
    let calls = 0;
    disposingVerifier = verifier({ key, assertCurrent: () => {
      calls++;
      if (calls === 2) disposingVerifier.dispose();
    } });
    expect(() => disposingVerifier.verify(encode(fields(), key), actual())).toThrow();
    expect(() => disposingVerifier.verify(encode(fields(), key), actual())).toThrow();
  });

  it("rejects verifier option accessors, unknown fields and non-record options", () => {
    const key = randomBytes(32);
    let getterCalls = 0;
    const options = { hostId: HOST_ID, key, assertCurrent: () => {} } as Record<string, unknown>;
    Object.defineProperty(options, "now", { enumerable: true, get() { getterCalls++; return Date.now; } });
    expect(() => createSpsNativeWorkspaceProofVerifier(options as never)).toThrow();
    expect(getterCalls).toBe(0);
    expect(() => createSpsNativeWorkspaceProofVerifier({ hostId: HOST_ID, key, assertCurrent: () => {}, extra: true } as never)).toThrow();
    expect(() => createSpsNativeWorkspaceProofVerifier(Object.create(null) as never)).toThrow();
  });

  it("rejects invalid verifier configuration and bounds header, body, target and replay capacity", () => {
    expect(() => createSpsNativeWorkspaceProofVerifier({ hostId: HOST_ID, key: Buffer.alloc(31), assertCurrent: () => {} })).toThrow();
    expect(() => createSpsNativeWorkspaceProofVerifier({ hostId: HOST_ID, key: Buffer.alloc(32), assertCurrent: () => {}, maxReplay: 4097 })).toThrow();
    const key = randomBytes(32);
    const verify = verifier({ key, maxReplay: 1 });
    expect(() => verify.verify("x".repeat(8193), actual())).toThrow();
    expect(() => verify.verify(encode(fields({ 4: `/${"a".repeat(2048)}` }), key), actual())).toThrow();
    expect(() => verify.verify(encode(fields(), key), actual({ body: Buffer.alloc(64 * 1024 + 1) }))).toThrow();
    const first = fields();
    verify.verify(encode(first, key), actual());
    expect(() => verify.verify(encode(fields(), key), actual())).toThrow();
    verify.dispose();
  });
});
