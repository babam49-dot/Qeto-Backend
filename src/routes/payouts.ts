import { Router, Response } from "express";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { getEthiopianBanks, createChapaPayout } from "../lib/chapa.js";
import { PayoutStatus } from "../generated/enums.js";
import { getParam } from "../lib/params.js";
import { centsToETB } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";
import { payoutAccountSchema, requestPayoutSchema } from "../schemas/index.js";

export const payoutsRouter = Router();

// =============================================================
// PAYOUT ROUTES
// =============================================================

/**
 * GET /api/payouts/banks
 * Returns list of supported Ethiopian commercial banks and mobile wallets (Telebirr, CBE, etc.).
 * Public endpoint used by frontend dropdowns.
 */
payoutsRouter.get("/banks", async (_req, res: Response) => {
  try {
    const banks = await getEthiopianBanks();
    res.json({ banks });
  } catch (error: any) {
    console.error("Get Ethiopian banks error:", error);
    res.status(500).json({ error: "Failed to retrieve supported banks" });
  }
});

/**
 * GET /api/payouts/account/:storeId
 * Fetches the merchant's saved payout bank/wallet account.
 * Requires merchant authentication and store ownership.
 */
payoutsRouter.get("/account/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { payoutAccount: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    res.json({
      payoutAccount: store.payoutAccount || null,
      hasAccount: Boolean(store.payoutAccount),
    });
  } catch (error: any) {
    console.error("Get payout account error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/payouts/account/:storeId
 * Saves or updates the merchant's payout account (Telebirr or Ethiopian bank account).
 * Requires merchant authentication and store ownership.
 */
payoutsRouter.post("/account/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const parseResult = payoutAccountSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { bankCode, bankName, accountNumber, accountName } = parseResult.data;

    const store = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    const payoutAccount = await prisma.payoutAccount.upsert({
      where: { storeId },
      create: {
        storeId,
        bankCode,
        bankName,
        accountNumber: accountNumber.trim(),
        accountName: accountName.trim(),
      },
      update: {
        bankCode,
        bankName,
        accountNumber: accountNumber.trim(),
        accountName: accountName.trim(),
      },
    });

    res.json({
      message: "Payout account saved successfully",
      payoutAccount,
    });
  } catch (error: any) {
    console.error("Save payout account error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/payouts/balance/:storeId
 * Calculates the merchant's real-time financial balance from the append-only CommissionLedger:
 * - Held: Escrow funds locked during order delivery & 24h protection window.
 * - Released: Net seller funds cleared after protection window expires.
 * - Payouts Sent: Funds already paid out to the merchant's bank/wallet.
 * - COD Commission Owed: Unpaid Qeto platform commission from cash-on-delivery orders.
 * - Available: Released - Payouts Sent - COD Commission Owed (clamped to 0).
 */
payoutsRouter.get("/balance/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { payoutAccount: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Fetch calculated balance from append-only ledger
    const balance = await ledger.getStoreBalance(storeId);

    // Fetch 10 most recent ledger entries for this store
    const recentEntries = await prisma.commissionLedger.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    res.json({
      balance: {
        availableCents: balance.availableCents,
        availableETB: centsToETB(balance.availableCents),
        heldCents: balance.heldCents,
        heldETB: centsToETB(balance.heldCents),
        releasedCents: balance.releasedCents,
        releasedETB: centsToETB(balance.releasedCents),
        payoutsSentCents: balance.payoutsSentCents,
        payoutsSentETB: centsToETB(balance.payoutsSentCents),
        codCommissionOwedCents: balance.codCommissionOwedCents,
        codCommissionOwedETB: centsToETB(balance.codCommissionOwedCents),
      },
      hasPayoutAccount: Boolean(store.payoutAccount),
      payoutAccount: store.payoutAccount,
      recentEntries: recentEntries.map((e) => ({
        id: e.id,
        orderId: e.orderId,
        type: e.type,
        amountCents: e.amountCents,
        amountETB: centsToETB(e.amountCents),
        note: e.note,
        createdAt: e.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("Get payout balance error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/payouts/request
 * Initiates an outbound payout transfer from the merchant's available balance to their bank account or Telebirr.
 * - Enforces minimum withdrawal threshold (50 ETB).
 * - Validates available balance server-side against CommissionLedger.
 * - Idempotency key prevents duplicate transfers.
 * - Calls Chapa Transfer API (or simulation in sandbox mode).
 * - Records Payout record and writes PAYOUT_SENT entry into CommissionLedger on success.
 */
payoutsRouter.post("/request", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = requestPayoutSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, amountETB } = parseResult.data;

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { payoutAccount: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    if (!store.payoutAccount) {
      res.status(400).json({
        error: "No payout account configured. Please link your bank or Telebirr account first.",
      });
      return;
    }

    // Calculate current available balance using ledger helper
    const balance = await ledger.getStoreBalance(storeId);
    const availableCents = balance.availableCents;

    // If amountETB is not specified, default to withdrawing the entire available balance
    const requestedCents = amountETB ? Math.round(amountETB * 100) : availableCents;

    // Minimum payout threshold: 50 ETB (5000 cents)
    const MIN_PAYOUT_CENTS = 5000;
    if (requestedCents < MIN_PAYOUT_CENTS) {
      res.status(400).json({
        error: `Minimum payout withdrawal is ${(MIN_PAYOUT_CENTS / 100).toFixed(2)} ETB.`,
      });
      return;
    }

    if (requestedCents > availableCents) {
      res.status(400).json({
        error: `Insufficient available funds. Requested: ${(requestedCents / 100).toFixed(2)} ETB, Available: ${(availableCents / 100).toFixed(2)} ETB.`,
      });
      return;
    }

    // Unique idempotency key to prevent double payouts
    const idempotencyKey = `payout-${storeId.slice(-6)}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const formattedETB = (requestedCents / 100).toFixed(2);

    // 1. Create PENDING payout record
    const payoutRecord = await prisma.payout.create({
      data: {
        storeId,
        amountCents: requestedCents,
        status: PayoutStatus.PENDING,
        bankName: store.payoutAccount.bankName,
        accountNumber: store.payoutAccount.accountNumber,
        accountName: store.payoutAccount.accountName,
        idempotencyKey,
      },
    });

    // 2. Dispatch payout transfer via Chapa
    const chapaResult = await createChapaPayout({
      amount: formattedETB,
      currency: "ETB",
      accountName: store.payoutAccount.accountName,
      accountNumber: store.payoutAccount.accountNumber,
      bankCode: store.payoutAccount.bankCode,
      bankName: store.payoutAccount.bankName,
      reference: idempotencyKey,
    });

    // 3. Update Payout record and record PAYOUT_SENT in CommissionLedger
    if (chapaResult.success) {
      const isSent = chapaResult.status === "SENT";

      const updatedPayout = await prisma.$transaction(async (tx) => {
        const p = await tx.payout.update({
          where: { id: payoutRecord.id },
          data: {
            status: isSent ? PayoutStatus.SENT : PayoutStatus.PENDING,
            providerRef: chapaResult.providerRef || null,
            processedAt: isSent ? new Date() : null,
          },
        });

        // Deduct from available balance in append-only ledger
        await ledger.recordPayoutSent(
          {
            storeId,
            amountCents: requestedCents,
            note: `Payout transfer to ${store.payoutAccount?.bankName} (${store.payoutAccount?.accountNumber}). Ref: ${chapaResult.providerRef || idempotencyKey}`,
          },
          tx
        );

        return p;
      });

      res.status(200).json({
        message: isSent
          ? "Payout transfer completed successfully"
          : "Payout transfer submitted and is currently pending processing",
        payout: {
          id: updatedPayout.id,
          amountETB: formattedETB,
          status: updatedPayout.status,
          bankName: updatedPayout.bankName,
          accountNumber: updatedPayout.accountNumber,
          accountName: updatedPayout.accountName,
          providerRef: updatedPayout.providerRef,
          isSimulated: chapaResult.isSimulated || false,
          createdAt: updatedPayout.createdAt,
        },
      });
    } else {
      // Payout failed at gateway level
      await prisma.payout.update({
        where: { id: payoutRecord.id },
        data: {
          status: PayoutStatus.FAILED,
          failureReason: chapaResult.message || "Payout transfer rejected by provider",
        },
      });

      res.status(502).json({
        error: "Payout transfer failed",
        details: chapaResult.message,
      });
    }
  } catch (error: any) {
    console.error("Payout request error:", error);
    res.status(500).json({ error: error.message || "Failed to process payout" });
  }
});

/**
 * GET /api/payouts/history/:storeId
 * Lists all previous payout withdrawals for the store with pagination.
 * Requires merchant authentication and store ownership.
 */
payoutsRouter.get("/history/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    const { page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [payouts, totalCount] = await Promise.all([
      prisma.payout.findMany({
        where: { storeId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.payout.count({ where: { storeId } }),
    ]);

    res.json({
      payouts: payouts.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        amountETB: (p.amountCents / 100).toFixed(2),
        status: p.status,
        bankName: p.bankName,
        accountNumber: p.accountNumber,
        accountName: p.accountName,
        providerRef: p.providerRef,
        failureReason: p.failureReason,
        createdAt: p.createdAt,
        processedAt: p.processedAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error: any) {
    console.error("List payouts history error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

