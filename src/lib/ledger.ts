import { prisma } from "../db.js";
import { Prisma } from "../generated/client.js";
import { LedgerEntryType } from "../generated/enums.js";

// Supports executing within an ongoing database transaction or standalone
type DbClient = typeof prisma | Prisma.TransactionClient;

export interface RecordLedgerParams {
  orderId?: string | null;
  storeId: string;
  amountCents: number;
  note?: string;
}

export interface StoreBalance {
  availableCents: number;
  heldCents: number;
  releasedCents: number;
  payoutsSentCents: number;
  codCommissionOwedCents: number;
}

/**
 * Append-only ledger helper functions.
 * Ledger rows are never edited or deleted — corrections and movements are always new rows.
 */
export const ledger = {
  /**
   * Appends a HELD entry: Gross payment funds locked in escrow.
   */
  async recordHeld(params: RecordLedgerParams, db: DbClient = prisma) {
    return db.commissionLedger.create({
      data: {
        orderId: params.orderId || null,
        storeId: params.storeId,
        type: LedgerEntryType.HELD,
        amountCents: params.amountCents,
        note: params.note || "Gross funds held in escrow",
      },
    });
  },

  /**
   * Appends a COMMISSION entry: Qeto platform fee earned on release.
   */
  async recordCommission(params: RecordLedgerParams, db: DbClient = prisma) {
    return db.commissionLedger.create({
      data: {
        orderId: params.orderId || null,
        storeId: params.storeId,
        type: LedgerEntryType.COMMISSION,
        amountCents: params.amountCents,
        note: params.note || "Qeto platform commission",
      },
    });
  },

  /**
   * Appends a RELEASED entry: Seller net funds cleared for payout.
   */
  async recordReleased(params: RecordLedgerParams, db: DbClient = prisma) {
    return db.commissionLedger.create({
      data: {
        orderId: params.orderId || null,
        storeId: params.storeId,
        type: LedgerEntryType.RELEASED,
        amountCents: params.amountCents,
        note: params.note || "Net seller funds released for payout",
      },
    });
  },

  /**
   * Appends a PAYOUT_SENT entry: Outbound withdrawal transferred to merchant bank/wallet.
   */
  async recordPayoutSent(params: RecordLedgerParams, db: DbClient = prisma) {
    return db.commissionLedger.create({
      data: {
        orderId: params.orderId || null,
        storeId: params.storeId,
        type: LedgerEntryType.PAYOUT_SENT,
        amountCents: params.amountCents,
        note: params.note || "Payout transfer completed",
      },
    });
  },

  /**
   * Appends a REFUNDED entry: Funds returned to buyer.
   */
  async recordRefunded(params: RecordLedgerParams, db: DbClient = prisma) {
    return db.commissionLedger.create({
      data: {
        orderId: params.orderId || null,
        storeId: params.storeId,
        type: LedgerEntryType.REFUNDED,
        amountCents: params.amountCents,
        note: params.note || "Refund issued to buyer",
      },
    });
  },

  /**
   * Appends a COD_COMMISSION_OWED entry: Commission owed on cash-on-delivery order.
   */
  async recordCodCommissionOwed(params: RecordLedgerParams, db: DbClient = prisma) {
    return db.commissionLedger.create({
      data: {
        orderId: params.orderId || null,
        storeId: params.storeId,
        type: LedgerEntryType.COD_COMMISSION_OWED,
        amountCents: params.amountCents,
        note: params.note || "COD order commission owed",
      },
    });
  },

  /**
   * Computes a store's financial balances directly from the append-only ledger.
   */
  async getStoreBalance(storeId: string, db: DbClient = prisma): Promise<StoreBalance> {
    const entries = await db.commissionLedger.findMany({
      where: { storeId },
    });

    let heldCents = 0;
    let releasedCents = 0;
    let payoutsSentCents = 0;
    let codCommissionOwedCents = 0;

    for (const entry of entries) {
      switch (entry.type) {
        case LedgerEntryType.HELD:
          heldCents += entry.amountCents;
          break;
        case LedgerEntryType.RELEASED:
          releasedCents += entry.amountCents;
          break;
        case LedgerEntryType.PAYOUT_SENT:
          payoutsSentCents += entry.amountCents;
          break;
        case LedgerEntryType.COD_COMMISSION_OWED:
          codCommissionOwedCents += entry.amountCents;
          break;
        default:
          break;
      }
    }

    const availableCents = Math.max(0, releasedCents - payoutsSentCents - codCommissionOwedCents);

    return {
      availableCents,
      heldCents,
      releasedCents,
      payoutsSentCents,
      codCommissionOwedCents,
    };
  },
};

