import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { OrderStatus, DisputeStatus, DisputeDecision, PayoutStatus, LedgerEntryType, StoreStatus } from "../generated/enums.js";
import { getParam } from "../lib/params.js";
import { calculateCommission, centsToETB } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";
import { createChapaPayout } from "../lib/chapa.js";

export const adminRouter = Router();

// Protect all admin endpoints with authentication and platform admin verification
adminRouter.use(requireAuth);
adminRouter.use(requireAdmin);

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
const decideDisputeSchema = z.object({
  decision: z.enum([DisputeDecision.REFUND, DisputeDecision.RELEASE, DisputeDecision.PARTIAL]),
  refundCents: z.number().int().positive().optional(),
  note: z.string().max(1000).optional(),
});

const updateAdminStoreSchema = z.object({
  status: z.enum([StoreStatus.TRIAL, StoreStatus.ACTIVE, StoreStatus.SUSPENDED]).optional(),
  commissionBps: z.number().int().min(0, "Commission cannot be negative").max(5000, "Commission cannot exceed 50%").optional(),
  extendTrialDays: z.number().int().positive("Days to extend must be positive").optional(),
  trialEndsAt: z.string().datetime().optional(),
});

// =============================================================
// DISPUTES MANAGEMENT (ADMIN QUEUE)
// =============================================================

/**
 * GET /api/admin/disputes
 * Admin disputes queue with filtering and pagination.
 */
