import { prisma } from "../db.js";
import { OrderStatus } from "../generated/enums.js";
import { calculateCommission } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";

// ─────────────────────────────────────────────────────────────────────────────
// ESCROW WORKER
// Runs three independent background sweeps on a recurring interval.
// All operations are idempotent — safe to run concurrently or after restart.
// ─────────────────────────────────────────────────────────────────────────────

// ─── 1. AUTO-RELEASE: DELIVERED → RELEASED ───────────────────────────────────
/**
 * Finds all orders in DELIVERED status whose 24-hour buyer protection window
 * has expired (releaseAt <= now), then atomically:
 *   1. Calculates Qeto's platform commission (store.commissionBps / 10_000).
 *   2. Appends a COMMISSION entry to CommissionLedger (Qeto's cut).
 *   3. Appends a RELEASED entry  to CommissionLedger (merchant's net payout).
 *   4. Transitions the order status to RELEASED.
 *
 * This mirrors the manual POST /api/orders/:id/release-funds endpoint but
 * runs automatically so merchants don't need to do anything.
 */
export async function autoReleaseEscrow(): Promise<void> {
  const now = new Date();

  // Find all DELIVERED orders where the 24h protection window has ended.
  // releaseAt is set when the buyer confirms delivery (or the seller confirms via delivery code).
  const eligibleOrders = await prisma.order.findMany({
    where: {
      status: OrderStatus.DELIVERED,
      releaseAt: { lte: now }, // protection window has expired
    },
    include: {
      store: true, // needed for commissionBps
    },
  });

  if (eligibleOrders.length === 0) return;

  console.log(`[EscrowWorker] Auto-releasing ${eligibleOrders.length} order(s)...`);

  for (const order of eligibleOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Calculate commission and merchant net using shared money utility
        const { commissionCents, merchantNetCents } = calculateCommission(
          order.totalCents,
          order.store.commissionBps
        );

        // 2. Record Qeto's platform commission in the append-only ledger
        await ledger.recordCommission(
          {
            orderId: order.id,
            storeId: order.storeId,
            amountCents: commissionCents,
            note: `Auto-released: Qeto platform commission (${order.store.commissionBps / 100}%)`,
          },
          tx as any
        );

        // 3. Record merchant's net funds as released for withdrawal
        await ledger.recordReleased(
          {
            orderId: order.id,
            storeId: order.storeId,
            amountCents: merchantNetCents,
            note: "Auto-released: Merchant net funds available after buyer protection window expired",
          },
          tx as any
        );

        // 4. Move the order to RELEASED — escrow lifecycle complete
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.RELEASED },
        });
      });

      console.log(
        `[EscrowWorker] ✓ Released order ${order.id} — merchant receives ${(
          (order.totalCents * (1 - order.store.commissionBps / 10_000)) /
          100
        ).toFixed(2)} ETB`
      );
    } catch (err: any) {
      // Log per-order errors without crashing the whole sweep
      console.error(`[EscrowWorker] ✗ Failed to release order ${order.id}:`, err.message);
    }
  }
}

// ─── 2. EXPIRE UNPAID ORDERS: PENDING_PAYMENT → EXPIRED ─────────────────────
/**
 * Finds all PENDING_PAYMENT orders whose 15-minute stock reservation
 * window has passed (expiresAt <= now).
 * For each expired order:
 *   1. Restores reserved stock back to each product variant.
 *   2. Transitions the order status to EXPIRED.
 *
 * This frees up inventory for other buyers who want to purchase the same items.
 */
export async function expireUnpaidOrders(): Promise<void> {
  const now = new Date();

  // Find orders still waiting for payment but past the 15-min reservation window
  const expiredOrders = await prisma.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: { lte: now }, // 15-minute window has passed
    },
    include: {
      items: true, // need items to restore stock per variant
    },
  });

  if (expiredOrders.length === 0) return;

  console.log(`[EscrowWorker] Expiring ${expiredOrders.length} unpaid order(s)...`);

  for (const order of expiredOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Restore stock for every item in the order back to the variant
        for (const item of order.items) {
          await tx.variant.update({
            where: { id: item.variantId },
            data: { stock: { increment: item.quantity } }, // add back the reserved qty
          });
        }

        // 2. Mark the order as EXPIRED
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.EXPIRED },
        });
      });

      console.log(`[EscrowWorker] ✓ Expired unpaid order ${order.id} — stock restored`);
    } catch (err: any) {
      console.error(`[EscrowWorker] ✗ Failed to expire order ${order.id}:`, err.message);
    }
  }
}

