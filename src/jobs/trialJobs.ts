import cron from "node-cron";
import { prisma } from "../db.js";
import { StoreStatus } from "../generated/enums.js";

// ─────────────────────────────────────────────────────────────────────────────
// JOB: Trial Expiry — daily at 00:30 EAT (21:30 UTC previous day)
//
// Every store starts on a free TRIAL period (trialEndsAt set at creation).
// Once the trial expires, this job transitions the store status:
//   TRIAL → SUSPENDED  (trialEndsAt <= now)
//
// A suspended store's products are still readable but no new orders can be
// placed (the order creation route checks store.status !== SUSPENDED).
// Merchants can re-activate by subscribing (handled via admin or future billing route).
// ─────────────────────────────────────────────────────────────────────────────

export async function expireTrialStores(): Promise<void> {
  const now = new Date();

  const expiredTrials = await prisma.store.findMany({
    where: {
      status: StoreStatus.TRIAL,
      trialEndsAt: { lte: now },
    },
    select: { id: true, name: true, slug: true, trialEndsAt: true },
  });

  if (expiredTrials.length === 0) {
    console.log("[Job:trialJobs] No expired trials to process.");
    return;
  }

  console.log(`[Job:trialJobs] Suspending ${expiredTrials.length} expired trial store(s)...`);

  for (const store of expiredTrials) {
    try {
      await prisma.store.update({
        where: { id: store.id },
        data: { status: StoreStatus.SUSPENDED },
      });

      console.log(
        `[Job:trialJobs] ✓ Suspended store "${store.name}" (${store.slug}) — ` +
        `trial ended at ${store.trialEndsAt?.toISOString()}`
      );
    } catch (err: any) {
      console.error(`[Job:trialJobs] ✗ Failed to suspend store ${store.id}:`, err.message);
    }
  }
}

/**
 * Starts the trial expiry cron job.
 * Schedule: daily at 00:30 EAT (UTC+3) = 21:30 UTC previous day — "30 21 * * *"
 */
export function startTrialJobsJob(): void {
  cron.schedule("30 21 * * *", async () => {
    try {
      await expireTrialStores();
    } catch (err: any) {
      console.error("[Job:trialJobs] Unhandled crash:", err.message);
    }
  });

  console.log("[Job:trialJobs] Scheduled — runs daily at 00:30 EAT");
}
