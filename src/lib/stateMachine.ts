import { OrderStatus } from "../generated/enums.js";

/**
 * Qeto Escrow Order State Machine
 *
 * Implements strict, auditable state transitions for the escrow lifecycle as specified
 * in Qeto Escrow Design v1.1 and Product Specifications.
 *
 * Lifecycle flow:
 * PENDING_PAYMENT ──(pay)──> PAID_HELD ──(ship)──> SHIPPED ──(delivered)──> DELIVERED ──(release)──> RELEASED
 *        │                      │                     │                         │
 *    (timeout)              (deadline)            (dispute)                 (dispute)
 *        ▼                      ▼                     ▼                         ▼
 *     EXPIRED                REFUNDED              DISPUTED ───────────────> DISPUTED
 *                                                     │
 *                                            (admin ruling)
 *                                            ┌────────┴────────┐
 *                                            ▼                 ▼
 *                                         REFUNDED          RELEASED
 */

export const ALLOWED_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  // 1. Initial online checkout: stock reserved for 15 minutes
  [OrderStatus.PENDING_PAYMENT]: [
    OrderStatus.PAID_HELD,
    OrderStatus.PAID,
    OrderStatus.EXPIRED,
    OrderStatus.CANCELLED,
  ],

  // 2. COD order checkout
  [OrderStatus.COD_PENDING]: [
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.CANCELLED,
  ],

  // 3. Gross payment locked in escrow; seller has 3 days to ship
  [OrderStatus.PAID_HELD]: [
    OrderStatus.SHIPPED,
    OrderStatus.REFUNDED,
    OrderStatus.CANCELLED,
    OrderStatus.DISPUTED,
  ],

  // 4. Intermediate legacy status (treated equivalently to PAID_HELD)
  [OrderStatus.PAID]: [
    OrderStatus.PAID_HELD,
    OrderStatus.SHIPPED,
    OrderStatus.REFUNDED,
    OrderStatus.CANCELLED,
    OrderStatus.DISPUTED,
  ],

  // 5. Package dispatched with courier / tracking
  [OrderStatus.SHIPPED]: [
    OrderStatus.DELIVERED,
    OrderStatus.DISPUTED,
    OrderStatus.REFUNDED,
  ],

  // 6. Package received; 24-hour buyer protection countdown active
  [OrderStatus.DELIVERED]: [
    OrderStatus.RELEASED,
    OrderStatus.DISPUTED,
    OrderStatus.REFUNDED,
  ],

  // 7. Buyer froze escrow with dispute; waits for admin arbitration
  [OrderStatus.DISPUTED]: [
    OrderStatus.RELEASED,
    OrderStatus.REFUNDED,
  ],

  // Terminal states — cannot transition any further
  [OrderStatus.RELEASED]: [],
  [OrderStatus.REFUNDED]: [],
  [OrderStatus.CANCELLED]: [],
  [OrderStatus.EXPIRED]: [],
} as const;

/**
 * Checks whether transitioning from `from` to `to` is legally allowed.
 */
export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true; // idempotent self-transition
  const allowed = ALLOWED_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Asserts that a transition from `from` to `to` is valid.
 * Throws a formatted error if illegal.
 */
export function assertCanTransition(
  from: OrderStatus,
  to: OrderStatus,
  orderId?: string
): void {
  if (!canTransition(from, to)) {
    const idMsg = orderId ? ` for order ${orderId}` : "";
    throw new Error(
      `Illegal order state transition${idMsg}: cannot transition from '${from}' to '${to}'. Allowed target states: [${(
        ALLOWED_TRANSITIONS[from] || []
      ).join(", ")}]`
    );
  }
}

/**
 * Returns true if the order status is terminal (no further state changes permitted).
 */
export function isTerminalStatus(status: OrderStatus): boolean {
  return ALLOWED_TRANSITIONS[status]?.length === 0;
}

/**
 * Returns true if funds for this order are currently locked in escrow.
 */
export function isEscrowActive(status: OrderStatus): boolean {
  const escrowStatuses: OrderStatus[] = [
    OrderStatus.PAID_HELD,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
    OrderStatus.DISPUTED,
  ];
  return escrowStatuses.includes(status);
}

/**
 * Returns true if a buyer can file a dispute on an order in this status.
 */
export function isDisputableStatus(status: OrderStatus): boolean {
  const disputableStatuses: OrderStatus[] = [
    OrderStatus.PAID_HELD,
    OrderStatus.SHIPPED,
    OrderStatus.DELIVERED,
  ];
  return disputableStatuses.includes(status);
}

