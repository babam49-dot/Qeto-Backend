// ─────────────────────────────────────────────────────────────────────────────
// src/jobs/index.ts — Qeto Background Job Orchestrator
//
// Registers and starts all cron-based background jobs.
// Call startAllJobs() once at server startup (from src/index.ts).
//
// Job schedule overview:
//   expireReservations  — every 5 min  — PENDING_PAYMENT → EXPIRED (stock released)
//   autoRefundUnshipped — every 30 min — PAID_HELD → REFUNDED (seller missed deadline)
//   autoRelease         — every 15 min — DELIVERED → RELEASED (24h protection expired)
//   payoutSender        — daily 08:00  — retry PENDING payouts via Chapa Transfer API
//   reconcile           — daily 02:00  — audit ledger vs. orders (read-only, log-only)
//   trialJobs           — daily 00:30  — TRIAL → SUSPENDED (trialEndsAt expired)
// ─────────────────────────────────────────────────────────────────────────────

import { startExpireReservationsJob }  from "./expireReservations.js";
import { startAutoRefundUnshippedJob } from "./autoRefundUnshipped.js";
import { startAutoReleaseJob }         from "./autoRelease.js";
import { startPayoutSenderJob }        from "./payoutSender.js";
import { startReconcileJob }           from "./reconcile.js";
import { startTrialJobsJob }           from "./trialJobs.js";

/**
 * Starts all Qeto background cron jobs.
 * Safe to call multiple times — node-cron deduplicate by schedule handle.
 */
export function startAllJobs(): void {
  console.log("[Jobs] Starting all background cron jobs...");

  startExpireReservationsJob();   // every 5 min
  startAutoRefundUnshippedJob();  // every 30 min
  startAutoReleaseJob();          // every 15 min
  startPayoutSenderJob();         // daily 08:00 EAT
  startReconcileJob();            // daily 02:00 EAT
  startTrialJobsJob();            // daily 00:30 EAT

  console.log("[Jobs] All background jobs registered ✓");
}

