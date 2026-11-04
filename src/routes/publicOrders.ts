import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { OrderStatus } from "../generated/enums.js";
import { getParam } from "../lib/params.js";
import {
  hashDeliveryCode,
  generateDeliveryCode,
  findDeliveryCodeFromHash,
  generateOrderToken,
} from "../lib/deliveryCode.js";
import { centsToETB } from "../lib/money.js";
import { ledger } from "../lib/ledger.js";
import { assertCanTransition, isDisputableStatus } from "../lib/stateMachine.js";
import { sendMerchantOrderAlert } from "../lib/telegram.js";

export const publicOrdersRouter = Router();

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

const disputeSchema = z.object({
  reason: z.string().min(5, "Dispute reason must be at least 5 characters").max(1000),
  message: z.string().max(2000).optional(),
  imageUrl: z.string().url("Invalid image URL").optional(),
});

// =============================================================
// PUBLIC / BUYER ENDPOINTS
// =============================================================

/**
 * POST /api/public/orders
 * Public checkout endpoint for buyers.
 * - Validates variant stock availability and calculates total pricing server-side.
 * - Deducts/reserves variant stock atomically inside a database transaction.
 * - Generates unique unguessable order token for buyer tracking.
 * - If ONLINE: sets status PENDING_PAYMENT, 15 min stock reservation, and generates secret 4-digit delivery code.
 * - If COD: sets status COD_PENDING, records COD commission owed in ledger.
 */
