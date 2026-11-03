import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import {
  initializeChapaTransaction,
  verifyChapaTransaction,
  verifyChapaWebhookSignature,
} from "../lib/chapa.js";
import { OrderStatus, PaymentStatus, LedgerEntryType } from "../generated/enums.js";
import { getParam } from "../lib/params.js";

export const paymentsRouter = Router();

const initializePaymentSchema = z.object({
  orderToken: z.string().min(1, "Order token is required"),
  email: z.string().email("Invalid email").optional(),
  returnUrl: z.string().url("Invalid return URL").optional(),
});

/**
 * POST /api/payments/initialize
 * Public endpoint for buyers to initiate an online escrow payment via Chapa.
 * - Validates order status is PENDING_PAYMENT
 * - Checks stock reservation deadline
 * - Creates a Payment record with unique tx_ref
 * - Calls Chapa to obtain the hosted checkout URL
 */
paymentsRouter.post("/initialize", async (req: Request, res: Response) => {
  try {
    const parseResult = initializePaymentSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { orderToken, email, returnUrl } = parseResult.data;

    const order = await prisma.order.findUnique({
      where: { orderToken },
      include: {
        store: { select: { id: true, name: true, phone: true } },
        items: true,
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      res.status(400).json({
        error: `Order cannot be paid. Current status is ${order.status}`,
      });
      return;
    }

    // Check if 15-minute stock reservation expired
    if (order.expiresAt && new Date() > order.expiresAt) {
      res.status(400).json({
        error: "Order reservation window (15 minutes) has expired. Please place a new order.",
      });
      return;
    }

    // Generate unique transaction reference (tx_ref)
    const txRef = `qeto-${order.id.slice(-6)}-${Date.now()}`;

    // Create or reuse pending payment record
    await prisma.payment.create({
      data: {
        orderId: order.id,
        txRef,
        amountCents: order.totalCents,
        status: PaymentStatus.PENDING,
        provider: "chapa",
      },
    });

    // Amount in ETB (1 ETB = 100 santim)
    const amountETB = (order.totalCents / 100).toFixed(2);
    const buyerEmail = email || `${order.phone.replace(/[^0-9]/g, "")}@qeto.shop`;
    const nameParts = order.customerName.trim().split(" ");
    const firstName = nameParts[0] || "Customer";
    const lastName = nameParts.slice(1).join(" ") || "Buyer";

    const chapaResult = await initializeChapaTransaction({
      amount: amountETB,
      currency: "ETB",
      email: buyerEmail,
      firstName,
      lastName,
      phoneNumber: order.phone,
      txRef,
      callbackUrl: `${env.APP_URL}/api/payments/webhook`,
      returnUrl:
        returnUrl ||
        `${env.APP_URL}/api/payments/verify/${encodeURIComponent(txRef)}?orderToken=${order.orderToken}`,
      customization: {
        title: `${order.store.name} - Order #${order.id.slice(-6)}`,
        description: `Qeto Escrow Payment (100% money-back protected)`,
      },
    });

    res.status(200).json({
      message: "Payment initialized successfully",
      txRef,
      checkoutUrl: chapaResult.checkoutUrl,
      amountETB,
      orderToken: order.orderToken,
      isSimulated: chapaResult.isSimulated || false,
    });
  } catch (error: any) {
    console.error("Initialize payment error:", error);
    res.status(500).json({ error: error.message || "Failed to initialize payment" });
  }
});

/**
 * GET /api/payments/verify/:txRef
 * Buyer return or polling verification endpoint.
 * - Queries Chapa verify API
 * - On success, atomically transitions Order to PAID_HELD (escrow!)
 * - Records HELD entry in CommissionLedger
 * - Sets 3-day shipping deadline
 */
paymentsRouter.get("/verify/:txRef", async (req: Request, res: Response) => {
  try {
    const txRef = getParam(req.params.txRef);

    if (!txRef) {
      res.status(400).json({ error: "Transaction reference (txRef) is required" });
      return;
    }

    const payment = await prisma.payment.findUnique({
      where: { txRef },
      include: {
        order: {
          include: {
            store: { select: { id: true, name: true, phone: true } },
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: "Payment transaction not found" });
      return;
    }

    const order = payment.order;

    // If order is already held or completed, return current state
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      res.json({
        message: "Payment has already been processed",
        status: payment.status,
        order: {
          id: order.id,
          orderToken: order.orderToken,
          status: order.status,
          totalCents: order.totalCents,
          totalETB: (order.totalCents / 100).toFixed(2),
          shipDeadline: order.shipDeadline,
        },
      });
      return;
    }

    // Verify with Chapa gateway
    const verification = await verifyChapaTransaction(txRef);

    if (verification.status === "success") {
      // 3 days shipping deadline per design specification
      const shipDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

      const result = await prisma.$transaction(async (tx) => {
        // 1. Update Payment status
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.SUCCESS },
        });

        // 2. Transition Order to PAID_HELD (funds held in escrow)
        const updatedOrder = await tx.order.update({
          where: { id: order.id },
          data: {
            status: OrderStatus.PAID_HELD,
            shipDeadline,
            expiresAt: null, // clear temporary reservation timer
          },
        });

        // 3. Append HELD entry to CommissionLedger
        await tx.commissionLedger.create({
          data: {
            orderId: order.id,
            storeId: order.storeId,
            type: LedgerEntryType.HELD,
            amountCents: order.totalCents,
            note: `Payment verified via Chapa (tx_ref: ${txRef}). Funds held in escrow until delivery confirmation.`,
          },
        });

        return updatedOrder;
      });

      res.json({
        message: "Payment successfully verified! Funds are held safely in escrow.",
        payment: {
          txRef,
          status: PaymentStatus.SUCCESS,
        },
        order: {
          id: result.id,
          orderToken: result.orderToken,
          status: result.status,
          totalCents: result.totalCents,
          totalETB: (result.totalCents / 100).toFixed(2),
          shipDeadline: result.shipDeadline,
        },
      });
    } else {
      res.status(400).json({
        error: "Payment was not completed or failed verification",
        status: verification.status,
        details: verification.message,
      });
    }
  } catch (error: any) {
    console.error("Verify payment error:", error);
    res.status(500).json({ error: error.message || "Internal server error" });
  }
});

