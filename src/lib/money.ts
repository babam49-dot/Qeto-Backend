/**
 * Money utilities for Qeto.
 * All amounts inside the database and calculations are integers in santim (1 ETB = 100 santim).
 * This eliminates floating-point rounding bugs across escrow splits, fees, and payouts.
 */

/**
 * Converts integer santim (cents) to a formatted ETB decimal string (e.g. 100000 cents -> "1000.00").
 */
export function centsToETB(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Converts ETB (number or string, e.g. "45.50" or 45.5) to integer santim (cents).
 */
export function etbToCents(amountETB: number | string): number {
  const numeric = typeof amountETB === "string" ? parseFloat(amountETB) : amountETB;
  if (isNaN(numeric) || numeric < 0) {
    throw new Error(`Invalid ETB amount: ${amountETB}`);
  }
  return Math.round(numeric * 100);
}

/**
 * Calculates platform commission and seller net based on basis points (bps).
 * Example: 300 bps = 3% commission.
 * On 1,000 ETB (100,000 cents) with 300 bps:
 * - commissionCents = 3,000 (30 ETB)
 * - merchantNetCents = 97,000 (970 ETB)
 */
export function calculateCommission(
  grossCents: number,
  commissionBps: number
): { commissionCents: number; merchantNetCents: number } {
  if (grossCents < 0) {
    throw new Error("Gross amount cannot be negative");
  }
  const safeBps = Math.max(0, commissionBps);
  const commissionCents = Math.round((grossCents * safeBps) / 10_000);
  const merchantNetCents = grossCents - commissionCents;

  return {
    commissionCents,
    merchantNetCents,
  };
}