publicOrdersRouter.post("/", async (req: Request, res: Response) => {
  try {
    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, customerName, phone, address, paymentMethod, items } = parseResult.data;

    // Verify store exists and is eligible to accept orders
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { telegramConnection: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.status === "SUSPENDED") {
      res.status(403).json({ error: "This store is currently suspended and cannot accept orders" });
      return;
    }

    // Fetch and validate all ordered variants
    const variantIds = items.map((i) => i.variantId);
    const variants = await prisma.variant.findMany({
      where: {
        id: { in: variantIds },
        product: { storeId },
      },
      include: {
        product: true,
      },
    });

    if (variants.length !== items.length) {
      res.status(400).json({ error: "One or more product variants were not found in this store" });
      return;
    }

    // Stock check and line items assembly
    const lineItems: Array<{
      variantId: string;
      quantity: number;
      priceCents: number;
    }> = [];

    let totalCents = 0;

    for (const item of items) {
      const variant = variants.find((v) => v.id === item.variantId);
      if (!variant) {
        res.status(400).json({ error: `Variant ${item.variantId} not found` });
        return;
      }

      if (variant.stock < item.quantity) {
        res.status(400).json({
          error: `Insufficient stock for '${variant.product.name} - ${variant.label}'. Available: ${variant.stock}, Requested: ${item.quantity}`,
        });
        return;
      }

      lineItems.push({
        variantId: variant.id,
        quantity: item.quantity,
        priceCents: variant.priceCents,
      });

      totalCents += variant.priceCents * item.quantity;
    }

    // Generate security credentials
    const rawDeliveryCode = generateDeliveryCode();
    const deliveryCodeHash = hashDeliveryCode(rawDeliveryCode);
    const orderToken = generateOrderToken();

    const now = new Date();
    // 15-minute stock reservation window for online orders
    const expiresAt = paymentMethod === "ONLINE" ? new Date(now.getTime() + 15 * 60 * 1000) : null;
    const initialStatus = paymentMethod === "ONLINE" ? OrderStatus.PENDING_PAYMENT : OrderStatus.COD_PENDING;

    // Atomically create order, create order items, and deduct/reserve variant inventory
    const order = await prisma.$transaction(
      async (tx) => {
        // 1. Deduct stock for each variant
        for (const item of items) {
          await tx.variant.update({
            where: { id: item.variantId },
            data: { stock: { decrement: item.quantity } },
          });
        }

        // 2. Create the order record
        const createdOrder = await tx.order.create({
          data: {
            storeId,
            orderToken,
            paymentMethod,
            customerName,
            phone,
            address,
            totalCents,
            status: initialStatus,
            deliveryCodeHash,
            expiresAt,
            items: {
              create: lineItems.map((li) => ({
                variantId: li.variantId,
                quantity: li.quantity,
                priceCents: li.priceCents,
              })),
            },
          },
          include: {
            items: {
              include: {
                variant: {
                  include: {
                    product: { select: { name: true, imageUrls: true } },
                  },
                },
              },
            },
            store: {
              select: { id: true, name: true, slug: true, phone: true },
            },
          },
        });

        // 3. For COD orders, record COD commission owed
        if (paymentMethod === "COD") {
          const codCommissionCents = Math.round((totalCents * store.commissionBps) / 10_000);
          await ledger.recordCodCommissionOwed(
            {
              orderId: createdOrder.id,
              storeId: store.id,
              amountCents: codCommissionCents,
              note: `COD order created: Platform commission owed upon delivery (${store.commissionBps / 100}%)`,
            },
            tx
          );
        }

        return createdOrder;
      },
      { timeout: 20000, maxWait: 10000 }
    );

    // If COD, notify merchant immediately via Telegram
    if (paymentMethod === "COD" && store.telegramConnection?.notifyOnOrder) {
      const targetChatId = store.telegramConnection.alertChatId || store.telegramConnection.channelId;
      if (targetChatId) {
        sendMerchantOrderAlert({
          chatId: targetChatId,
          orderToken: order.orderToken,
          customerName: order.customerName,
          phone: order.phone,
          address: order.address,
          totalCents: order.totalCents,
          items: order.items.map((i) => ({
            label: i.variant?.label,
            quantity: i.quantity,
          })),
          paymentMethod: order.paymentMethod,
        }).catch((err) => console.error("[Telegram COD Alert Error]", err));
      }
    }

    res.status(201).json({
      message:
        paymentMethod === "ONLINE"
          ? "Order created. Stock is reserved for 15 minutes. Complete payment to confirm."
          : "COD order placed successfully.",
      orderToken: order.orderToken,
      order: {
        id: order.id,
        orderToken: order.orderToken,
        status: order.status,
        paymentMethod: order.paymentMethod,
        customerName: order.customerName,
        phone: order.phone,
        address: order.address,
        totalCents: order.totalCents,
        totalETB: centsToETB(order.totalCents),
        expiresAt: order.expiresAt,
        store: order.store,
        items: order.items.map((i) => ({
          id: i.id,
          productName: i.variant.product.name,
          variantLabel: i.variant.label,
          imageUrls: i.variant.product.imageUrls,
          quantity: i.quantity,
          priceCents: i.priceCents,
          subtotalETB: centsToETB(i.priceCents * i.quantity),
        })),
      },
    });
  } catch (error) {
    console.error("Public create order error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/public/orders/:orderToken
 * Public order tracking page for the buyer.
 * - Returns order timeline, items, and shipping status.
 * - Reveals the 4-digit delivery code only once payment is verified into escrow.
 */
publicOrdersRouter.get("/:orderToken", async (req: Request, res: Response) => {
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
        totalETB: centsToETB(order.totalCents),
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
          subtotalETB: centsToETB(item.priceCents * item.quantity),
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
 * POST /api/public/orders/:orderToken/confirm-received
 * Buyer taps "I received it" on their tracking page.
 * Confirms package receipt and begins the 24-hour protection window.
 */
publicOrdersRouter.post("/:orderToken/confirm-received", async (req: Request, res: Response) => {
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

    // Validate state machine transition
    assertCanTransition(order.status, OrderStatus.DELIVERED, order.id);

    const now = new Date();
    // 24-hour protection window
    const releaseAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: OrderStatus.DELIVERED,
        deliveredAt: now,
        releaseAt,
      },
    });

    res.json({
      message: "Package receipt confirmed! 24-hour buyer protection window has started.",
      order: {
        id: updatedOrder.id,
        status: updatedOrder.status,
        deliveredAt: updatedOrder.deliveredAt,
        releaseAt: updatedOrder.releaseAt,
      },
    });
  } catch (error: any) {
    console.error("Buyer confirm delivery error:", error);
    res.status(400).json({ error: error.message || "Unable to confirm delivery" });
  }
});

/**
 * POST /api/public/orders/:orderToken/dispute
 * Buyer reports an issue with their order before funds are released.
 * Freezes escrow countdown and moves order status to DISPUTED.
 */
publicOrdersRouter.post("/:orderToken/dispute", async (req: Request, res: Response) => {
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

    if (!isDisputableStatus(order.status)) {
      res.status(400).json({
        error: `Cannot open a dispute on an order with status ${order.status}. Disputes can only be opened while funds are held in escrow.`,
      });
      return;
    }

    // Validate state machine transition
    assertCanTransition(order.status, OrderStatus.DISPUTED, order.id);

    const dispute = await prisma.$transaction(
      async (tx) => {
        // 1. Freeze order to DISPUTED
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
          include: {
            evidence: true,
          },
        });
      },
      { timeout: 20000, maxWait: 10000 }
    );

    res.status(201).json({
      message: "Dispute opened successfully. Escrow release is frozen pending review.",
      dispute,
    });
  } catch (error: any) {
    console.error("Buyer dispute error:", error);
    res.status(400).json({ error: error.message || "Failed to open dispute" });
  }
});

