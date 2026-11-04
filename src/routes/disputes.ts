import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { OrderStatus, DisputeStatus } from "../generated/enums.js";
import { getParam } from "../lib/params.js";

export const disputesRouter = Router();

// -------------------------------------------------------------
// Validation Schemas
// -------------------------------------------------------------
const openDisputeSchema = z.object({
  reason: z.string().min(5, "Dispute reason must be at least 5 characters").max(1000),
  message: z.string().max(2000).optional(),
  imageUrl: z.string().url("Invalid image URL").optional(),
});

const addEvidenceSchema = z.object({
  author: z.enum(["BUYER", "MERCHANT"]).default("BUYER"),
  message: z.string().min(2, "Evidence message must be at least 2 characters").max(2000),
  imageUrl: z.string().url("Invalid image URL").optional(),
});

// =============================================================
// PUBLIC / BUYER DISPUTE ENDPOINTS
// =============================================================

/**
 * GET /api/disputes/:orderToken
 * Retrieve dispute status, reason, decisions, and all submitted evidence.
 */
disputesRouter.get("/:orderToken", async (req: Request, res: Response) => {
  try {
    const orderToken = getParam(req.params.orderToken);
    if (!orderToken) {
      res.status(400).json({ error: "Order token is required" });
      return;
    }

    const order = await prisma.order.findUnique({
      where: { orderToken },
      select: {
        id: true,
        orderToken: true,
        status: true,
        totalCents: true,
        customerName: true,
        dispute: {
          include: {
            evidence: {
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (!order.dispute) {
      res.status(404).json({ error: "No dispute found for this order" });
      return;
    }

    res.json({
      orderId: order.id,
      orderStatus: order.status,
      dispute: order.dispute,
    });
  } catch (error) {
    console.error("Get dispute error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/disputes/:orderToken
 * Buyer opens a dispute before funds release.
 * Freezes escrow and transitions order status to DISPUTED.
 */
disputesRouter.post("/:orderToken", async (req: Request, res: Response) => {
  try {
    const orderToken = getParam(req.params.orderToken);
    if (!orderToken) {
      res.status(400).json({ error: "Order token is required" });
      return;
    }

    const parseResult = openDisputeSchema.safeParse(req.body);
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
        error: `Cannot open a dispute on an order with status ${order.status}. Disputes can only be opened while funds are held in escrow.`,
      });
      return;
    }

    const dispute = await prisma.$transaction(
      async (tx) => {
        // 1. Freeze order status to DISPUTED
        await tx.order.update({
          where: { id: order.id },
          data: { status: OrderStatus.DISPUTED },
        });

        // 2. Create Dispute record with initial evidence
        return tx.dispute.create({
          data: {
            orderId: order.id,
            openedBy: "BUYER",
            reason,
            status: DisputeStatus.OPEN,
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
      message: "Dispute opened successfully. Escrow release is frozen pending admin review.",
      dispute,
    });
  } catch (error) {
    console.error("Open dispute error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/disputes/:orderToken/evidence
 * Add evidence (photos, messages) to an active dispute.
 */
disputesRouter.post("/:orderToken/evidence", async (req: Request, res: Response) => {
  try {
    const orderToken = getParam(req.params.orderToken);
    if (!orderToken) {
      res.status(400).json({ error: "Order token is required" });
      return;
    }

    const parseResult = addEvidenceSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { author, message, imageUrl } = parseResult.data;

    const order = await prisma.order.findUnique({
      where: { orderToken },
      include: { dispute: true },
    });

    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }

    if (!order.dispute) {
      res.status(400).json({ error: "No open dispute exists for this order" });
      return;
    }

    if (order.dispute.status === DisputeStatus.RESOLVED) {
      res.status(400).json({ error: "This dispute has already been resolved and closed" });
      return;
    }

    const evidence = await prisma.disputeEvidence.create({
      data: {
        disputeId: order.dispute.id,
        author,
        message,
        imageUrl: imageUrl || null,
      },
    });

    res.status(201).json({
      message: "Evidence added successfully",
      evidence,
    });
  } catch (error) {
    console.error("Add dispute evidence error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
