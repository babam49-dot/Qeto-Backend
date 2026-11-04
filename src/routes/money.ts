import { Router, Response } from "express";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { OrderStatus, LedgerEntryType } from "../generated/enums.js";
import { getParam } from "../lib/params.js";
import { centsToETB, calculateCommission } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";

export const moneyRouter = Router();

// Protect all money endpoints with merchant authentication
moneyRouter.use(requireAuth);

/**
 * Helper: Verifies that the store exists and caller is the owner.
 */
async function verifyStoreOwnership(storeId: string, userId: string, res: Response) {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    include: { payoutAccount: true },
  });

  if (!store) {
    res.status(404).json({ error: "Store not found" });
    return null;
  }

  if (store.ownerId !== userId) {
    res.status(403).json({ error: "Forbidden: You do not own this store" });
    return null;
  }

  return store;
}

/**
 * Formats remaining time until a future target date.
 */
function formatCountdown(targetDate: Date | null): {
  isExpired: boolean;
  hoursRemaining: number;
  minutesRemaining: number;
  label: string;
} {
  if (!targetDate) {
    return { isExpired: true, hoursRemaining: 0, minutesRemaining: 0, label: "None" };
  }

  const now = Date.now();
  const diffMs = targetDate.getTime() - now;

  if (diffMs <= 0) {
    return { isExpired: true, hoursRemaining: 0, minutesRemaining: 0, label: "Ready for release" };
  }

  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return {
    isExpired: false,
    hoursRemaining: hours,
    minutesRemaining: minutes,
    label: hours > 0 ? `Unlocks in ${hours}h ${minutes}m` : `Unlocks in ${minutes}m`,
  };
}

// =============================================================
// MERCHANT MONEY ROUTES
// =============================================================

/**
 * GET /api/money/summary/:storeId
 * Powers the merchant app "Money" screen (Screen 7.3 in design).
 * Returns real-time financial metrics calculated from the append-only ledger:
 * - Gross sales
 * - Qeto platform commission deducted
 * - Funds held in escrow (processing orders)
 * - Available soon (delivered orders in 24h protection window)
 * - Released / Available to withdraw now
 * - Total payouts already sent to bank/Telebirr
 * - COD commission owed
 */
