import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { OrderStatus, DisputeStatus, DisputeDecision, PayoutStatus, LedgerEntryType } from "../generated/enums.js";
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