adminRouter.get("/disputes", async (req: AuthRequest, res: Response) => {
  try {
    const statusParam = req.query.status as string | undefined;
    const pageNum = Math.max(1, parseInt(req.query.page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (pageNum - 1) * limitNum;

    const whereClause: any = {};
    if (statusParam && Object.values(DisputeStatus).includes(statusParam as DisputeStatus)) {
      whereClause.status = statusParam as DisputeStatus;
    }

    const [disputes, totalCount] = await Promise.all([
      prisma.dispute.findMany({
        where: whereClause,
        include: {
          order: {
            select: {
              id: true,
              orderToken: true,
              totalCents: true,
              status: true,
              customerName: true,
              phone: true,
              createdAt: true,
              store: {
                select: { id: true, name: true, slug: true, commissionBps: true },
              },
            },
          },
          evidence: {
            orderBy: { createdAt: "desc" },
            take: 3,
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.dispute.count({ where: whereClause }),
    ]);

    res.json({
      disputes: disputes.map((d) => ({
        id: d.id,
        orderId: d.orderId,
        orderToken: d.order.orderToken,
        orderStatus: d.order.status,
        totalCents: d.order.totalCents,
        totalETB: centsToETB(d.order.totalCents),
        customerName: d.order.customerName,
        customerPhone: d.order.phone,
        store: d.order.store,
        reason: d.reason,
        status: d.status,
        decision: d.decision,
        refundCents: d.refundCents,
        refundETB: d.refundCents ? centsToETB(d.refundCents) : null,
        decidedBy: d.decidedBy,
        decidedAt: d.decidedAt,
        createdAt: d.createdAt,
        evidenceCount: d.evidence.length,
        recentEvidence: d.evidence,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error("Admin list disputes error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/admin/disputes/:id
 * Detailed view of a single dispute including all evidence and transaction history.
 */
adminRouter.get("/disputes/:id", async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Dispute ID is required" });
      return;
    }

    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        evidence: {
          orderBy: { createdAt: "asc" },
        },
        order: {
          include: {
            store: true,
            items: {
              include: {
                variant: {
                  include: {
                    product: { select: { name: true, imageUrls: true } },
                  },
                },
              },
            },
            payments: true,
            ledgerEntries: {
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    if (!dispute) {
      res.status(404).json({ error: "Dispute not found" });
      return;
    }

    res.json({
      dispute: {
        id: dispute.id,
        status: dispute.status,
        reason: dispute.reason,
        decision: dispute.decision,
        refundCents: dispute.refundCents,
        refundETB: dispute.refundCents ? centsToETB(dispute.refundCents) : null,
        decidedBy: dispute.decidedBy,
        decidedAt: dispute.decidedAt,
        createdAt: dispute.createdAt,
        evidence: dispute.evidence,
        order: {
          id: dispute.order.id,
          orderToken: dispute.order.orderToken,
          status: dispute.order.status,
          customerName: dispute.order.customerName,
          phone: dispute.order.phone,
          address: dispute.order.address,
          totalCents: dispute.order.totalCents,
          totalETB: centsToETB(dispute.order.totalCents),
          createdAt: dispute.order.createdAt,
          store: dispute.order.store,
          items: dispute.order.items.map((i) => ({
            id: i.id,
            productName: i.variant.product.name,
            variantLabel: i.variant.label,
            quantity: i.quantity,
            priceCents: i.priceCents,
            subtotalETB: centsToETB(i.priceCents * i.quantity),
          })),
          payments: dispute.order.payments,
          ledgerEntries: dispute.order.ledgerEntries,
        },
      },
    });
  } catch (error) {
    console.error("Admin get dispute details error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/admin/disputes/:id/decide
 * Finalize dispute decision:
 *   - REFUND: full refund to buyer, return variant stock, append REFUNDED ledger entry.
 *   - RELEASE: release full escrow to merchant net + Qeto commission.
 *   - PARTIAL: refund partial to buyer, release remainder to merchant net + commission.
 */
adminRouter.post("/disputes/:id/decide", async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Dispute ID is required" });
      return;
    }

    const parseResult = decideDisputeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { decision, refundCents: requestedRefundCents, note } = parseResult.data;

    const dispute = await prisma.dispute.findUnique({
      where: { id },
      include: {
        order: {
          include: {
            store: true,
            items: true,
          },
        },
      },
    });

    if (!dispute) {
      res.status(404).json({ error: "Dispute not found" });
      return;
    }

    if (dispute.status === DisputeStatus.RESOLVED) {
      res.status(400).json({ error: "This dispute has already been resolved" });
      return;
    }

    const { order } = dispute;
    const adminUser = req.userId || "ADMIN";

    // 1. REFUND BUYER
    if (decision === DisputeDecision.REFUND) {
      const updatedDispute = await prisma.$transaction(
        async (tx) => {
          // Restore stock
          for (const item of order.items) {
            await tx.variant.update({
              where: { id: item.variantId },
              data: { stock: { increment: item.quantity } },
            });
          }

          // Record REFUNDED in ledger
          await ledger.recordRefunded(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: order.totalCents,
              note: note || `Dispute resolved by admin: Full refund issued to buyer (${dispute.reason})`,
            },
            tx
          );

          // Update order status
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.REFUNDED },
          });

          // Mark dispute RESOLVED
          return tx.dispute.update({
            where: { id: dispute.id },
            data: {
              status: DisputeStatus.RESOLVED,
              decision: DisputeDecision.REFUND,
              refundCents: order.totalCents,
              decidedBy: adminUser,
              decidedAt: new Date(),
            },
          });
        },
        { timeout: 20000, maxWait: 10000 }
      );

      res.json({
        message: "Dispute resolved with full buyer refund. Stock restored.",
        dispute: updatedDispute,
      });
      return;
    }

    // 2. RELEASE TO MERCHANT
    if (decision === DisputeDecision.RELEASE) {
      const { commissionCents, merchantNetCents } = calculateCommission(
        order.totalCents,
        order.store.commissionBps
      );

      const updatedDispute = await prisma.$transaction(
        async (tx) => {
          // Platform commission
          await ledger.recordCommission(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: commissionCents,
              note: note || `Dispute decided in merchant favor: Platform fee (${order.store.commissionBps / 100}%)`,
            },
            tx
          );

          // Merchant net release
          await ledger.recordReleased(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: merchantNetCents,
              note: note || "Dispute decided in merchant favor: Funds released for payout",
            },
            tx
          );

          // Update order status
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.RELEASED },
          });

          // Mark dispute RESOLVED
          return tx.dispute.update({
            where: { id: dispute.id },
            data: {
              status: DisputeStatus.RESOLVED,
              decision: DisputeDecision.RELEASE,
              refundCents: 0,
              decidedBy: adminUser,
              decidedAt: new Date(),
            },
          });
        },
        { timeout: 20000, maxWait: 10000 }
      );

      res.json({
        message: "Dispute resolved in merchant's favor. Escrow funds released to payout balance.",
        dispute: updatedDispute,
      });
      return;
    }

    // 3. PARTIAL SPLIT
    if (decision === DisputeDecision.PARTIAL) {
      if (!requestedRefundCents || requestedRefundCents <= 0 || requestedRefundCents >= order.totalCents) {
        res.status(400).json({
          error: `Partial dispute decision requires a refundCents between 1 and ${order.totalCents - 1}`,
        });
        return;
      }

      const merchantGross = order.totalCents - requestedRefundCents;
      const { commissionCents, merchantNetCents } = calculateCommission(
        merchantGross,
        order.store.commissionBps
      );

      const updatedDispute = await prisma.$transaction(
        async (tx) => {
          // Record partial refund to buyer
          await ledger.recordRefunded(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: requestedRefundCents,
              note: note || `Dispute split: partial refund of ${centsToETB(requestedRefundCents)} ETB to buyer`,
            },
            tx
          );

          // Record commission on merchant's retained portion
          if (commissionCents > 0) {
            await ledger.recordCommission(
              {
                orderId: order.id,
                storeId: order.storeId,
                amountCents: commissionCents,
                note: `Dispute split: Platform fee on retained portion`,
              },
              tx
            );
          }

          // Record remainder released to merchant
          await ledger.recordReleased(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: merchantNetCents,
              note: `Dispute split: retained funds released for payout`,
            },
            tx
          );

          // Update order status to RELEASED
          await tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.RELEASED },
          });

          // Mark dispute RESOLVED
          return tx.dispute.update({
            where: { id: dispute.id },
            data: {
              status: DisputeStatus.RESOLVED,
              decision: DisputeDecision.PARTIAL,
              refundCents: requestedRefundCents,
              decidedBy: adminUser,
              decidedAt: new Date(),
            },
          });
        },
        { timeout: 20000, maxWait: 10000 }
      );

      res.json({
        message: "Dispute resolved with split decision. Partial refund issued and balance released.",
        dispute: updatedDispute,
      });
      return;
    }
  } catch (error) {
    console.error("Decide dispute error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// PLATFORM ESCROW & FINANCIAL METRICS
// =============================================================

/**
 * GET /api/admin/held-funds
 * Total escrow funds currently locked platform-wide across all merchants.
 */
adminRouter.get("/held-funds", async (_req: AuthRequest, res: Response) => {
  try {
    const activeEscrowStatuses: OrderStatus[] = [
      OrderStatus.PAID_HELD,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.DISPUTED,
    ];

    const [escrowOrders, statusBreakdown] = await Promise.all([
      prisma.order.aggregate({
        where: {
          status: { in: activeEscrowStatuses },
        },
        _sum: { totalCents: true },
        _count: { id: true },
      }),
      prisma.order.groupBy({
        by: ["status"],
        where: {
          status: { in: activeEscrowStatuses },
        },
        _sum: { totalCents: true },
        _count: { id: true },
      }),
    ]);

    const totalHeldCents = escrowOrders._sum.totalCents || 0;

    res.json({
      totalHeldCents,
      totalHeldETB: centsToETB(totalHeldCents),
      activeEscrowOrderCount: escrowOrders._count.id,
      byStatus: statusBreakdown.map((b) => ({
        status: b.status,
        count: b._count.id,
        totalCents: b._sum.totalCents || 0,
        totalETB: centsToETB(b._sum.totalCents || 0),
      })),
    });
  } catch (error) {
    console.error("Admin held-funds error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/admin/income
 * Total Qeto platform commission revenue earned to date.
 */
adminRouter.get("/income", async (_req: AuthRequest, res: Response) => {
  try {
    const commissionAggregate = await prisma.commissionLedger.aggregate({
      where: {
        type: LedgerEntryType.COMMISSION,
      },
      _sum: { amountCents: true },
      _count: { id: true },
    });

    const totalIncomeCents = commissionAggregate._sum.amountCents || 0;

    res.json({
      totalIncomeCents,
      totalIncomeETB: centsToETB(totalIncomeCents),
      commissionTransactionCount: commissionAggregate._count.id,
    });
  } catch (error) {
    console.error("Admin income error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// MERCHANT PAYOUTS QUEUE & RETRY
// =============================================================

/**
 * GET /api/admin/payouts
 * List all merchant payouts across the platform.
 */
adminRouter.get("/payouts", async (req: AuthRequest, res: Response) => {
  try {
    const statusParam = req.query.status as string | undefined;
    const pageNum = Math.max(1, parseInt(req.query.page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (pageNum - 1) * limitNum;

    const whereClause: any = {};
    if (statusParam && Object.values(PayoutStatus).includes(statusParam as PayoutStatus)) {
      whereClause.status = statusParam as PayoutStatus;
    }

    const [payouts, totalCount] = await Promise.all([
      prisma.payout.findMany({
        where: whereClause,
        include: {
          store: {
            select: { id: true, name: true, slug: true, phone: true },
          },
        },
        orderBy: { attempts: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.payout.count({ where: whereClause }),
    ]);

    res.json({
      payouts: payouts.map((p) => ({
        id: p.id,
        store: p.store,
        amountCents: p.amountCents,
        amountETB: centsToETB(p.amountCents),
        status: p.status,
        bankName: p.bankName,
        accountNumber: p.accountNumber,
        accountName: p.accountName,
        providerRef: p.providerRef,
        attempts: p.attempts,
        idempotencyKey: p.idempotencyKey,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error("Admin list payouts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/admin/payouts/:id/retry
 * Retry a failed or pending merchant payout transfer.
 */
adminRouter.post("/payouts/:id/retry", async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Payout ID is required" });
      return;
    }

    const payout = await prisma.payout.findUnique({
      where: { id },
      include: {
        store: {
          include: { payoutAccount: true },
        },
      },
    });

    if (!payout) {
      res.status(404).json({ error: "Payout not found" });
      return;
    }

    if (payout.status === PayoutStatus.SENT) {
      res.status(400).json({ error: "This payout has already been successfully sent" });
      return;
    }

    const chapaResult = await createChapaPayout({
      amount: centsToETB(payout.amountCents),
      accountName: payout.accountName,
      accountNumber: payout.accountNumber,
      bankCode: payout.store.payoutAccount?.bankCode,
      reference: `RETRY-${payout.idempotencyKey}-${Date.now()}`,
    });

    const isSent = chapaResult.success && chapaResult.status === "SENT";

    const updatedPayout = await prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: isSent ? PayoutStatus.SENT : PayoutStatus.FAILED,
        attempts: { increment: 1 },
        providerRef: chapaResult.providerRef || payout.providerRef,
      },
    });

    res.json({
      message: isSent ? "Payout successfully processed" : "Payout retry failed with provider",
      payout: updatedPayout,
      providerMessage: chapaResult.message,
    });
  } catch (error) {
    console.error("Admin retry payout error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// PLATFORM OVERVIEW (DASHBOARD HEADER)
// =============================================================

/**
 * GET /api/admin/overview
 * Returns executive high-level metrics for the platform owner:
 * - Sales through Qeto (gross ETB)
 * - Platform commission earned (ETB)
 * - Active stores count
 * - Trials ending in the next 48 hours
 * - Open disputes count
 */
adminRouter.get("/overview", async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const inTwoDays = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const [
      totalSalesAgg,
      totalCommissionAgg,
      activeStoresCount,
      trialsEndingCount,
      totalStoresCount,
      openDisputesCount,
      pendingPayoutsCount,
    ] = await Promise.all([
      prisma.order.aggregate({
        _sum: { totalCents: true },
        where: {
          status: {
            in: [OrderStatus.PAID_HELD, OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RELEASED],
          },
        },
      }),
      prisma.commissionLedger.aggregate({
        _sum: { amountCents: true },
        where: { type: LedgerEntryType.COMMISSION },
      }),
      prisma.store.count({ where: { status: StoreStatus.ACTIVE } }),
      prisma.store.count({
        where: {
          status: StoreStatus.TRIAL,
          trialEndsAt: { gte: now, lte: inTwoDays },
        },
      }),
      prisma.store.count(),
      prisma.dispute.count({ where: { status: DisputeStatus.OPEN } }),
      prisma.payout.count({ where: { status: PayoutStatus.PENDING } }),
    ]);

    const totalSalesCents = totalSalesAgg._sum.totalCents || 0;
    const totalCommissionCents = totalCommissionAgg._sum.amountCents || 0;

    res.json({
      metrics: {
        totalSalesCents,
        totalSalesETB: centsToETB(totalSalesCents),
        totalCommissionCents,
        totalCommissionETB: centsToETB(totalCommissionCents),
        activeStoresCount,
        trialsEndingCount,
        totalStoresCount,
        openDisputesCount,
        pendingPayoutsCount,
      },
    });
  } catch (error: any) {
    console.error("Admin overview error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// STORE MANAGEMENT
// =============================================================

/**
 * GET /api/admin/stores
 * Lists all registered stores on Qeto with pagination, search, and status filtering.
 */
adminRouter.get("/stores", async (req: AuthRequest, res: Response) => {
  try {
    const statusParam = req.query.status as string | undefined;
    const searchParam = req.query.search as string | undefined;
    const pageNum = Math.max(1, parseInt(req.query.page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};
    if (statusParam && Object.values(StoreStatus).includes(statusParam as StoreStatus)) {
      where.status = statusParam as StoreStatus;
    }
    if (searchParam && searchParam.trim()) {
      const term = searchParam.trim();
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { slug: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { owner: { phone: { contains: term, mode: "insensitive" } } },
      ];
    }

    const now = new Date();

    const [stores, totalCount] = await Promise.all([
      prisma.store.findMany({
        where,
        skip,
        take: limitNum,
        orderBy: { createdAt: "desc" },
        include: {
          owner: {
            select: { id: true, name: true, phone: true, email: true },
          },
          payoutAccount: {
            select: { bankName: true, accountNumber: true },
          },
          agreement: {
            select: { version: true, acceptedAt: true },
          },
          _count: {
            select: { products: true, orders: true },
          },
        },
      }),
      prisma.store.count({ where }),
    ]);

    // Batch query gross sales for these stores
    const storeIds = stores.map((s) => s.id);
    const salesGroup = await prisma.order.groupBy({
      by: ["storeId"],
      _sum: { totalCents: true },
      where: {
        storeId: { in: storeIds },
        status: {
          in: [OrderStatus.PAID_HELD, OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RELEASED],
        },
      },
    });

    const salesMap = new Map<string, number>();
    for (const item of salesGroup) {
      salesMap.set(item.storeId, item._sum.totalCents || 0);
    }

    res.json({
      stores: stores.map((s) => {
        const msRemaining = s.trialEndsAt.getTime() - now.getTime();
        const daysLeft = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
        const grossSalesCents = salesMap.get(s.id) || 0;

        return {
          id: s.id,
          name: s.name,
          slug: s.slug,
          phone: s.phone,
          status: s.status,
          commissionBps: s.commissionBps,
          commissionRateFormatted: `${(s.commissionBps / 100).toFixed(2)}%`,
          trial: {
            trialEndsAt: s.trialEndsAt,
            daysLeft,
            isExpired: s.trialEndsAt <= now,
          },
          owner: s.owner,
          payoutAccount: s.payoutAccount,
          hasAcceptedAgreement: Boolean(s.agreement),
          productCount: s._count.products,
          orderCount: s._count.orders,
          grossSalesCents,
          grossSalesETB: centsToETB(grossSalesCents),
          createdAt: s.createdAt,
        };
      }),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error: any) {
    console.error("Admin list stores error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/admin/stores/:id
 * Fetches detailed info and financial breakdown for a single store.
 */
adminRouter.get("/stores/:id", async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.id);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: {
        owner: { select: { id: true, name: true, phone: true, email: true, createdAt: true } },
        payoutAccount: true,
        agreement: true,
        _count: { select: { products: true, orders: true } },
      },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    // Ledger balance calculation
    const balance = await ledger.getStoreBalance(storeId);

    // Recent 5 orders
    const recentOrders = await prisma.order.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        orderToken: true,
        customerName: true,
        phone: true,
        totalCents: true,
        status: true,
        createdAt: true,
      },
    });

    const now = new Date();
    const daysLeft = Math.max(
      0,
      Math.ceil((store.trialEndsAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    );

    res.json({
      store: {
        id: store.id,
        name: store.name,
        slug: store.slug,
        phone: store.phone,
        status: store.status,
        description: store.description,
        logoUrl: store.logoUrl,
        commissionBps: store.commissionBps,
        commissionRateFormatted: `${(store.commissionBps / 100).toFixed(2)}%`,
        trial: {
          trialEndsAt: store.trialEndsAt,
          daysLeft,
          isExpired: store.trialEndsAt <= now,
        },
        owner: store.owner,
        payoutAccount: store.payoutAccount,
        agreement: store.agreement,
        productCount: store._count.products,
        orderCount: store._count.orders,
        createdAt: store.createdAt,
      },
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
      recentOrders: recentOrders.map((o) => ({
        ...o,
        totalETB: centsToETB(o.totalCents),
      })),
    });
  } catch (error: any) {
    console.error("Admin get store details error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /api/admin/stores/:id
 * Allows the platform owner to:
 * - Extend trial days
 * - Modify custom commission rate (commissionBps)
 * - Change store status (ACTIVE, TRIAL, SUSPENDED)
 */
adminRouter.patch("/stores/:id", async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.id);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const parseResult = updateAdminStoreSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    const { status, commissionBps, extendTrialDays, trialEndsAt } = parseResult.data;

    let updatedTrialEndsAt: Date | undefined = undefined;
    if (trialEndsAt) {
      updatedTrialEndsAt = new Date(trialEndsAt);
    } else if (extendTrialDays) {
      const now = new Date();
      const baseDate = store.trialEndsAt > now ? store.trialEndsAt : now;
      updatedTrialEndsAt = new Date(baseDate.getTime() + extendTrialDays * 24 * 60 * 60 * 1000);
    }

    // Determine status: if extending trial and currently SUSPENDED, restore to TRIAL
    let finalStatus = status;
    if (updatedTrialEndsAt && updatedTrialEndsAt > new Date() && !status && store.status === StoreStatus.SUSPENDED) {
      finalStatus = StoreStatus.TRIAL;
    }

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        ...(finalStatus !== undefined && { status: finalStatus }),
        ...(commissionBps !== undefined && { commissionBps }),
        ...(updatedTrialEndsAt !== undefined && { trialEndsAt: updatedTrialEndsAt }),
      },
    });

    res.json({
      message: "Store updated successfully by admin",
      store: updatedStore,
    });
  } catch (error: any) {
    console.error("Admin update store error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

