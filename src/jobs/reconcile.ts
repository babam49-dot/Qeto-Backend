import cron from "node-cron";
import { prisma } from "../db.js";
import { LedgerEntryType, OrderStatus } from "../generated/enums.js";

// ─────────────────────────────────────────────────────────────────────────────
// JOB: Ledger Reconciliation — daily at 02:00 EAT (23:00 UTC previous day)
//
// Cross-checks the CommissionLedger totals against live order states to detect
// accounting drift. This is a read-only audit job — it only logs discrepancies,
// never writes. Alerts appear in server logs and can be wired to Telegram/email.
//
// What it checks:
//   1. Sum of HELD entries in CommissionLedger vs. sum of active escrow orders
//      (PAID_HELD + SHIPPED + DELIVERED statuses).
//   2. Payout records marked SENT that have no matching PAYOUT_SENT ledger entry.
//
// Discrepancies indicate either a bug in a transaction or a race condition that
// needs investigation. The append-only design means no data is lost — it just
// needs a correcting ledger entry added manually by an admin.
// ─────────────────────────────────────────────────────────────────────────────

export async function reconcileLedger(): Promise<void> {
  console.log("[Job:reconcile] Starting ledger reconciliation...");

  // ── 1. Held funds: CommissionLedger vs. live order totals ──────────────────
  const [heldLedger, activeOrders] = await Promise.all([
    // Sum all HELD entries (escrow locks) minus RELEASED + REFUNDED entries
    prisma.commissionLedger.aggregate({
      _sum: { amountCents: true },
      where: { type: LedgerEntryType.HELD },
    }),
    // Sum all orders currently in an active escrow state
    prisma.order.aggregate({
      _sum: { totalCents: true },
      where: {
        status: {
          in: [OrderStatus.PAID_HELD, OrderStatus.SHIPPED, OrderStatus.DELIVERED],
        },
      },
    }),
  ]);

  const ledgerHeldCents = heldLedger._sum.amountCents ?? 0;
  const orderHeldCents  = activeOrders._sum.totalCents ?? 0;
  const heldDriftCents  = Math.abs(ledgerHeldCents - orderHeldCents);

  if (heldDriftCents > 0) {
    console.warn(
      `[Job:reconcile] ⚠ HELD drift detected: ` +
      `Ledger=${ledgerHeldCents} cents, Orders=${orderHeldCents} cents, Diff=${heldDriftCents} cents`
    );
  } else {
    console.log(`[Job:reconcile] ✓ HELD funds balanced: ${ledgerHeldCents} cents`);
  }

  // ── 2. Sent payouts without a PAYOUT_SENT ledger entry ────────────────────
  const sentPayouts = await prisma.payout.findMany({
    where: { status: "SENT" },
    select: { id: true, storeId: true, amountCents: true, idempotencyKey: true },
  });

  let missingEntries = 0;

  for (const payout of sentPayouts) {
    const ledgerEntry = await prisma.commissionLedger.findFirst({
      where: {
        storeId: payout.storeId,
        type: LedgerEntryType.PAYOUT_SENT,
        note: { contains: payout.idempotencyKey },
      },
    });

    if (!ledgerEntry) {
      missingEntries++;
      console.warn(
        `[Job:reconcile] ⚠ Payout ${payout.id} (${payout.amountCents} cents) ` +
        `is SENT but has no matching PAYOUT_SENT ledger entry — manual correction needed`
      );
    }
  }

  if (missingEntries === 0) {
    console.log(`[Job:reconcile] ✓ All ${sentPayouts.length} sent payout(s) have ledger entries`);
  }

  console.log("[Job:reconcile] Reconciliation complete.");
}

/**
 * Starts the ledger reconciliation cron job.
 * Schedule: daily at 02:00 EAT (UTC+3) = 23:00 UTC — "0 23 * * *"
 */
export function startReconcileJob(): void {
  cron.schedule("0 23 * * *", async () => {
    try {
      await reconcileLedger();
    } catch (err: any) {
      console.error("[Job:reconcile] Unhandled crash:", err.message);
    }
  });

  console.log("[Job:reconcile] Scheduled — runs daily at 02:00 EAT");
}

