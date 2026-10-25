import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSpsNativePairingSecret,
  hashSpsNativePairingEmail,
  hashSpsNativePairingSecret,
  verifySpsNativePairingSecret,
} from "../services/sps-native-pairing-crypto.js";

const HOST_ID = "11111111-2222-4333-8444-555555555555";
const PAIRING_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("SPS native pairing crypto", () => {
  it("creates canonical unpadded base64url encodings of 32 random bytes", () => {
    const first = createSpsNativePairingSecret();
    const second = createSpsNativePairingSecret();

    for (const secret of [first, second]) {
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(secret).not.toContain("=");
      expect(Buffer.from(secret, "base64url")).toHaveLength(32);
      expect(Buffer.from(secret, "base64url").toString("base64url")).toBe(secret);
    }
    expect(first).not.toBe(second);
  });

  it("hashes canonical decoded bytes with domain-separated, normalized UUID scope", () => {
    const secret = Buffer.alloc(32, 0xa5).toString("base64url");
    const hash = hashSpsNativePairingSecret(HOST_ID, PAIRING_ID, secret);
    const expected = createHash("sha256")
      .update(`sps-native-pairing:v1\0${HOST_ID}\0${PAIRING_ID}\0`, "ascii")
      .update(Buffer.alloc(32, 0xa5))
      .digest("hex");

    expect(hash).toBe(expected);
    expect(hashSpsNativePairingSecret(HOST_ID.toUpperCase(), PAIRING_ID.toUpperCase(), secret)).toBe(hash);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds a pairing secret to both UUIDs and verifies with a strict timing-safe digest", () => {
    const secret = createSpsNativePairingSecret();
    const hash = hashSpsNativePairingSecret(HOST_ID, PAIRING_ID, secret);

    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, secret, hash)).toBe(true);
    expect(verifySpsNativePairingSecret("11111111-2222-4333-8444-555555555556", PAIRING_ID, secret, hash)).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeef", secret, hash)).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, createSpsNativePairingSecret(), hash)).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, secret, hash.toUpperCase())).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, secret, `${hash.slice(0, -1)}g`)).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, secret, hash.slice(1))).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, secret, `${hash}\n`)).toBe(false);
    expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, secret, `${hash}\r\n`)).toBe(false);
  });

  it("rejects malformed UUIDs, noncanonical secrets, invalid UTF-8 text, and oversized input", () => {
    const secret = Buffer.alloc(32).toString("base64url");
    const noncanonicalLastCharacter = `${secret.slice(0, -1)}B`;
    const invalidUtf8Text = "\uD800";
    const oversized = "a".repeat(4096);

    for (const invalidSecret of [
      `${secret}=`,
      noncanonicalLastCharacter,
      `${secret.slice(0, -1)}!`,
      invalidUtf8Text,
      oversized,
    ]) {
      expect(() => hashSpsNativePairingSecret(HOST_ID, PAIRING_ID, invalidSecret)).toThrow(TypeError);
      expect(verifySpsNativePairingSecret(HOST_ID, PAIRING_ID, invalidSecret, "0".repeat(64))).toBe(false);
    }

    expect(() => hashSpsNativePairingSecret("not-a-uuid", PAIRING_ID, secret)).toThrow(TypeError);
    expect(() => hashSpsNativePairingSecret(HOST_ID, PAIRING_ID.toUpperCase().replaceAll("-", ""), secret)).toThrow(
      TypeError,
    );
    expect(verifySpsNativePairingSecret("not-a-uuid", PAIRING_ID, secret, "0".repeat(64))).toBe(false);
    for (const suffix of ["\n", "\r\n", " "]) {
      expect(() => hashSpsNativePairingSecret(`${HOST_ID}${suffix}`, PAIRING_ID, secret)).toThrow(TypeError);
      expect(() => hashSpsNativePairingSecret(HOST_ID, `${PAIRING_ID}${suffix}`, secret)).toThrow(TypeError);
      expect(verifySpsNativePairingSecret(`${HOST_ID}${suffix}`, PAIRING_ID, secret, "0".repeat(64))).toBe(false);
    }

    try {
      hashSpsNativePairingSecret(HOST_ID, PAIRING_ID, `private:${oversized}`);
      throw new Error("Expected invalid secret to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).not.toContain(oversized);
      expect((error as Error).message).not.toContain("private:");
    }
  });

  it("canonicalizes email case and surrounding spaces without alias rewriting or verification claims", () => {
    const canonicalEmail = "alice.example+tag@example.com";
    const emailHash = hashSpsNativePairingEmail(canonicalEmail);

    expect(hashSpsNativePairingEmail("  Alice.Example+tag@Example.COM  ")).toBe(emailHash);
    expect(emailHash).toBe(
      createHash("sha256").update(`sps-native-pairing-email:v1\0${canonicalEmail}`, "ascii").digest("hex"),
    );
    expect(hashSpsNativePairingEmail("alice.example@example.com")).not.toBe(
      hashSpsNativePairingEmail("aliceexample@example.com"),
    );
    expect(hashSpsNativePairingEmail("alice+tag@example.com")).not.toBe(
      hashSpsNativePairingEmail("alice@example.com"),
    );
  });

  it("rejects invalid or oversized email input without echoing it", () => {
    const oversized = `${" ".repeat(250)}a@example.com`;
    const invalidEmails = [
      oversized,
      "alice\n@example.com",
      "álîce@example.com",
      "alice..example@example.com",
      ".alice@example.com",
      "alice@-example.com",
      "alice@example-.com",
      "alice@example..com",
      "alice@@example.com",
      "alice@example.com\uD800",
    ];

    for (const email of invalidEmails) {
      try {
        hashSpsNativePairingEmail(email);
        throw new Error("Expected invalid email to be rejected");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).not.toContain(email);
      }
    }
  });
});
