import { Router, Request, Response } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { normalizePhone } from "../lib/auth.js";
import { OrderStatus, LedgerEntryType } from "../generated/enums.js";

export const ordersRouter = Router();

// Helper to safely extract single string route params in Express 5
function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] ?? "";
  return param ?? "";
}

// Helper to hash 4-digit delivery code using SHA-256
export function hashDeliveryCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}

// Helper to generate a random 4-digit delivery code (1000-9999)
export function generateDeliveryCode(): string {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Helper to resolve 4-digit delivery code from its SHA-256 hash for verified buyer tracking
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

// Helper to generate unguessable public order token
export function generateOrderToken(): string {
  return crypto.randomBytes(20).toString("hex");
}

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
const orderItemSchema = z.object({
  variantId: z.string().min(1, "Variant ID is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
});

const createOrderSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  customerName: z.string().min(2, "Customer name must be at least 2 characters").max(100),
  phone: z.string().min(9, "Phone number is required"),
  address: z.string().min(3, "Delivery address is required").max(500),
  paymentMethod: z.enum(["ONLINE", "COD"]).default("ONLINE"),
  items: z.array(orderItemSchema).min(1, "Order must contain at least one item"),
});

const deliveryCodeSchema = z.object({
  deliveryCode: z.string().regex(/^\d{4}$/, "Delivery code must be exactly 4 digits"),
});

const disputeSchema = z.object({
  reason: z.string().min(5, "Dispute reason must be at least 5 characters").max(1000),
  message: z.string().max(2000).optional(),
  imageUrl: z.string().url("Invalid image URL").optional(),
});

// =============================================================
// PUBLIC / BUYER ENDPOINTS
// =============================================================

/**
 * POST /api/orders
 * Public checkout endpoint for buyers.
 * - Validates variant stock availability and calculates total pricing server-side.
 * - Deducts/reserves variant stock atomically inside a database transaction.
 * - Generates unique unguessable order token for buyer tracking.
 * - If ONLINE: sets status PENDING_PAYMENT, 15 min stock reservation, and generates secret 4-digit delivery code.
 * - If COD: sets status COD_PENDING, records COD commission owed in ledger.
 */
ordersRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, customerName, phone: rawPhone, address, paymentMethod, items } = parseResult.data;

    // Validate phone number
    const normalizedPhone = normalizePhone(rawPhone);
    if (!normalizedPhone) {
      res.status(400).json({
        error: "Invalid Ethiopian phone number. Please use format like 0912345678 or +251912345678",
      });
      return;
    }

    // Check store existence and active status
    const store = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.status === "SUSPENDED") {
      res.status(400).json({ error: "This store is currently suspended and cannot accept orders" });
      return;
    }

    // Execute stock validation and order creation inside a transaction
    let rawDeliveryCode: string | null = null;
    let deliveryCodeHash: string | null = null;

    if (paymentMethod === "ONLINE") {
      rawDeliveryCode = generateDeliveryCode();
      deliveryCodeHash = hashDeliveryCode(rawDeliveryCode);
    }

    const orderToken = generateOrderToken();
    const reservationExpiry = paymentMethod === "ONLINE" ? new Date(Date.now() + 15 * 60 * 1000) : null;
    const initialStatus = paymentMethod === "ONLINE" ? OrderStatus.PENDING_PAYMENT : OrderStatus.COD_PENDING;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch all requested variants and lock them for stock check
      const variantIds = items.map((i) => i.variantId);
      const variants = await tx.variant.findMany({
        where: { id: { in: variantIds } },
        include: { product: true },
      });

      if (variants.length !== variantIds.length) {
        throw new Error("One or more selected product variants were not found");
      }

      // 2. Validate stock and compute server-side totals
      let totalCents = 0;
      const verifiedItems: {
        variantId: string;
        quantity: number;
        priceCents: number;
      }[] = [];

      for (const item of items) {
        const variant = variants.find((v) => v.id === item.variantId);
        if (!variant) {
          throw new Error(`Variant ${item.variantId} not found`);
        }

        if (variant.product.storeId !== storeId) {
          throw new Error(`Variant "${variant.label}" does not belong to this store`);
        }

        if (variant.stock < item.quantity) {
          throw new Error(
            `Insufficient stock for "${variant.product.name} - ${variant.label}". Available: ${variant.stock}, requested: ${item.quantity}`
          );
        }

        totalCents += variant.priceCents * item.quantity;
        verifiedItems.push({
          variantId: variant.id,
          quantity: item.quantity,
          priceCents: variant.priceCents,
        });

        // Decrement stock (reserves inventory)
        await tx.variant.update({
          where: { id: variant.id },
          data: { stock: { decrement: item.quantity } },
        });
      }

      // 3. Create the Order
      const newOrder = await tx.order.create({
        data: {
          storeId,
          orderToken,
          status: initialStatus,
          paymentMethod,
          customerName,
          phone: normalizedPhone,
          address,
          totalCents,
          deliveryCodeHash,
          expiresAt: reservationExpiry,
          items: {
            create: verifiedItems,
          },
        },
        include: {
          items: {
            include: {
              variant: {
                include: {
                  product: {
                    select: { name: true, imageUrls: true },
                  },
                },
              },
            },
          },
        },
      });

      // 4. If COD: record commission owed in ledger
      if (paymentMethod === "COD") {
        const commissionAmount = Math.round((totalCents * store.commissionBps) / 10000);
        await tx.commissionLedger.create({
          data: {
            orderId: newOrder.id,
            storeId: store.id,
            type: LedgerEntryType.COD_COMMISSION_OWED,
            amountCents: commissionAmount,
            note: `COD order commission owed (${store.commissionBps / 100}% of ${(totalCents / 100).toFixed(2)} ETB)`,
          },
        });
      }

      return newOrder;
    });

    res.status(201).json({
      message: "Order placed successfully",
      order: {
        id: result.id,
        orderToken: result.orderToken,
        status: result.status,
        paymentMethod: result.paymentMethod,
        customerName: result.customerName,
        phone: result.phone,
        address: result.address,
        totalCents: result.totalCents,
        totalETB: (result.totalCents / 100).toFixed(2),
        expiresAt: result.expiresAt,
        items: result.items,
        deliveryCode: rawDeliveryCode,
      },
    });
  } catch (error: any) {
    console.error("Create order error:", error);
    res.status(400).json({ error: error.message || "Failed to create order" });
  }
});

/**
 * GET /api/orders/public/:orderToken
 * Public tracking page for the customer (no authentication required).
 * Returns order status, item details, tracking milestones, and safe escrow info.
 */
