import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateDeliveryCode,
  hashDeliveryCode,
  findDeliveryCodeFromHash,
  generateOrderToken,
} from "../lib/deliveryCode.js";

describe("Delivery Code & Security Utilities", () => {
  describe("generateDeliveryCode()", () => {
    it("should generate a 4-digit numeric string", () => {
      for (let i = 0; i < 50; i++) {
        const code = generateDeliveryCode();
        assert.equal(typeof code, "string");
        assert.equal(code.length, 4);
        assert.match(code, /^\d{4}$/);
        const num = parseInt(code, 10);
        assert(num >= 1000 && num <= 9999);
      }
    });
  });

  describe("hashDeliveryCode()", () => {
    it("should produce a 64-character SHA-256 hex string", () => {
      const hash = hashDeliveryCode("1234");
      assert.equal(typeof hash, "string");
      assert.equal(hash.length, 64);
      assert.match(hash, /^[0-9a-f]{64}$/);
    });

    it("should be deterministic for identical inputs", () => {
      const hash1 = hashDeliveryCode("4829");
      const hash2 = hashDeliveryCode("4829");
      assert.equal(hash1, hash2);
    });

    it("should trim whitespace before hashing", () => {
      const hashWithSpaces = hashDeliveryCode(" 5678 \n");
      const hashClean = hashDeliveryCode("5678");
      assert.equal(hashWithSpaces, hashClean);
    });

    it("should produce different hashes for different codes", () => {
      const hash1 = hashDeliveryCode("1000");
      const hash2 = hashDeliveryCode("1001");
      assert.notEqual(hash1, hash2);
    });
  });

  describe("findDeliveryCodeFromHash()", () => {
    it("should recover the exact 4-digit code from its SHA-256 hash", () => {
      const testCodes = ["1000", "2468", "9999", "5555"];
      for (const code of testCodes) {
        const hash = hashDeliveryCode(code);
        const recovered = findDeliveryCodeFromHash(hash);
        assert.equal(recovered, code);
      }
    });

    it("should return null for null hash or non-existent 4-digit hash", () => {
      assert.equal(findDeliveryCodeFromHash(null), null);
      // Hash of a 5-digit number "10000"
      const non4DigitHash = hashDeliveryCode("10000");
      assert.equal(findDeliveryCodeFromHash(non4DigitHash), null);
    });
  });

  describe("generateOrderToken()", () => {
    it("should produce a 40-character hex string", () => {
      const token = generateOrderToken();
      assert.equal(typeof token, "string");
      assert.equal(token.length, 40);
      assert.match(token, /^[0-9a-f]{40}$/);
    });

    it("should generate cryptographically random, unique tokens", () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const token = generateOrderToken();
        assert(!tokens.has(token), "Duplicate token generated");
        tokens.add(token);
      }
      assert.equal(tokens.size, 100);
    });
  });
});
