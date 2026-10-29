import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { verifyToken } from "../lib/auth.js";

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

/**
 * GET /api/products/store/:storeId
 * Lists products for a store along with their variants.
 * - Store owner sees all products (including unpublished drafts).
 * - Public visitors only see published products.
 */
productsRouter.get("/store/:storeId", async (req: Request, res: Response) => {
  try {
    const rawStoreId = req.params.storeId;
    const storeId = typeof rawStoreId === "string" ? rawStoreId : undefined;

    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    // Check if requester is the store owner
    let isOwner = false;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const token = authHeader.slice(7).trim();
        const payload = verifyToken(token);
        if (payload.sub === store.ownerId) {
          isOwner = true;
        }
      } catch {
        // Invalid or expired token — treated as public visitor
      }
    }

    const products = await prisma.product.findMany({
      where: {
        storeId,
        ...(isOwner ? {} : { isPublished: true }),
      },
      orderBy: { createdAt: "desc" },
      include: {
        variants: true,
      },
    });

    res.json({ products });
  } catch (error) {
    console.error("List store products error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/products/:id
 * Fetches a single product by ID, along with its variants and store info.
 */
productsRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id;
    const productId = typeof rawId === "string" ? rawId : undefined;

    if (!productId) {
      res.status(400).json({ error: "Product ID is required" });
      return;
    }

    const product = await prisma.product.findUnique({
      where: { id: productId },
      include: {
        variants: true,
        store: {
          select: {
            id: true,
            name: true,
            slug: true,
            phone: true,
            status: true,
          },
        },
      },
    });

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ product });
  } catch (error) {
    console.error("Get product error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Validation schema for updating a product
const updateProductSchema = z.object({
  name: z.string().min(2, "Product name must be at least 2 characters").max(120).optional(),
  description: z.string().max(2000).optional(),
  imageUrls: z.array(z.string().url("Invalid image URL")).max(10).optional(),
  isPublished: z.boolean().optional(),
  variants: z
    .array(
      z.object({
        id: z.string().optional(),
        label: z.string().min(1).max(50),
        priceCents: z.number().int().min(0),
        stock: z.number().int().min(0),
      })
    )
    .min(1)
    .optional(),
});

/**
 * PATCH /api/products/:id
 * Protected endpoint: updates product details, publication status, or variants.
 * Verifies that the authenticated seller owns the product's store.
 */
productsRouter.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rawId = req.params.id;
    const productId = typeof rawId === "string" ? rawId : undefined;

    if (!productId) {
      res.status(400).json({ error: "Product ID is required" });
      return;
    }

    const parseResult = updateProductSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    // Find product and include store to check ownership
    const existing = await prisma.product.findUnique({
      where: { id: productId },
      include: { store: { select: { ownerId: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (existing.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this product's store" });
      return;
    }

    const { name, description, imageUrls, isPublished, variants } = parseResult.data;

    // Perform updates
    await prisma.$transaction(async (tx) => {
      // 1. Update product base fields
      await tx.product.update({
        where: { id: productId },
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description: description || null }),
          ...(imageUrls !== undefined && { imageUrls }),
          ...(isPublished !== undefined && { isPublished }),
        },
      });

      // 2. Update or create variants if provided
      if (variants) {
        for (const v of variants) {
          if (v.id) {
            await tx.variant.update({
              where: { id: v.id },
              data: {
                label: v.label,
                priceCents: v.priceCents,
                stock: v.stock,
              },
            });
          } else {
            await tx.variant.create({
              data: {
                productId,
                label: v.label,
                priceCents: v.priceCents,
                stock: v.stock,
              },
            });
          }
        }
      }
    });

    const updatedProduct = await prisma.product.findUnique({
      where: { id: productId },
      include: { variants: true },
    });

    res.json({
      message: "Product updated successfully",
      product: updatedProduct,
    });
  } catch (error) {
    console.error("Update product error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /api/products/:id
 * Protected endpoint: Deletes a product and its variants.
 * - Verifies that the authenticated seller owns the product's store.
 * - If product has existing orders, prevents hard deletion and unpublishes instead.
 * - Otherwise deletes variants and the product cleanly.
 */
productsRouter.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const rawId = req.params.id;
    const productId = typeof rawId === "string" ? rawId : undefined;

    if (!productId) {
      res.status(400).json({ error: "Product ID is required" });
      return;
    }

    const existing = await prisma.product.findUnique({
      where: { id: productId },
      include: { store: { select: { ownerId: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    if (existing.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this product's store" });
      return;
    }

    // Check if any variant is linked to existing order items
    const orderItemsCount = await prisma.orderItem.count({
      where: { variant: { productId } },
    });

    if (orderItemsCount > 0) {
      // Unpublish so it no longer appears in the storefront, preserving order history
      await prisma.product.update({
        where: { id: productId },
        data: { isPublished: false },
      });

      res.status(409).json({
        error: "Product has associated orders and cannot be permanently deleted. It has been archived (unpublished) instead.",
      });
      return;
    }

    // Safe to delete variants and product in a transaction
    await prisma.$transaction([
      prisma.variant.deleteMany({ where: { productId } }),
      prisma.product.delete({ where: { id: productId } }),
    ]);

    res.json({ message: "Product deleted successfully" });
  } catch (error) {
    console.error("Delete product error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
