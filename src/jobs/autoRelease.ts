import cron from "node-cron";
import { prisma } from "../db.js";
import { OrderStatus } from "../generated/enums.js";
import { calculateCommission } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";

// ─────────────────────────────────────────────────────────────────────────────
// JOB: Auto-Release Escrow — every 15 minutes
//
// When a buyer confirms delivery (or the seller confirms via delivery code),
// the order status becomes DELIVERED and releaseAt is set 24 hours in the future
// (buyer protection window). After that window expires, this job:
//   1. Calculates Qeto's platform commission.
//   2. Appends a COMMISSION entry to CommissionLedger.
//   3. Appends a RELEASED entry  to CommissionLedger (merchant's net).
//   4. Transitions order status from DELIVERED → RELEASED.
//
// Mirrors the manual POST /api/orders/:id/release-funds endpoint but runs
// automatically — merchants don't need to do anything.
// ─────────────────────────────────────────────────────────────────────────────

export async function autoReleaseEscrow(): Promise<void> {
  const now = new Date();

  const eligibleOrders = await prisma.order.findMany({
    where: {
      status: OrderStatus.DELIVERED,
      releaseAt: { lte: now },
    },
    include: { store: true },
  });

  if (eligibleOrders.length === 0) return;

  console.log(`[Job:autoRelease] Auto-releasing ${eligibleOrders.length} order(s)...`);

  for (const order of eligibleOrders) {
    try {
      await prisma.$transaction(
        async (tx) => {
          const { commissionCents, merchantNetCents } = calculateCommission(
            order.totalCents,
            order.store.commissionBps
          );

          await ledger.recordCommission(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: commissionCents,
              note: `Auto-released: Qeto commission (${order.store.commissionBps / 100}%)`,
            },
            tx
          );

          await ledger.recordReleased(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: merchantNetCents,
              note: "Auto-released: Merchant net funds — buyer protection window expired",
            },
            tx
          );

          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.RELEASED },
          });
        },
        { timeout: 20000, maxWait: 10000 }
      );

      console.log(`[Job:autoRelease] ✓ Released order ${order.id}`);
    } catch (err: any) {
      console.error(`[Job:autoRelease] ✗ Failed for order ${order.id}:`, err.message);
    }
  }
}

/**
 * Starts the escrow auto-release cron job.
 * Schedule: every 15 minutes ("star/15 * * * *")
 */
export function startAutoReleaseJob(): void {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await autoReleaseEscrow();
    } catch (err: any) {
      console.error("[Job:autoRelease] Unhandled crash:", err.message);
    }
  });

  console.log("[Job:autoRelease] Scheduled — runs every 15 minutes");
}