/**
 * POST /api/payments/webhook
 * Chapa Webhook Listener.
 * - Verifies webhook signature
 * - Enforces idempotency via WebhookEvent table
 * - Transitions order to PAID_HELD and records ledger entry
 */
paymentsRouter.post("/webhook", async (req: Request, res: Response) => {
  try {
    const rawBody = req.body;
    const signature = req.headers["x-chapa-signature"] as string | undefined;

    // Optional signature verification if configured
    if (env.CHAPA_WEBHOOK_SECRET && signature) {
      const isValid = verifyChapaWebhookSignature(JSON.stringify(rawBody), signature);
      if (!isValid) {
        console.warn("[Webhook] Invalid Chapa signature received");
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }
    }

    const { tx_ref, status } = rawBody;

    if (!tx_ref) {
      res.status(400).json({ error: "Missing tx_ref in webhook body" });
      return;
    }

    const eventKey = `chapa-wh-${tx_ref}`;

    // 1. Check idempotency: if event already processed, acknowledge with 200 immediately
    const existingEvent = await prisma.webhookEvent.findUnique({
      where: { eventKey },
    });

    if (existingEvent && existingEvent.processedAt) {
      res.status(200).json({ message: "Webhook already processed" });
      return;
    }

    // 2. Store event record
    const event =
      existingEvent ||
      (await prisma.webhookEvent.create({
        data: {
          provider: "chapa",
          eventKey,
          payload: rawBody,
        },
      }));

    // 3. Find payment
    const payment = await prisma.payment.findUnique({
      where: { txRef: tx_ref },
      include: { order: true },
    });

    if (!payment) {
      console.warn(`[Webhook] Payment record for tx_ref ${tx_ref} not found`);
      res.status(200).json({ message: "Transaction not found locally, recorded event" });
      return;
    }

    const order = payment.order;

    // If order already paid or past pending, mark event processed and return 200
    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      await prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
      res.status(200).json({ message: "Order is already updated" });
      return;
    }

    // Verify status
    if (status === "success" || !status) {
      const verification = await verifyChapaTransaction(tx_ref);

      if (verification.status === "success") {
        const shipDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

        await prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: PaymentStatus.SUCCESS },
          });

          await tx.order.update({
            where: { id: order.id },
            data: {
              status: OrderStatus.PAID_HELD,
              shipDeadline,
              expiresAt: null,
            },
          });

          await tx.commissionLedger.create({
            data: {
              orderId: order.id,
              storeId: order.storeId,
              type: LedgerEntryType.HELD,
              amountCents: order.totalCents,
              note: `Webhook verified via Chapa. Funds held in escrow until delivery.`,
            },
          });

          await tx.webhookEvent.update({
            where: { id: event.id },
            data: { processedAt: new Date() },
          });
        });
      }
    }

    res.status(200).json({ status: "success", received: true });
  } catch (error: any) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ error: "Webhook handling failed" });
  }
});

/**
 * POST /api/payments/simulate-success
 * Sandbox simulator endpoint for testing and demoing the complete escrow flow without live payment credentials.
 */
paymentsRouter.post("/simulate-success", async (req: Request, res: Response) => {
  try {
    const { txRef } = req.body;
    if (!txRef) {
      res.status(400).json({ error: "txRef is required" });
      return;
    }

    const payment = await prisma.payment.findUnique({
      where: { txRef },
      include: {
        order: {
          include: {
            store: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!payment) {
      res.status(404).json({ error: "Payment not found" });
      return;
    }

    const order = payment.order;

    if (order.status !== OrderStatus.PENDING_PAYMENT) {
      res.json({
        message: "Order already moved past PENDING_PAYMENT",
        order: {
          id: order.id,
          orderToken: order.orderToken,
          status: order.status,
        },
      });
      return;
    }

    const shipDeadline = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);

    const updated = await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.SUCCESS },
      });

      const ord = await tx.order.update({
        where: { id: order.id },
        data: {
          status: OrderStatus.PAID_HELD,
          shipDeadline,
          expiresAt: null,
        },
      });

      await tx.commissionLedger.create({
        data: {
          orderId: order.id,
          storeId: order.storeId,
          type: LedgerEntryType.HELD,
          amountCents: order.totalCents,
          note: `Simulated sandbox payment verified. Gross funds held safely in escrow.`,
        },
      });

      return ord;
    });

    res.json({
      message: "Payment simulated successfully! Order is now PAID_HELD in escrow.",
      orderToken: updated.orderToken,
      status: updated.status,
      shipDeadline: updated.shipDeadline,
    });
  } catch (error: any) {
    console.error("Simulation error:", error);
    res.status(500).json({ error: error.message || "Failed to simulate payment" });
  }
});
