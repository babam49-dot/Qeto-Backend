import { Router, Request, Response } from "express";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { getParam } from "../lib/params.js";
import {
  createCategorySchema,
  updateCategorySchema,
  reorderCategoriesSchema,
} from "../schemas/index.js";

export const categoriesRouter = Router();

// =============================================================
// PUBLIC ROUTES (Buyers & Storefront)
// =============================================================

/**
 * GET /api/categories/store/:storeId
 * Public endpoint: Returns all categories for a store sorted by sortOrder.
 * Each category includes the count of published products so buyers can browse.
 */
categoriesRouter.get("/store/:storeId", async (req: Request, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, status: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.status === "SUSPENDED") {
      res.status(403).json({ error: "This store is currently unavailable" });
      return;
    }

    const categories = await prisma.category.findMany({
      where: { storeId },
      orderBy: { sortOrder: "asc" },
      include: {
        _count: {
          select: {
            products: {
              where: { isPublished: true },
            },
          },
        },
      },
    });

    res.json({
      categories: categories.map((c) => ({
        id: c.id,
        storeId: c.storeId,
        name: c.name,
        keywords: c.keywords,
        sortOrder: c.sortOrder,
        productCount: c._count.products,
        createdAt: c.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("List store categories error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/categories/:id
 * Public endpoint: Returns details for a single category with its published products.
 */
categoriesRouter.get("/:id", async (req: Request, res: Response) => {
  try {
    const categoryId = getParam(req.params.id);
    if (!categoryId) {
      res.status(400).json({ error: "Category ID is required" });
      return;
    }

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: {
        store: { select: { id: true, name: true, slug: true, status: true } },
        products: {
          where: { isPublished: true },
          select: {
            id: true,
            name: true,
            description: true,
            imageUrls: true,
            createdAt: true,
            variants: {
              select: {
                id: true,
                label: true,
                priceCents: true,
                stock: true,
              },
            },
          },
        },
      },
    });

    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    if (category.store.status === "SUSPENDED") {
      res.status(403).json({ error: "This store is currently unavailable" });
      return;
    }

    res.json({ category });
  } catch (error: any) {
    console.error("Get category by ID error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// MERCHANT ROUTES (Category Management)
// =============================================================

/**
 * POST /api/categories
 * Protected endpoint: Creates a new category for a store.
 * - Validates merchant ownership of the store.
 * - Cleans and normalizes keywords for auto-import keyword matching.
 */
categoriesRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = createCategorySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, name, keywords, sortOrder } = parseResult.data;

    // Verify store exists and caller is owner
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ownerId: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Check unique name per store
    const existing = await prisma.category.findUnique({
      where: {
        storeId_name: {
          storeId,
          name: name.trim(),
        },
      },
    });

    if (existing) {
      res.status(409).json({ error: `Category "${name.trim()}" already exists in this store` });
      return;
    }

    // Clean keywords (lowercase, unique)
    const normalizedKeywords = Array.from(
      new Set((keywords || []).map((k) => k.toLowerCase().trim()))
    );

    const category = await prisma.category.create({
      data: {
        storeId,
        name: name.trim(),
        keywords: normalizedKeywords,
        sortOrder,
      },
    });

    res.status(201).json({
      message: "Category created successfully",
      category,
    });
  } catch (error: any) {
    console.error("Create category error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /api/categories/:id
 * Protected endpoint: Updates a category's name, keywords, or sort order.
 * - Validates caller owns the store the category belongs to.
 */
categoriesRouter.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const categoryId = getParam(req.params.id);
    if (!categoryId) {
      res.status(400).json({ error: "Category ID is required" });
      return;
    }

    const parseResult = updateCategorySchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: { store: { select: { ownerId: true } } },
    });

    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    if (category.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    const updateData: any = {};
    if (parseResult.data.name !== undefined) {
      updateData.name = parseResult.data.name.trim();
    }
    if (parseResult.data.keywords !== undefined) {
      updateData.keywords = Array.from(
        new Set(parseResult.data.keywords.map((k) => k.toLowerCase().trim()))
      );
    }
    if (parseResult.data.sortOrder !== undefined) {
      updateData.sortOrder = parseResult.data.sortOrder;
    }

    const updated = await prisma.category.update({
      where: { id: categoryId },
      data: updateData,
    });

    res.json({
      message: "Category updated successfully",
      category: updated,
    });
  } catch (error: any) {
    console.error("Update category error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /api/categories/:id
 * Protected endpoint: Deletes a category.
 * Existing products have categoryId set to NULL (they become Uncategorized, not deleted).
 */
categoriesRouter.delete("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const categoryId = getParam(req.params.id);
    if (!categoryId) {
      res.status(400).json({ error: "Category ID is required" });
      return;
    }

    const category = await prisma.category.findUnique({
      where: { id: categoryId },
      include: { store: { select: { ownerId: true } } },
    });

    if (!category) {
      res.status(404).json({ error: "Category not found" });
      return;
    }

    if (category.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Safely delete — schema onDelete: SetNull unlinks products automatically
    await prisma.category.delete({
      where: { id: categoryId },
    });

    res.json({ message: "Category deleted successfully" });
  } catch (error: any) {
    console.error("Delete category error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/categories/reorder
 * Protected endpoint: Reorder multiple categories in a single atomic transaction.
 */
categoriesRouter.post("/reorder", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = reorderCategoriesSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, items } = parseResult.data;

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { ownerId: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    await prisma.$transaction(
      items.map((item) =>
        prisma.category.update({
          where: { id: item.id },
          data: { sortOrder: item.sortOrder },
        })
      )
    );

    res.json({ message: "Categories reordered successfully" });
  } catch (error: any) {
    console.error("Reorder categories error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

