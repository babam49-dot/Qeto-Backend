import cron from "node-cron";
import { prisma } from "../db.js";
import { PayoutStatus } from "../generated/enums.js";
import { createChapaPayout } from "../lib/chapa.js";
import { ledger } from "../lib/ledger.js";

// ─────────────────────────────────────────────────────────────────────────────
// JOB: Payout Sender — daily at 08:00 EAT (05:00 UTC)
//
// Scans all Payout records with status PENDING and retries sending them via
// the Chapa Transfer API. This covers two scenarios:
//   • Payouts that failed to dispatch during the initial POST /api/payouts/request
//     (e.g. Chapa gateway timeout — record was created but not sent).
//   • Payouts that were submitted but remained PENDING from a previous run.
//
// On success:  Payout → SENT, CommissionLedger ← PAYOUT_SENT entry.
// On failure:  Payout → FAILED, failureReason updated.
// ─────────────────────────────────────────────────────────────────────────────

export async function retryPendingPayouts(): Promise<void> {
  const pendingPayouts = await prisma.payout.findMany({
    where: { status: PayoutStatus.PENDING },
    include: { store: { include: { payoutAccount: true } } },
  });

  if (pendingPayouts.length === 0) {
    console.log("[Job:payoutSender] No pending payouts to retry.");
    return;
  }

  console.log(`[Job:payoutSender] Retrying ${pendingPayouts.length} pending payout(s)...`);

  for (const payout of pendingPayouts) {
    const account = payout.store.payoutAccount;

    if (!account) {
      console.warn(`[Job:payoutSender] ⚠ Store ${payout.storeId} has no payout account — skipping`);
      continue;
    }

    try {
      const chapaResult = await createChapaPayout({
        amount: (payout.amountCents / 100).toFixed(2),
        currency: "ETB",
        accountName: account.accountName,
        accountNumber: account.accountNumber,
        bankCode: account.bankCode,
        bankName: account.bankName,
        reference: payout.idempotencyKey,
      });

      if (chapaResult.success) {
        await prisma.$transaction(
          async (tx) => {
            await tx.payout.update({
              where: { id: payout.id },
              data: {
                status: PayoutStatus.SENT,
                providerRef: chapaResult.providerRef || null,
                processedAt: new Date(),
              },
            });

            // Record the deduction in the append-only ledger if not already recorded
            // (idempotent: CommissionLedger rows are keyed by orderId+type, but payout rows
            // use idempotencyKey — we guard against double-entry by checking first)
            const alreadyRecorded = await tx.commissionLedger.findFirst({
              where: { note: { contains: payout.idempotencyKey } },
            });

            if (!alreadyRecorded) {
              await ledger.recordPayoutSent(
                {
                  storeId: payout.storeId,
                  amountCents: payout.amountCents,
                  note: `Retry payout to ${account.bankName} (${account.accountNumber}). Ref: ${chapaResult.providerRef || payout.idempotencyKey}`,
                },
                tx
              );
            }
          },
          { timeout: 20000, maxWait: 10000 }
        );

        console.log(`[Job:payoutSender] ✓ Sent payout ${payout.id} — ref: ${chapaResult.providerRef}`);
      } else {
        await prisma.payout.update({
          where: { id: payout.id },
          data: {
            status: PayoutStatus.FAILED,
            failureReason: chapaResult.message || "Retry rejected by provider",
          },
        });

        console.error(`[Job:payoutSender] ✗ Payout ${payout.id} failed: ${chapaResult.message}`);
      }
    } catch (err: any) {
      console.error(`[Job:payoutSender] ✗ Unexpected error for payout ${payout.id}:`, err.message);
    }
  }
}

/**
 * Starts the payout retry cron job.
 * Schedule: daily at 08:00 EAT (UTC+3) = 05:00 UTC — "0 5 * * *"
 */
export function startPayoutSenderJob(): void {
  cron.schedule("0 5 * * *", async () => {
    try {
      await retryPendingPayouts();
    } catch (err: any) {
      console.error("[Job:payoutSender] Unhandled crash:", err.message);
    }
  });

  console.log("[Job:payoutSender] Scheduled — runs daily at 08:00 EAT");
}
