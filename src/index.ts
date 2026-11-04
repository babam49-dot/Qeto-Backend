import { app } from "./app.js";
import { startAllJobs } from "./jobs/index.js";

const port = process.env.PORT || 4000;

app.listen(port, () => {
  console.log(`Qeto API running on http://localhost:${port}`);
  // Start all background cron jobs — escrow auto-release, reservation expiry,
  // auto-refund, payout retry, ledger reconciliation, trial expiry.
  startAllJobs();
});