// ─── 3. SHIP DEADLINE TIMEOUT: PAID_HELD → REFUNDED ─────────────────────────
/**
 * Finds all PAID_HELD orders where the seller missed the 3-day shipping deadline
 * (shipDeadline <= now). For each timed-out order:
 *   1. Restores variant stock.
 *   2. Appends a REFUNDED entry to CommissionLedger (buyer gets their money back).
 *   3. Transitions the order status to REFUNDED.
 *
 * This protects buyers from sellers who take payment but never ship.
 */
export async function timeoutShipDeadlines(): Promise<void> {
  const now = new Date();

  // Only check PAID_HELD orders — escrow is active, seller hasn't shipped
  const timedOutOrders = await prisma.order.findMany({
    where: {
      status: OrderStatus.PAID_HELD,
      shipDeadline: { lte: now }, // 3-day deadline has passed without shipping
    },
    include: {
      items: true,
    },
  });

  if (timedOutOrders.length === 0) return;

  console.log(`[EscrowWorker] Timing out ${timedOutOrders.length} unshipped order(s)...`);

  for (const order of timedOutOrders) {
    try {
      await prisma.$transaction(async (tx) => {
        // 1. Restore stock for all ordered items
        for (const item of order.items) {
          await tx.variant.update({
            where: { id: item.variantId },
            data: { stock: { increment: item.quantity } },
          });
        }

        // 2. Record the refund in the ledger for audit trail
        await ledger.recordRefunded(
          {
            orderId: order.id,
            storeId: order.storeId,
            amountCents: order.totalCents,
            note: "Auto-refunded: Seller missed 3-day shipping deadline. Full refund issued to buyer.",
          },
          tx as any
        );

        // 3. Mark order as REFUNDED — escrow released back to buyer
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.REFUNDED },
        });
      });

      console.log(
        `[EscrowWorker] ✓ Refunded order ${order.id} — seller missed shipping deadline`
      );
    } catch (err: any) {
      console.error(`[EscrowWorker] ✗ Failed to timeout order ${order.id}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULER
// Wires all three sweep functions into a single recurring interval.
// Call startEscrowWorker() once at server startup.
// ─────────────────────────────────────────────────────────────────────────────

// How often the worker runs (in milliseconds).
// Default: every 2 minutes.
// In production you could raise this to 5–10 min since DB queries are cheap.
const WORKER_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Starts the escrow background worker.
 * Runs all three sweeps immediately on startup, then repeats every 2 minutes.
 * Returns the interval handle so it can be cleared in tests or graceful shutdown.
 */
export function startEscrowWorker(): NodeJS.Timeout {
  // Run immediately on server boot to catch anything missed during downtime
  runAllSweeps();

  // Then schedule recurring runs
  const handle = setInterval(runAllSweeps, WORKER_INTERVAL_MS);

  console.log(
    `[EscrowWorker] Started — sweeping every ${WORKER_INTERVAL_MS / 1000}s`
  );

  return handle;
}

/**
 * Runs all three sweeps in sequence.
 * Errors in one sweep do not block the others.
 */
async function runAllSweeps(): Promise<void> {
  try {
    await autoReleaseEscrow();
  } catch (err: any) {
    console.error("[EscrowWorker] autoReleaseEscrow crashed:", err.message);
  }

  try {
    await expireUnpaidOrders();
  } catch (err: any) {
    console.error("[EscrowWorker] expireUnpaidOrders crashed:", err.message);
  }

  try {
    await timeoutShipDeadlines();
  } catch (err: any) {
    console.error("[EscrowWorker] timeoutShipDeadlines crashed:", err.message);
  }
}

