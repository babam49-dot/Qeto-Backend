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

export const paymentsRouter = Router();

// Helper to safely extract single string route params in Express 5
function getParam(param: string | string[] | undefined): string {
  if (Array.isArray(param)) return param[0] ?? "";
  return param ?? "";
}

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
    const orderTokenQuery = req.query.orderToken as string | undefined;

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
      // If browser requested as HTML redirect, render nice receipt
      if (req.accepts("html") && !req.accepts("json")) {
        res.redirect(`/api/orders/public/${order.orderToken}`);
        return;
      }

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

      // If buyer visited via browser redirect, return a visually stunning confirmation page
      if (req.accepts("html") && !req.xhr && !req.headers["sec-fetch-dest"]?.includes("empty")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(renderPaymentSuccessHtml({
          orderToken: result.orderToken,
          amountETB: (result.totalCents / 100).toFixed(2),
          customerName: result.customerName,
          txRef,
          storeName: order.store.name,
        }));
        return;
      }

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

/**
 * GET /api/payments/mock-checkout
 * Visual interactive simulator page for Chapa sandbox checkout.
 * Enables live testing in browser and provides full visual feedback.
 */
paymentsRouter.get("/mock-checkout", (req: Request, res: Response) => {
  const txRef = (req.query.tx_ref as string) || "";
  const amount = (req.query.amount as string) || "0.00";
  const title = (req.query.title as string) || "Qeto Order Checkout";

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chapa Payment Sandbox — ${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.85);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #00d084;
      --primary-hover: #00b572;
      --chapa-green: #07c268;
      --telebirr: #0077b6;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: var(--bg);
      background-image: 
        radial-gradient(circle at 20% 15%, rgba(0, 208, 132, 0.12) 0%, transparent 40%),
        radial-gradient(circle at 80% 85%, rgba(0, 119, 182, 0.12) 0%, transparent 40%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .modal {
      width: 100%;
      max-width: 460px;
      background: var(--card-bg);
      backdrop-filter: blur(20px);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 2.2rem;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
      animation: slideUp 0.35s ease-out;
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(7, 194, 104, 0.15);
      color: #34d399;
      border: 1px solid rgba(7, 194, 104, 0.3);
      padding: 4px 12px;
      border-radius: 9999px;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 1.2rem;
    }
    .badge::before {
      content: "";
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #34d399;
      box-shadow: 0 0 8px #34d399;
    }
    .header-logo {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1rem;
    }
    .chapa-brand {
      font-size: 1.35rem;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: #fff;
    }
    .chapa-brand span { color: var(--chapa-green); }
    .amount-box {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 16px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
      text-align: center;
    }
    .amount-label {
      font-size: 0.82rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
    }
    .amount-value {
      font-size: 2.2rem;
      font-weight: 800;
      color: #ffffff;
      margin: 4px 0 2px;
    }
    .amount-currency {
      color: var(--chapa-green);
      font-size: 1.1rem;
      margin-right: 4px;
    }
    .escrow-pill {
      background: rgba(14, 165, 233, 0.12);
      border: 1px solid rgba(14, 165, 233, 0.25);
      border-radius: 12px;
      padding: 0.85rem 1rem;
      font-size: 0.82rem;
      color: #7dd3fc;
      line-height: 1.45;
      margin-bottom: 1.5rem;
      display: flex;
      gap: 10px;
      align-items: flex-start;
    }
    .escrow-pill svg {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      margin-top: 2px;
    }
    .methods-title {
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
    }
    .method-options {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.65rem;
      margin-bottom: 1.5rem;
    }
    .method-btn {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 0.75rem 0.6rem;
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .method-btn:hover, .method-btn.active {
      border-color: var(--chapa-green);
      background: rgba(7, 194, 104, 0.1);
    }
    .method-icon {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7rem;
      font-weight: 800;
      color: #fff;
    }
    .btn-pay {
      width: 100%;
      background: linear-gradient(135deg, #07c268, #00d084);
      color: #032012;
      border: none;
      padding: 0.95rem;
      border-radius: 14px;
      font-size: 1rem;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 8px 24px rgba(7, 194, 104, 0.35);
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn-pay:hover {
      transform: translateY(-2px);
      box-shadow: 0 12px 28px rgba(7, 194, 104, 0.5);
    }
    .btn-pay:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .footer-note {
      text-align: center;
      margin-top: 1.2rem;
      font-size: 0.78rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="modal">
    <div class="header-logo">
      <div class="chapa-brand">CHAPA<span>.</span></div>
      <div class="badge">SANDBOX SIMULATOR</div>
    </div>

    <div class="amount-box">
      <div class="amount-label">Order Total</div>
      <div class="amount-value"><span class="amount-currency">ETB</span>${escapeHtml(amount)}</div>
      <div style="font-size: 0.8rem; color: #94a3b8; margin-top: 4px;">Ref: ${escapeHtml(txRef)}</div>
    </div>

    <div class="escrow-pill">
      <svg fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm0-7a1 1 0 10-2 0v3a1 1 0 102 0V7z" clip-rule="evenodd"></path>
      </svg>
      <div>
        <strong>Qeto Escrow Protection Active:</strong> Your funds will NOT go directly to the seller now. They are securely held until you receive and inspect your package.
      </div>
    </div>

    <div class="methods-title">Select Payment Method</div>
    <div class="method-options">
      <button type="button" class="method-btn active">
        <span class="method-icon" style="background:#0077b6;">TB</span>
        Telebirr
      </button>
      <button type="button" class="method-btn">
        <span class="method-icon" style="background:#9333ea;">CBE</span>
        CBE Birr
      </button>
      <button type="button" class="method-btn">
        <span class="method-icon" style="background:#ea580c;">MP</span>
        M-Pesa
      </button>
      <button type="button" class="method-btn">
        <span class="method-icon" style="background:#1e293b;">💳</span>
        Debit Card
      </button>
    </div>

    <button id="payBtn" class="btn-pay" onclick="handlePay()">
      <span>Authorize & Pay ${escapeHtml(amount)} ETB</span>
    </button>

    <div class="footer-note">
      🔒 256-bit SSL Encrypted • Powered by Chapa Gateway
    </div>
  </div>

  <script>
    async function handlePay() {
      const btn = document.getElementById('payBtn');
      btn.disabled = true;
      btn.innerHTML = '<span>Processing Escrow Lock...</span>';

      try {
        const res = await fetch('/api/payments/simulate-success', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ txRef: '${escapeJs(txRef)}' })
        });

        const data = await res.json();
        if (data.orderToken) {
          window.location.href = '/api/payments/verify/${encodeURIComponent(txRef)}?orderToken=' + data.orderToken;
        } else {
          window.location.href = '/api/payments/verify/${encodeURIComponent(txRef)}';
        }
      } catch (err) {
        alert('Payment processing failed: ' + err.message);
        btn.disabled = false;
        btn.innerHTML = '<span>Try Again</span>';
      }
    }
  </script>
</body>
</html>
  `);
});

// Helper for rendering receipt HTML
function renderPaymentSuccessHtml(data: {
  orderToken: string;
  amountETB: string;
  customerName: string;
  txRef: string;
  storeName: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Confirmed — Qeto Escrow</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #090d16;
      --card-bg: rgba(18, 24, 38, 0.9);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #00d084;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', sans-serif;
      background: var(--bg);
      background-image: radial-gradient(circle at 50% 20%, rgba(0, 208, 132, 0.15) 0%, transparent 60%);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      width: 100%;
      max-width: 480px;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 24px;
      padding: 2.5rem;
      text-align: center;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.6);
    }
    .success-icon {
      width: 72px;
      height: 72px;
      background: rgba(0, 208, 132, 0.15);
      border: 2px solid rgba(0, 208, 132, 0.4);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 1.5rem;
      color: #00d084;
    }
    .success-icon svg { width: 36px; height: 36px; }
    h1 { font-size: 1.6rem; font-weight: 800; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { color: var(--text-muted); font-size: 0.95rem; margin-bottom: 1.75rem; line-height: 1.5; }
    .escrow-box {
      background: rgba(0, 208, 132, 0.08);
      border: 1px solid rgba(0, 208, 132, 0.25);
      border-radius: 16px;
      padding: 1.25rem;
      margin-bottom: 1.75rem;
      text-align: left;
    }
    .row { display: flex; justify-content: space-between; margin-bottom: 0.6rem; font-size: 0.88rem; }
    .row:last-child { margin-bottom: 0; }
    .label { color: var(--text-muted); }
    .val { font-weight: 700; color: #fff; }
    .btn-track {
      display: block;
      width: 100%;
      background: var(--primary);
      color: #042416;
      text-decoration: none;
      padding: 0.95rem;
      border-radius: 14px;
      font-weight: 800;
      font-size: 1rem;
      box-shadow: 0 8px 24px rgba(0, 208, 132, 0.3);
      transition: all 0.2s;
    }
    .btn-track:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(0, 208, 132, 0.45); }
  </style>
</head>
<body>
  <div class="card">
    <div class="success-icon">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"></path>
      </svg>
    </div>
    <h1>Payment Held in Escrow!</h1>
    <p class="subtitle">Thank you, <strong>${escapeHtml(data.customerName)}</strong>. Your payment is verified and secured by Qeto Escrow.</p>

    <div class="escrow-box">
      <div class="row">
        <span class="label">Store:</span>
        <span class="val">${escapeHtml(data.storeName)}</span>
      </div>
      <div class="row">
        <span class="label">Amount Paid:</span>
        <span class="val" style="color:#00d084;">${escapeHtml(data.amountETB)} ETB</span>
      </div>
      <div class="row">
        <span class="label">Status:</span>
        <span class="val" style="color:#38bdf8;">PAID_HELD (Escrow)</span>
      </div>
      <div class="row">
        <span class="label">Tx Ref:</span>
        <span class="val" style="font-size:0.78rem;">${escapeHtml(data.txRef)}</span>
      </div>
    </div>

    <a href="/api/orders/public/${encodeURIComponent(data.orderToken)}" class="btn-track">
      View Order & Delivery Code →
    </a>
  </div>
</body>
</html>
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeJs(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/"/g, '\\"');
}
