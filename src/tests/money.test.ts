import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { centsToETB, etbToCents, calculateCommission } from "../lib/money.js";

describe("Money Utility - Santim & ETB Calculations", () => {
  describe("centsToETB()", () => {
    it("should format 100 santim as '1.00' ETB", () => {
      assert.equal(centsToETB(100), "1.00");
    });

    it("should format 0 santim as '0.00' ETB", () => {
      assert.equal(centsToETB(0), "0.00");
    });

    it("should format large amounts accurately with 2 decimal places", () => {
      assert.equal(centsToETB(15025), "150.25");
      assert.equal(centsToETB(250000), "2500.00");
      assert.equal(centsToETB(99), "0.99");
    });
  });

  describe("etbToCents()", () => {
    it("should convert numeric ETB to integer santim", () => {
      assert.equal(etbToCents(1), 100);
      assert.equal(etbToCents(150.25), 15025);
      assert.equal(etbToCents(0), 0);
    });

    it("should convert string ETB to integer santim", () => {
      assert.equal(etbToCents("1.00"), 100);
      assert.equal(etbToCents("2500"), 250000);
      assert.equal(etbToCents("49.99"), 4999);
    });

    it("should throw error for invalid or negative ETB values", () => {
      assert.throws(() => etbToCents("invalid"), /Invalid ETB amount/);
      assert.throws(() => etbToCents(-50), /Invalid ETB amount/);
    });
  });

  describe("calculateCommission()", () => {
    it("should calculate standard 3% (300 bps) platform commission", () => {
      // 1,000 ETB = 100,000 cents
      const gross = 100_000;
      const { commissionCents, merchantNetCents } = calculateCommission(gross, 300);

      assert.equal(commissionCents, 3_000); // 30 ETB
      assert.equal(merchantNetCents, 97_000); // 970 ETB
      assert.equal(commissionCents + merchantNetCents, gross);
    });

    it("should calculate 0% commission during 7-day free trial (0 bps)", () => {
      const gross = 150_000;
      const { commissionCents, merchantNetCents } = calculateCommission(gross, 0);

      assert.equal(commissionCents, 0);
      assert.equal(merchantNetCents, 150_000);
      assert.equal(commissionCents + merchantNetCents, gross);
    });

    it("should maintain zero-santim drift invariant across various odd amounts", () => {
      const testAmounts = [1, 7, 33, 99, 100, 333, 1234, 9999, 123456, 10_000_000];
      const testBps = [0, 50, 100, 250, 300, 500, 1000];

      for (const amount of testAmounts) {
        for (const bps of testBps) {
          const { commissionCents, merchantNetCents } = calculateCommission(amount, bps);
          assert.equal(
            commissionCents + merchantNetCents,
            amount,
            `Invariant failed for gross: ${amount}, bps: ${bps}`
          );
          assert(Number.isInteger(commissionCents), "commissionCents must be an integer");
          assert(Number.isInteger(merchantNetCents), "merchantNetCents must be an integer");
        }
      }
    });

    it("should throw for negative gross amount", () => {
      assert.throws(() => calculateCommission(-100, 300), /Gross amount cannot be negative/);
    });
  });
});

