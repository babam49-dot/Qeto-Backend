import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";

export const productsRouter = Router();

// Validation schema for a single variant
const variantInputSchema = z.object({
  label: z.string().min(1, "Variant label is required (e.g., 'Default', 'M', 'Red')").max(50),
  priceCents: z.number().int().min(0, "Price in cents must be a non-negative integer"),
  stock: z.number().int().min(0, "Stock must be a non-negative integer"),
});

// Validation schema for creating a product with variants
const createProductSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  name: z.string().min(2, "Product name must be at least 2 characters").max(120),
  description: z.string().max(2000).optional(),
  imageUrls: z.array(z.string().url("Invalid image URL")).max(10).optional().default([]),
  isPublished: z.boolean().optional().default(true),
  variants: z
    .array(variantInputSchema)
    .min(1, "Product must have at least one variant (e.g. Standard/Default)"),
});

/**
 * POST /api/products
 * Protected endpoint: Creates a new product with one or more variants.
 * - Verifies that the authenticated seller owns the target store.
 * - Creates product and variants in a single database transaction.
 */
productsRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = createProductSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, name, description, imageUrls, isPublished, variants } = parseResult.data;

    // Check if the store exists and verify seller ownership
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

    // Create the product and its variants atomically
    const product = await prisma.product.create({
      data: {
        storeId,
        name,
        description: description || null,
        imageUrls,
        isPublished,
        variants: {
          create: variants.map((v) => ({
            label: v.label,
            priceCents: v.priceCents,
            stock: v.stock,
          })),
        },
      },
      include: {
        variants: true,
      },
    });

    res.status(201).json({
      message: "Product created successfully",
      product,
    });
  } catch (error) {
    console.error("Create product error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