moneyRouter.get("/summary/:storeId", async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await verifyStoreOwnership(storeId, req.userId!, res);
    if (!store) return;

    // 1. Calculate store balance from append-only ledger
    const [balance, commissionAgg] = await Promise.all([
      ledger.getStoreBalance(storeId),
      prisma.commissionLedger.aggregate({
        _sum: { amountCents: true },
        where: {
          storeId,
          type: LedgerEntryType.COMMISSION,
        },
      }),
    ]);

    const qetoCommissionCents = commissionAgg._sum.amountCents || 0;

    // 2. Count and calculate orders currently in the 24h DELIVERED protection window ("Available soon")
    const deliveredOrders = await prisma.order.findMany({
      where: {
        storeId,
        status: OrderStatus.DELIVERED,
      },
      select: {
        id: true,
        totalCents: true,
      },
    });

    const availableSoonGrossCents = deliveredOrders.reduce((sum, o) => sum + o.totalCents, 0);
    const availableSoonNetCents = deliveredOrders.reduce((sum, o) => {
      const { merchantNetCents } = calculateCommission(o.totalCents, store.commissionBps);
      return sum + merchantNetCents;
    }, 0);

    // 3. Gross sales volume from all completed/active escrow orders
    const grossAggregate = await prisma.order.aggregate({
      _sum: { totalCents: true },
      where: {
        storeId,
        status: {
          in: [OrderStatus.PAID_HELD, OrderStatus.SHIPPED, OrderStatus.DELIVERED, OrderStatus.RELEASED],
        },
      },
    });
    const grossSalesCents = grossAggregate._sum.totalCents || 0;

    // 4. Fetch the 5 most recent released orders with per-order fee breakdown
    const recentReleasedOrders = await prisma.order.findMany({
      where: {
        storeId,
        status: OrderStatus.RELEASED,
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        orderToken: true,
        customerName: true,
        totalCents: true,
        deliveredAt: true,
        createdAt: true,
      },
    });

    const breakdownItems = recentReleasedOrders.map((order) => {
      const { commissionCents, merchantNetCents } = calculateCommission(
        order.totalCents,
        store.commissionBps
      );
      return {
        orderId: order.id,
        orderToken: order.orderToken,
        customerName: order.customerName,
        grossCents: order.totalCents,
        grossETB: centsToETB(order.totalCents),
        commissionCents,
        commissionETB: centsToETB(commissionCents),
        merchantNetCents,
        merchantNetETB: centsToETB(merchantNetCents),
        completedAt: order.deliveredAt || order.createdAt,
      };
    });

    res.json({
      summary: {
        grossSalesCents,
        grossSalesETB: centsToETB(grossSalesCents),
        commissionBps: store.commissionBps,
        commissionRateFormatted: `${(store.commissionBps / 100).toFixed(2)}%`,
        qetoCommissionCents,
        qetoCommissionETB: centsToETB(qetoCommissionCents),
        heldInEscrowCents: balance.heldCents,
        heldInEscrowETB: centsToETB(balance.heldCents),
        availableSoonCents: availableSoonNetCents,
        availableSoonETB: centsToETB(availableSoonNetCents),
        availableSoonOrdersCount: deliveredOrders.length,
        releasedCents: balance.releasedCents,
        releasedETB: centsToETB(balance.releasedCents),
        payoutsSentCents: balance.payoutsSentCents,
        payoutsSentETB: centsToETB(balance.payoutsSentCents),
        availableCents: balance.availableCents,
        availableETB: centsToETB(balance.availableCents),
        codCommissionOwedCents: balance.codCommissionOwedCents,
        codCommissionOwedETB: centsToETB(balance.codCommissionOwedCents),
      },
      payoutAccount: store.payoutAccount
        ? {
          bankName: store.payoutAccount.bankName,
          accountNumberLast4: store.payoutAccount.accountNumber.slice(-4),
          accountName: store.payoutAccount.accountName,
        }
        : null,
      recentEarnings: breakdownItems,
    });
  } catch (error: any) {
    console.error("Get money summary error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/money/held/:storeId
 * Lists all orders currently locked in escrow for this store:
 * - PAID_HELD (awaiting merchant shipment)
 * - SHIPPED (in transit to buyer)
 * - DELIVERED (in 24-hour buyer protection countdown)
 * - DISPUTED (escrow release frozen pending admin decision)
 */
moneyRouter.get("/held/:storeId", async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await verifyStoreOwnership(storeId, req.userId!, res);
    if (!store) return;

    const heldOrders = await prisma.order.findMany({
      where: {
        storeId,
        status: {
          in: [
            OrderStatus.PAID_HELD,
            OrderStatus.SHIPPED,
            OrderStatus.DELIVERED,
            OrderStatus.DISPUTED,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      include: {
        items: {
          select: {
            quantity: true,
            variant: { select: { label: true } },
          },
        },
        dispute: {
          select: { id: true, status: true, reason: true },
        },
      },
    });

    const now = new Date();

    const formattedOrders = heldOrders.map((order) => {
      const { commissionCents, merchantNetCents } = calculateCommission(
        order.totalCents,
        store.commissionBps
      );

      // Calculate countdown for DELIVERED orders
      const countdown = order.status === OrderStatus.DELIVERED ? formatCountdown(order.releaseAt) : null;

      // Calculate ship deadline for PAID_HELD orders
      const shipRemaining =
        order.status === OrderStatus.PAID_HELD && order.shipDeadline
          ? Math.max(0, Math.ceil((order.shipDeadline.getTime() - now.getTime()) / (1000 * 60 * 60)))
          : null;

      return {
        id: order.id,
        orderToken: order.orderToken,
        customerName: order.customerName,
        phone: order.phone,
        totalCents: order.totalCents,
        totalETB: centsToETB(order.totalCents),
        expectedCommissionETB: centsToETB(commissionCents),
        expectedNetETB: centsToETB(merchantNetCents),
        status: order.status,
        itemCount: order.items.reduce((sum, i) => sum + i.quantity, 0),
        shipDeadline: order.shipDeadline,
        hoursUntilShipDeadline: shipRemaining,
        releaseAt: order.releaseAt,
        protectionCountdown: countdown,
        isDisputed: Boolean(order.dispute),
        disputeReason: order.dispute?.reason || null,
        createdAt: order.createdAt,
      };
    });

    const totalHeldCents = heldOrders.reduce((sum, o) => sum + o.totalCents, 0);

    res.json({
      totalHeldOrders: heldOrders.length,
      totalHeldCents,
      totalHeldETB: centsToETB(totalHeldCents),
      orders: formattedOrders,
    });
  } catch (error: any) {
    console.error("Get held money error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/money/ledger/:storeId
 * Paginated audit trail of all ledger entries for this store:
 * - HELD: escrow lock on payment
 * - RELEASED: merchant net earnings cleared
 * - COMMISSION: Qeto platform cut
 * - REFUNDED: order refund
 * - PAYOUT_SENT: transfer to merchant bank account
 * - COD_COMMISSION_OWED: cash on delivery unpaid platform cut
 */
moneyRouter.get("/ledger/:storeId", async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await verifyStoreOwnership(storeId, req.userId!, res);
    if (!store) return;

    const typeParam = req.query.type as string | undefined;
    const pageNum = Math.max(1, parseInt(req.query.page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { storeId };
    if (typeParam && Object.values(LedgerEntryType).includes(typeParam as LedgerEntryType)) {
      where.type = typeParam as LedgerEntryType;
    }

    const [entries, totalCount] = await Promise.all([
      prisma.commissionLedger.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
      }),
      prisma.commissionLedger.count({ where }),
    ]);

    res.json({
      entries: entries.map((entry) => ({
        id: entry.id,
        orderId: entry.orderId,
        type: entry.type,
        amountCents: entry.amountCents,
        amountETB: centsToETB(entry.amountCents),
        note: entry.note,
        createdAt: entry.createdAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error: any) {
    console.error("Get store ledger error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