ordersRouter.get("/public/:orderToken", async (req: Request, res: Response) => {
  try {
    const orderToken = getParam(req.params.orderToken);
    if (!orderToken) {
      res.status(400).json({ error: "Order token is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { orderToken },
      include: {
        store: {
          select: { id: true, name: true, slug: true, phone: true, logoUrl: true },
        },
        items: {
          include: {
            variant: {
              include: {
                product: {
                  select: { name: true, imageUrls: true },
                },
              },
            },
          },
        },
        dispute: {
          include: { evidence: true },
        },
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found or invalid tracking link" });
      return;
    }

    // Reveal secret delivery code only once payment is verified into escrow
    const paidStatuses: OrderStatus[] = [
      OrderStatus.PAID_HELD,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.RELEASED,
    ];
    const isPaidOrLater = paidStatuses.includes(order.status);
    const activeDeliveryCode = isPaidOrLater ? findDeliveryCodeFromHash(order.deliveryCodeHash) : null;

    res.json({
      order: {
        id: order.id,
        orderToken: order.orderToken,
        status: order.status,
        paymentMethod: order.paymentMethod,
        customerName: order.customerName,
        phone: order.phone,
        address: order.address,
        totalCents: order.totalCents,
        totalETB: (order.totalCents / 100).toFixed(2),
        deliveryCode: activeDeliveryCode,
        shipDeadline: order.shipDeadline,
        shippedAt: order.shippedAt,
        deliveredAt: order.deliveredAt,
        releaseAt: order.releaseAt,
        createdAt: order.createdAt,
        store: order.store,
        items: order.items.map((item) => ({
          id: item.id,
          productName: item.variant.product.name,
          variantLabel: item.variant.label,
          imageUrls: item.variant.product.imageUrls,
          quantity: item.quantity,
          priceCents: item.priceCents,
          subtotalETB: ((item.priceCents * item.quantity) / 100).toFixed(2),
        })),
        dispute: order.dispute,
      },
    });
  } catch (error) {
    console.error("Public order tracking error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/orders/public/:orderToken/confirm-received
 * Buyer taps "I received it" on their tracking page.
 * Confirms package receipt and begins the 24-hour protection window.
 */
ordersRouter.post("/public/:orderToken/confirm-received", async (req: Request, res: Response) => {
  try {
    const orderToken = getParam(req.params.orderToken);
    if (!orderToken) {
      res.status(400).json({ error: "Order token is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { orderToken },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.status !== OrderStatus.SHIPPED && order.status !== OrderStatus.PAID_HELD) {
      res.status(400).json({
        error: `Cannot confirm delivery for order with status "${order.status}". Order must be SHIPPED.`,
      });
      return;
    }

    const now = new Date();
    // 24 hours protection window before funds release
    const releaseAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.DELIVERED,
        deliveredAt: now,
        releaseAt,
      },
    });

    res.json({
      message: "Delivery confirmed. Your 24-hour buyer protection window is now active.",
      order: {
        id: updated.id,
        status: updated.status,
        deliveredAt: updated.deliveredAt,
        releaseAt: updated.releaseAt,
      },
    });
  } catch (error) {
    console.error("Buyer confirm received error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/orders/public/:orderToken/dispute
 * Buyer reports an issue with their order before funds are released.
 * Freezes escrow and moves order status to DISPUTED.
 */
ordersRouter.post("/public/:orderToken/dispute", async (req: Request, res: Response) => {
  try {
    const orderToken = getParam(req.params.orderToken);
    if (!orderToken) {
      res.status(400).json({ error: "Order token is required" });
      return;
    }

    const parseResult = disputeSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { reason, message, imageUrl } = parseResult.data;

    const order = await prisma.order.findUnique({
      where: { orderToken },
      include: { dispute: true },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.dispute) {
      res.status(400).json({ error: "A dispute has already been filed for this order" });
      return;
    }

    // Disputes can only be opened before funds release
    const disputableStatuses: OrderStatus[] = [
      OrderStatus.PAID_HELD,
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
    ];

    if (!disputableStatuses.includes(order.status)) {
      res.status(400).json({
        error: `Cannot open dispute on order with status "${order.status}".`,
      });
      return;
    }

    const dispute = await prisma.$transaction(async (tx) => {
      // 1. Freeze order
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DISPUTED },
      });

      // 2. Create Dispute record with evidence
      return tx.dispute.create({
        data: {
          orderId: order.id,
          openedBy: "BUYER",
          reason,
          evidence: {
            create: {
              author: "BUYER",
              message: message || reason,
              imageUrl: imageUrl || null,
            },
          },
        },
        include: { evidence: true },
      });
    });

    res.status(201).json({
      message: "Dispute opened successfully. Escrow release is frozen pending review.",
      dispute,
    });
  } catch (error) {
    console.error("Buyer dispute error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
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
        totalETB: (o.totalCents / 100).toFixed(2),
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
        totalETB: (order.totalCents / 100).toFixed(2),
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
 * Allowed for PAID_HELD (online escrow) or COD_PENDING (cash on delivery).
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

    const shippableStatuses: OrderStatus[] = [OrderStatus.PAID_HELD, OrderStatus.COD_PENDING, OrderStatus.PAID];
    if (!shippableStatuses.includes(order.status)) {
      res.status(400).json({
        error: `Cannot ship order with status "${order.status}". Order must be paid or confirmed COD.`,
      });
      return;
    }

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
  } catch (error) {
    console.error("Ship order error:", error);
    res.status(500).json({ error: "Internal server error" });
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

    if (order.status !== OrderStatus.SHIPPED && order.status !== OrderStatus.PAID_HELD) {
      res.status(400).json({
        error: `Cannot confirm delivery for order with status "${order.status}". Order must be SHIPPED.`,
      });
      return;
    }

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
  } catch (error) {
    console.error("Confirm delivery error:", error);
    res.status(500).json({ error: "Internal server error" });
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

    const cancellableStatuses: OrderStatus[] = [
      OrderStatus.PENDING_PAYMENT,
      OrderStatus.COD_PENDING,
      OrderStatus.PAID_HELD,
    ];

    if (!cancellableStatuses.includes(order.status)) {
      res.status(400).json({
        error: `Cannot cancel an order that is already ${order.status}`,
      });
      return;
    }

    const cancelledOrder = await prisma.$transaction(async (tx) => {
      // 1. Restore inventory for all items in the order
      for (const item of order.items) {
        await tx.variant.update({
          where: { id: item.variantId },
          data: { stock: { increment: item.quantity } },
        });
      }

      // 2. If escrow money was held, transition to REFUNDED and write to ledger
      if (order.status === OrderStatus.PAID_HELD) {
        await tx.commissionLedger.create({
          data: {
            orderId: order.id,
            storeId: order.storeId,
            type: LedgerEntryType.REFUNDED,
            amountCents: order.totalCents,
            note: "Order cancelled before dispatch - full refund issued to buyer",
          },
        });

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
    });

    res.json({
      message: "Order cancelled and inventory restored to stock",
      order: {
        id: cancelledOrder.id,
        status: cancelledOrder.status,
      },
    });
  } catch (error) {
    console.error("Cancel order error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/orders/:id/release-funds
 * Releases held escrow funds to the merchant after the 24-hour protection window expires.
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

    if (order.status !== OrderStatus.DELIVERED) {
      res.status(400).json({
        error: `Cannot release funds for order with status "${order.status}". Order must be DELIVERED.`,
      });
      return;
    }

    // Check if 24-hour protection window has ended
    if (order.releaseAt && new Date() < order.releaseAt) {
      const minutesRemaining = Math.ceil((order.releaseAt.getTime() - Date.now()) / (60 * 1000));
      res.status(400).json({
        error: `Protection window is still active. Release available in ${minutesRemaining} minutes.`,
      });
      return;
    }

    const releasedOrder = await prisma.$transaction(async (tx) => {
      // Calculate commission and merchant net
      const commissionCents = Math.round((order.totalCents * order.store.commissionBps) / 10000);
      const merchantNetCents = order.totalCents - commissionCents;

      // Append COMMISSION entry
      await tx.commissionLedger.create({
        data: {
          orderId: order.id,
          storeId: order.storeId,
          type: LedgerEntryType.COMMISSION,
          amountCents: commissionCents,
          note: `Qeto platform commission (${order.store.commissionBps / 100}%)`,
        },
      });

      // Append RELEASED entry
      await tx.commissionLedger.create({
        data: {
          orderId: order.id,
          storeId: order.storeId,
          type: LedgerEntryType.RELEASED,
          amountCents: merchantNetCents,
          note: `Merchant net funds released for payout`,
        },
      });

      // Update status to RELEASED
      return tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.RELEASED },
      });
    });

    res.json({
      message: "Funds successfully released to merchant payout balance",
      order: {
        id: releasedOrder.id,
        status: releasedOrder.status,
      },
    });
  } catch (error) {
    console.error("Release funds error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
