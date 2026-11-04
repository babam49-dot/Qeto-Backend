import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { OrderStatus } from "../generated/enums.js";
import { getParam } from "../lib/params.js";
import { hashDeliveryCode } from "../lib/deliveryCode.js";
import { centsToETB, calculateCommission } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";
import { assertCanTransition } from "../lib/stateMachine.js";
import { publicOrdersRouter } from "./publicOrders.js";

export const ordersRouter = Router();

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
const deliveryCodeSchema = z.object({
  deliveryCode: z.string().regex(/^\d{4}$/, "Delivery code must be exactly 4 digits"),
});

// =============================================================
// BACKWARD COMPATIBILITY: PUBLIC / BUYER ROUTE DELEGATION
// =============================================================
ordersRouter.use("/public", publicOrdersRouter);
ordersRouter.post("/", (req: Request, res: Response, next: NextFunction) => {
  publicOrdersRouter(req, res, next);
});

// =============================================================
// MERCHANT / SELLER MANAGEMENT ENDPOINTS (requireAuth)
// =============================================================

/**
 * GET /api/orders/store/:storeId
 * Lists orders for a store owned by the authenticated merchant.
 * Supports filtering by status and pagination.
 */
ordersRouter.get("/store/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const { status, page = "1", limit = "20" } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Verify merchant owns this store
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

    const whereClause: any = { storeId };
    if (status && Object.values(OrderStatus).includes(status as OrderStatus)) {
      whereClause.status = status as OrderStatus;
    }

    const orders = await prisma.order.findMany({
      where: whereClause,
      skip,
      take: limitNum,
      orderBy: { createdAt: "desc" },
      include: {
        items: {
          include: {
            variant: {
              select: {
                label: true,
                product: { select: { name: true, imageUrls: true } },
              },
            },
          },
        },
        dispute: { select: { id: true, status: true, reason: true } },
      },
    });

    const totalCount = await prisma.order.count({ where: whereClause });

    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        orderToken: o.orderToken,
        status: o.status,
        paymentMethod: o.paymentMethod,
        customerName: o.customerName,
        phone: o.phone,
        address: o.address,
        totalCents: o.totalCents,
        totalETB: centsToETB(o.totalCents),
        shipDeadline: o.shipDeadline,
        shippedAt: o.shippedAt,
        deliveredAt: o.deliveredAt,
        releaseAt: o.releaseAt,
        itemCount: o.items.reduce((sum, item) => sum + item.quantity, 0),
        dispute: o.dispute,
        createdAt: o.createdAt,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    });
  } catch (error) {
    console.error("List store orders error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/orders/:id
 * Merchant views complete order details for an order in their store.
 */
ordersRouter.get("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        store: true,
        items: {
          include: {
            variant: {
              include: {
                product: { select: { id: true, name: true, imageUrls: true } },
              },
            },
          },
        },
        payments: true,
        ledgerEntries: true,
        dispute: {
          include: { evidence: true },
        },
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own the store for this order" });
      return;
    }

    res.json({
      order: {
        id: order.id,
        orderToken: order.orderToken,
        storeId: order.storeId,
        storeName: order.store.name,
        status: order.status,
        paymentMethod: order.paymentMethod,
        customerName: order.customerName,
        phone: order.phone,
        address: order.address,
        totalCents: order.totalCents,
        totalETB: centsToETB(order.totalCents),
        shipDeadline: order.shipDeadline,
        shippedAt: order.shippedAt,
        deliveredAt: order.deliveredAt,
        releaseAt: order.releaseAt,
        codeAttempts: order.codeAttempts,
        createdAt: order.createdAt,
        items: order.items,
        payments: order.payments,
        ledgerEntries: order.ledgerEntries,
        dispute: order.dispute,
      },
    });
  } catch (error) {
    console.error("Get order details error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /api/orders/:id/ship
 * Merchant marks the order as shipped / dispatched with courier.
 * Strictly validated by StateMachine (PAID_HELD -> SHIPPED or COD_PENDING -> SHIPPED).
 */
ordersRouter.patch("/:id/ship", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: { store: true },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Validate state machine transition
    assertCanTransition(order.status, OrderStatus.SHIPPED, order.id);

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.SHIPPED,
        shippedAt: new Date(),
      },
    });

    res.json({
      message: "Order marked as SHIPPED successfully",
      order: {
        id: updated.id,
        status: updated.status,
        shippedAt: updated.shippedAt,
      },
    });
  } catch (error: any) {
    console.error("Ship order error:", error);
    res.status(400).json({ error: error.message || "Failed to mark order as shipped" });
  }
});

/**
 * POST /api/orders/:id/confirm-delivery
 * Delivery Handshake: Seller or courier enters the buyer's 4-digit secret delivery code.
 * - Rate-limits after 5 incorrect attempts to prevent guessing.
 * - Compares SHA-256 hash.
 * - On match: transitions order to DELIVERED and activates 24h protection window.
 */
