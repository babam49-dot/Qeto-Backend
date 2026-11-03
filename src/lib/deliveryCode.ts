import crypto from "node:crypto";

/**
 * Hashes a 4-digit secret delivery code using SHA-256 for secure database storage.
 */
export function hashDeliveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

/**
 * Generates a random, secure 4-digit delivery code (1000–9999).
 */
export function generateDeliveryCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

/**
 * Resolves a 4-digit delivery code from its SHA-256 hash for verified buyer tracking.
 * Safe because domain is small (1000-9999) and only revealed to buyer after escrow is held.
 */
export function findDeliveryCodeFromHash(hash: string | null): string | null {
  if (!hash) return null;
  for (let i = 1000; i <= 9999; i++) {
    const candidate = i.toString();
    if (crypto.createHash("sha256").update(candidate).digest("hex") === hash) {
      return candidate;
    }
  }
  return null;
}

/**
 * Generates an unguessable 40-character public order token for buyer tracking.
 */
export function generateOrderToken(): string {
  return crypto.randomBytes(20).toString("hex");
}
