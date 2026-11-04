import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OrderStatus } from "../generated/enums.js";
import {
  canTransition,
  assertCanTransition,
  isTerminalStatus,
  isEscrowActive,
  isDisputableStatus,
  ALLOWED_TRANSITIONS,
} from "../lib/stateMachine.js";

describe("State Machine - Escrow Order Lifecycle", () => {
  describe("canTransition() and ALLOWED_TRANSITIONS", () => {
    it("should allow idempotent self-transitions for any status", () => {
      for (const status of Object.values(OrderStatus)) {
        assert.equal(canTransition(status, status), true);
      }
    });

    it("should allow legitimate happy-path escrow transitions", () => {
      // PENDING_PAYMENT -> PAID_HELD
      assert.equal(canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PAID_HELD), true);

      // PAID_HELD -> SHIPPED
      assert.equal(canTransition(OrderStatus.PAID_HELD, OrderStatus.SHIPPED), true);

      // SHIPPED -> DELIVERED
      assert.equal(canTransition(OrderStatus.SHIPPED, OrderStatus.DELIVERED), true);

      // DELIVERED -> RELEASED
      assert.equal(canTransition(OrderStatus.DELIVERED, OrderStatus.RELEASED), true);
    });

    it("should allow dispute transitions and resolutions", () => {
      // From PAID_HELD, SHIPPED, DELIVERED to DISPUTED
      assert.equal(canTransition(OrderStatus.PAID_HELD, OrderStatus.DISPUTED), true);
      assert.equal(canTransition(OrderStatus.SHIPPED, OrderStatus.DISPUTED), true);
      assert.equal(canTransition(OrderStatus.DELIVERED, OrderStatus.DISPUTED), true);

      // From DISPUTED to RELEASED or REFUNDED
      assert.equal(canTransition(OrderStatus.DISPUTED, OrderStatus.RELEASED), true);
      assert.equal(canTransition(OrderStatus.DISPUTED, OrderStatus.REFUNDED), true);
    });

    it("should forbid illegal / backward state jumps", () => {
      // Cannot jump from PENDING_PAYMENT directly to DELIVERED or RELEASED
      assert.equal(canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.DELIVERED), false);
      assert.equal(canTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.RELEASED), false);

      // Cannot reopen terminal states
      assert.equal(canTransition(OrderStatus.RELEASED, OrderStatus.PENDING_PAYMENT), false);
      assert.equal(canTransition(OrderStatus.RELEASED, OrderStatus.PAID_HELD), false);
      assert.equal(canTransition(OrderStatus.REFUNDED, OrderStatus.PAID_HELD), false);
      assert.equal(canTransition(OrderStatus.CANCELLED, OrderStatus.SHIPPED), false);
      assert.equal(canTransition(OrderStatus.EXPIRED, OrderStatus.PAID_HELD), false);
    });
  });

  describe("assertCanTransition()", () => {
    it("should not throw on valid transition", () => {
      assert.doesNotThrow(() => {
        assertCanTransition(OrderStatus.PENDING_PAYMENT, OrderStatus.PAID_HELD, "ord_123");
      });
    });

    it("should throw informative Error on illegal transition", () => {
      assert.throws(
        () => {
          assertCanTransition(OrderStatus.RELEASED, OrderStatus.PAID_HELD, "ord_999");
        },
        /Illegal order state transition for order ord_999/
      );
    });
  });

  describe("isTerminalStatus()", () => {
    it("should identify terminal statuses", () => {
      assert.equal(isTerminalStatus(OrderStatus.RELEASED), true);
      assert.equal(isTerminalStatus(OrderStatus.REFUNDED), true);
      assert.equal(isTerminalStatus(OrderStatus.CANCELLED), true);
      assert.equal(isTerminalStatus(OrderStatus.EXPIRED), true);
    });

    it("should identify active/non-terminal statuses", () => {
      assert.equal(isTerminalStatus(OrderStatus.PENDING_PAYMENT), false);
      assert.equal(isTerminalStatus(OrderStatus.PAID_HELD), false);
      assert.equal(isTerminalStatus(OrderStatus.SHIPPED), false);
      assert.equal(isTerminalStatus(OrderStatus.DELIVERED), false);
      assert.equal(isTerminalStatus(OrderStatus.DISPUTED), false);
    });
  });

  describe("isEscrowActive()", () => {
    it("should identify statuses where funds are held in escrow", () => {
      assert.equal(isEscrowActive(OrderStatus.PAID_HELD), true);
      assert.equal(isEscrowActive(OrderStatus.SHIPPED), true);
      assert.equal(isEscrowActive(OrderStatus.DELIVERED), true);
      assert.equal(isEscrowActive(OrderStatus.DISPUTED), true);
    });

    it("should return false for statuses where funds are not held", () => {
      assert.equal(isEscrowActive(OrderStatus.PENDING_PAYMENT), false);
      assert.equal(isEscrowActive(OrderStatus.RELEASED), false);
      assert.equal(isEscrowActive(OrderStatus.REFUNDED), false);
      assert.equal(isEscrowActive(OrderStatus.CANCELLED), false);
    });
  });

  describe("isDisputableStatus()", () => {
    it("should allow disputes during active fulfillment before release", () => {
      assert.equal(isDisputableStatus(OrderStatus.PAID_HELD), true);
      assert.equal(isDisputableStatus(OrderStatus.SHIPPED), true);
      assert.equal(isDisputableStatus(OrderStatus.DELIVERED), true);
    });

    it("should forbid disputes once funds are already released or cancelled", () => {
      assert.equal(isDisputableStatus(OrderStatus.PENDING_PAYMENT), false);
      assert.equal(isDisputableStatus(OrderStatus.RELEASED), false);
      assert.equal(isDisputableStatus(OrderStatus.REFUNDED), false);
    });
  });
});