ordersRouter.post("/:id/confirm-delivery", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const parseResult = deliveryCodeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { deliveryCode } = parseResult.data;

    const order = await prisma.order.findUnique({
      where: { id },
      include: { store: true },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Validate state machine transition
    assertCanTransition(order.status, OrderStatus.DELIVERED, order.id);

    // Rate-limit check: lock order if 5 attempts exceeded
    if (order.codeAttempts >= 5) {
      res.status(429).json({
        error: "Maximum delivery code attempts exceeded (5/5). Order is locked for manual review.",
      });
      return;
    }

    // Compare hash of entered code against stored hash
    const inputHash = hashDeliveryCode(deliveryCode);
    if (order.deliveryCodeHash && order.deliveryCodeHash !== inputHash) {
      const remainingAttempts = 4 - order.codeAttempts;
      await prisma.order.update({
        where: { id: order.id },
        data: { codeAttempts: { increment: 1 } },
      });

      res.status(400).json({
        error: `Invalid delivery code. ${remainingAttempts > 0 ? `${remainingAttempts} attempt(s) remaining.` : "Order locked for manual review."}`,
      });
      return;
    }

    const now = new Date();
    const releaseAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.DELIVERED,
        deliveredAt: now,
        releaseAt,
        codeAttempts: 0,
      },
    });

    res.json({
      message: "Handshake verified! Delivery confirmed successfully. 24-hour protection window active.",
      order: {
        id: updated.id,
        status: updated.status,
        deliveredAt: updated.deliveredAt,
        releaseAt: updated.releaseAt,
      },
    });
  } catch (error: any) {
    console.error("Confirm delivery error:", error);
    res.status(400).json({ error: error.message || "Failed to confirm delivery" });
  }
});

/**
 * POST /api/orders/:id/cancel
 * Cancels an order before shipping and restores reserved variant inventory.
 */
ordersRouter.post("/:id/cancel", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: {
        store: true,
        items: true,
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Validate state machine transition
    const targetStatus = order.status === OrderStatus.PAID_HELD ? OrderStatus.REFUNDED : OrderStatus.CANCELLED;
    assertCanTransition(order.status, targetStatus, order.id);

    const cancelledOrder = await prisma.$transaction(
      async (tx) => {
        // 1. Restore inventory for all items in the order
        for (const item of order.items) {
          await tx.variant.update({
            where: { id: item.variantId },
            data: { stock: { increment: item.quantity } },
          });
        }

        // 2. If escrow money was held, transition to REFUNDED and write to ledger
        if (order.status === OrderStatus.PAID_HELD) {
          await ledger.recordRefunded(
            {
              orderId: order.id,
              storeId: order.storeId,
              amountCents: order.totalCents,
              note: "Order cancelled before dispatch - full refund issued to buyer",
            },
            tx
          );

          return tx.order.update({
            where: { id: order.id },
            data: { status: OrderStatus.REFUNDED },
          });
        }

        // 3. Otherwise mark CANCELLED
        return tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.CANCELLED },
        });
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.json({
      message: "Order cancelled and inventory restored to stock",
      order: {
        id: cancelledOrder.id,
        status: cancelledOrder.status,
      },
    });
  } catch (error: any) {
    console.error("Cancel order error:", error);
    res.status(400).json({ error: error.message || "Failed to cancel order" });
  }
});

/**
 * POST /api/orders/:id/release-funds
 * Releases held escrow funds to the merchant after the 24-hour protection window expires.
 * - Strictly asserts transition DELIVERED -> RELEASED via StateMachine.
 * - Deducts Qeto's commission (store.commissionBps / 10000).
 * - Writes COMMISSION and RELEASED entries to the append-only CommissionLedger.
 * - Sets order status to RELEASED.
 */
ordersRouter.post("/:id/release-funds", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const id = getParam(req.params.id);
    if (!id) {
      res.status(400).json({ error: "Order ID is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { id },
      include: { store: true },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Validate state machine transition
    assertCanTransition(order.status, OrderStatus.RELEASED, order.id);

    // Check if 24-hour protection window has ended
    if (order.releaseAt && new Date() < order.releaseAt) {
      const minutesRemaining = Math.ceil((order.releaseAt.getTime() - Date.now()) / (60 * 1000));
      res.status(400).json({
        error: `Protection window is still active. Release available in ${minutesRemaining} minutes.`,
      });
      return;
    }

    const releasedOrder = await prisma.$transaction(
      async (tx) => {
        // Calculate commission and merchant net using shared money utility
        const { commissionCents, merchantNetCents } = calculateCommission(
          order.totalCents,
          order.store.commissionBps
        );

        // Append COMMISSION entry
        await ledger.recordCommission(
          {
            orderId: order.id,
            storeId: order.storeId,
            amountCents: commissionCents,
            note: `Qeto platform commission (${order.store.commissionBps / 100}%)`,
          },
          tx
        );

        // Append RELEASED entry
        await ledger.recordReleased(
          {
            orderId: order.id,
            storeId: order.storeId,
            amountCents: merchantNetCents,
            note: "Merchant net funds released for payout",
          },
          tx
        );

        // Update status to RELEASED
        return tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.RELEASED },
        });
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.json({
      message: "Funds successfully released to merchant payout balance",
      order: {
        id: releasedOrder.id,
        status: releasedOrder.status,
      },
    });
  } catch (error: any) {
    console.error("Release funds error:", error);
    res.status(400).json({ error: error.message || "Failed to release funds" });
  }
});
