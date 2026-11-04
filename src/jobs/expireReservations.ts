import cron from "node-cron";
import { prisma } from "../db.js";
import { OrderStatus } from "../generated/enums.js";

// ─────────────────────────────────────────────────────────────────────────────
// JOB: Expire Unpaid Orders — every 5 minutes
//
// When a buyer places an order, their chosen variant stock is reserved for
// 15 minutes while they complete payment. If the buyer doesn't pay within
// that window (expiresAt <= now), this job:
//   1. Restores the reserved stock back to each product variant (atomic batch).
//   2. Transitions the order status from PENDING_PAYMENT → EXPIRED.
//
// This frees up inventory for other buyers. All writes are in a single
// $transaction([...]) batch — safe to run concurrently or after restart.
// ─────────────────────────────────────────────────────────────────────────────

export async function expireUnpaidOrders(): Promise<void> {
  const now = new Date();

  const expiredOrders = await prisma.order.findMany({
    where: {
      status: OrderStatus.PENDING_PAYMENT,
      expiresAt: { lte: now },
    },
    include: { items: true },
  });

  if (expiredOrders.length === 0) return;

  console.log(`[Job:expireReservations] Expiring ${expiredOrders.length} unpaid order(s)...`);

  for (const order of expiredOrders) {
    try {
      await prisma.$transaction([
        ...order.items.map((item) =>
          prisma.variant.update({
            where: { id: item.variantId },
            data: { stock: { increment: item.quantity } },
          })
        ),
        prisma.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.EXPIRED },
        }),
      ]);

      console.log(`[Job:expireReservations] ✓ Expired order ${order.id} — stock restored`);
    } catch (err: any) {
      console.error(`[Job:expireReservations] ✗ Failed for order ${order.id}:`, err.message);
    }
  }
}

/**
 * Starts the reservation expiry cron job.
 * Schedule: every 5 minutes ("star/5 * * * *")
 */
export function startExpireReservationsJob(): void {
  cron.schedule("*/5 * * * *", async () => {
    try {
      await expireUnpaidOrders();
    } catch (err: any) {
      console.error("[Job:expireReservations] Unhandled crash:", err.message);
    }
  });

  console.log("[Job:expireReservations] Scheduled — runs every 5 minutes");
}
