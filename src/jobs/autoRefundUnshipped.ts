import cron from "node-cron";
import { prisma } from "../db.js";
import { OrderStatus } from "../generated/enums.js";
import { ledger } from "../lib/ledger.js";

// ─────────────────────────────────────────────────────────────────────────────
// JOB: Auto-Refund Unshipped Orders — every 30 minutes
//
// Once a buyer's payment is captured (PAID_HELD), the merchant has 3 days to
// ship. If the merchant misses the shipDeadline (shipDeadline <= now), this job:
//   1. Restores variant stock.
//   2. Appends a REFUNDED entry to CommissionLedger (audit trail).
//   3. Transitions order status from PAID_HELD → REFUNDED.
//
// This protects buyers from merchants who accept payment but never ship.
// ─────────────────────────────────────────────────────────────────────────────

export async function timeoutShipDeadlines(): Promise<void> {
  const now = new Date();

  const timedOutOrders = await prisma.order.findMany({
    where: {
      status: OrderStatus.PAID_HELD,
      shipDeadline: { lte: now },
    },
    include: { items: true },
  });

  if (timedOutOrders.length === 0) return;

  console.log(`[Job:autoRefundUnshipped] Refunding ${timedOutOrders.length} unshipped order(s)...`);

  for (const order of timedOutOrders) {
    try {
      await prisma.$transaction(
        async (tx) => {
          // 1. Restore stock for all ordered items
          for (const item of order.items) {
            await tx.variant.update({
              where: { id: item.variantId },
              data: { stock: { increment: item.quantity } },
            });
          }

          // 2. Append refund entry to ledger for audit trail
          await ledger.recordRefunded(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: order.totalCents,
              note: "Auto-refunded: Merchant missed 3-day shipping deadline. Full refund to buyer.",
            },
            tx
          );

          // 3. Mark order as REFUNDED
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.REFUNDED },
          });
        },
        { timeout: 20000, maxWait: 10000 }
      );

      console.log(`[Job:autoRefundUnshipped] ✓ Refunded order ${order.id}`);
    } catch (err: any) {
      console.error(`[Job:autoRefundUnshipped] ✗ Failed for order ${order.id}:`, err.message);
    }
  }
}

/**
 * Starts the unshipped-order refund cron job.
 * Schedule: every 30 minutes ("star/30 * * * *")
 */
export function startAutoRefundUnshippedJob(): void {
  cron.schedule("*/30 * * * *", async () => {
    try {
      await timeoutShipDeadlines();
    } catch (err: any) {
      console.error("[Job:autoRefundUnshipped] Unhandled crash:", err.message);
    }
  });

  console.log("[Job:autoRefundUnshipped] Scheduled — runs every 30 minutes");
}
