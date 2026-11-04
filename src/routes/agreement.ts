import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { getParam } from "../lib/params.js";

export const agreementRouter = Router();

// Current active agreement version in the platform
export const CURRENT_AGREEMENT_VERSION = "v1.0";

export const CURRENT_TERMS = {
  version: CURRENT_AGREEMENT_VERSION,
  title: "Qeto Merchant Terms & Escrow Commission Agreement",
  effectiveDate: "2026-10-01",
  summary: {
    freeTrialDays: 7,
    freeTrialCommissionBps: 0, // 0% during 7-day trial
    standardCommissionBps: 300, // 3% standard rate
    shippingDeadlineDays: 3,
    buyerProtectionWindowHours: 24,
    codDebtLimitCents: 50000, // 500 ETB max unpaid COD commission before suspension
    minimumPayoutCents: 5000, // 50 ETB minimum payout transfer
  },
  sections: [
    {
      title: "1. 7-Day Free Trial",
      body: "New merchants receive a 7-day free trial starting immediately upon registration. During the trial period, Qeto charges 0% platform commission on all completed sales. Escrow protection still applies to all transactions during the trial.",
    },
    {
      title: "2. Escrow & Hold Until Delivery",
      body: "All online payments made by buyers via Telebirr or CBE Birr are held safely in escrow. Funds remain locked until the buyer enters the 4-digit delivery code or confirms receipt. After delivery confirmation, a 24-hour buyer protection window begins before net funds are released to the merchant's available balance.",
    },
    {
      title: "3. Platform Commission & Split",
      body: "Following the free trial, Qeto collects a 3% platform commission on each completed sale. Commission is deducted automatically when escrow funds are released. In the event of a full refund to the buyer, 0% commission is charged.",
    },
    {
      title: "4. Shipping Deadline & Auto-Refund",
      body: "Merchants agree to fulfill and mark orders as SHIPPED within 3 days of payment capture. If the shipping deadline passes without the order being shipped, the order is automatically cancelled and a full refund is returned to the buyer.",
    },
    {
      title: "5. Cash on Delivery (COD) & Commission Owed",
      body: "For cash-on-delivery orders, Qeto's commission cannot be captured at checkout and is recorded as OWED in the ledger. Owed commission is automatically deducted from future online payouts. If unpaid COD commission exceeds 500 ETB, the store may be suspended from accepting new COD orders until settled.",
    },
    {
      title: "6. Disputes & Resolution",
      body: "Buyers or merchants may file a dispute prior to funds release. Both parties have 48 hours to submit messages and photo evidence. Qeto platform administration evaluates evidence and issues a binding decision (Full Refund, Full Release, or Partial Split).",
    },
  ],
};

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
const acceptAgreementSchema = z.object({
  version: z.string().min(1, "Agreement version is required"),
  storeId: z.string().optional(),
});

/**
 * Extracts the real client IP address from request headers or socket.
 */
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "0.0.0.0";
}

// =============================================================
// AGREEMENT ROUTES
// =============================================================

/**
 * GET /api/agreement/current
 * Public endpoint: Returns the full text and parameters of the current agreement.
 * Frontend displays this in Step 2 of merchant onboarding or legal review.
 */
agreementRouter.get("/current", (_req: Request, res: Response) => {
  res.json({
    agreement: CURRENT_TERMS,
  });
});

/**
 * GET /api/agreement/status
 * Protected endpoint: Returns agreement acceptance status for the authenticated user
 * and optionally for a specific store.
 */
agreementRouter.get("/status", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = req.query.storeId as string | undefined;

    // Check user-level agreement acceptance
    const userAcceptance = await prisma.agreementAcceptance.findFirst({
      where: {
        userId: req.userId!,
        version: CURRENT_AGREEMENT_VERSION,
      },
      orderBy: { acceptedAt: "desc" },
    });

    let storeAcceptance = null;
    if (storeId) {
      storeAcceptance = await prisma.agreementAcceptance.findUnique({
        where: { storeId },
      });
    }

    const hasAccepted = Boolean(storeAcceptance || userAcceptance);

    res.json({
      hasAccepted,
      currentVersion: CURRENT_AGREEMENT_VERSION,
      userAcceptance: userAcceptance
        ? {
            id: userAcceptance.id,
            version: userAcceptance.version,
            acceptedAt: userAcceptance.acceptedAt,
            ip: userAcceptance.ip,
          }
        : null,
      storeAcceptance: storeAcceptance
        ? {
            id: storeAcceptance.id,
            storeId: storeAcceptance.storeId,
            version: storeAcceptance.version,
            acceptedAt: storeAcceptance.acceptedAt,
          }
        : null,
    });
  } catch (error: any) {
    console.error("Get agreement status error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/agreement/accept
 * Protected endpoint: Merchant signs the terms agreement.
 * Records the exact version, timestamp, client IP, and User-Agent for legal proof.
 */
agreementRouter.post("/accept", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = acceptAgreementSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { version, storeId } = parseResult.data;

    if (version !== CURRENT_AGREEMENT_VERSION) {
      res.status(400).json({
        error: `Invalid agreement version. The active version is ${CURRENT_AGREEMENT_VERSION}.`,
      });
      return;
    }

    // If storeId is provided, verify caller owns the store
    if (storeId) {
      const store = await prisma.store.findUnique({
        where: { id: storeId },
        select: { id: true, ownerId: true },
      });

      if (!store) {
        res.status(404).json({ error: "Store not found" });
        return;
      }

      if (store.ownerId !== req.userId) {
        res.status(403).json({ error: "Forbidden: You do not own this store" });
        return;
      }
    }

    const clientIp = getClientIp(req);
    const userAgent = req.headers["user-agent"] || null;

    // Upsert or create agreement record
    let acceptance;
    if (storeId) {
      acceptance = await prisma.agreementAcceptance.upsert({
        where: { storeId },
        create: {
          userId: req.userId!,
          storeId,
          version,
          ip: clientIp,
          userAgent,
        },
        update: {
          version,
          acceptedAt: new Date(),
          ip: clientIp,
          userAgent,
        },
      });
    } else {
      acceptance = await prisma.agreementAcceptance.create({
        data: {
          userId: req.userId!,
          version,
          ip: clientIp,
          userAgent,
        },
      });
    }

    res.status(200).json({
      message: "Agreement accepted successfully",
      acceptance: {
        id: acceptance.id,
        version: acceptance.version,
        storeId: acceptance.storeId,
        acceptedAt: acceptance.acceptedAt,
        ip: acceptance.ip,
      },
    });
  } catch (error: any) {
    console.error("Accept agreement error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/agreement/history
 * Protected endpoint: Returns all agreement acceptances for the authenticated merchant.
 */
agreementRouter.get("/history", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const history = await prisma.agreementAcceptance.findMany({
      where: { userId: req.userId! },
      orderBy: { acceptedAt: "desc" },
      include: {
        store: { select: { id: true, name: true, slug: true } },
      },
    });

    res.json({
      history: history.map((item) => ({
        id: item.id,
        version: item.version,
        storeId: item.storeId,
        storeName: item.store?.name || null,
        acceptedAt: item.acceptedAt,
        ip: item.ip,
      })),
    });
  } catch (error: any) {
    console.error("Get agreement history error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
