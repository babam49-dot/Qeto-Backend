import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { getParam } from "../lib/params.js";
import { ImportedPostStatus } from "../generated/enums.js";

export const importsRouter = Router();

// Protect all imports inbox endpoints with merchant authentication
importsRouter.use(requireAuth);

const approveImportSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  categoryId: z.string().nullable().optional(),
  priceCents: z.number().int().positive().optional(),
  variants: z
    .array(
      z.object({
        label: z.string().min(1).max(50),
        priceCents: z.number().int().positive(),
        stock: z.number().int().min(0).default(1),
      })
    )
    .min(1)
    .optional(),
  imageUrls: z.array(z.string().url()).optional(),
  isPublished: z.boolean().optional().default(true),
});

/**
 * GET /api/imports/:storeId
 * Lists pending imported posts from Telegram for the merchant to review and publish.
 */
importsRouter.get("/:storeId", async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

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

    const statusParam = req.query.status as string | undefined;
    const status =
      statusParam && Object.values(ImportedPostStatus).includes(statusParam as ImportedPostStatus)
        ? (statusParam as ImportedPostStatus)
        : ImportedPostStatus.PENDING;

    const posts = await prisma.importedPost.findMany({
      where: {
        storeId,
        status,
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      count: posts.length,
      imports: posts.map((p) => ({
        id: p.id,
        channelId: p.channelId,
        messageId: p.messageId,
        rawCaption: p.rawCaption,
        imageUrls: p.imageUrls,
        parsedData: p.parsedData,
        status: p.status,
        productId: p.productId,
        createdAt: p.createdAt,
      })),
    });
  } catch (error: any) {
    console.error("List imports error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/imports/:id/approve
 * Approves an imported post, turning it into a real Store Product.
 * Allows the merchant to override or refine title, price, sizes, or category before publishing.
 */
importsRouter.post("/:id/approve", async (req: AuthRequest, res: Response) => {
  try {
    const importId = getParam(req.params.id);
    if (!importId) {
      res.status(400).json({ error: "Import ID is required" });
      return;
    }

    const importedPost = await prisma.importedPost.findUnique({
      where: { id: importId },
      include: { store: true },
    });

    if (!importedPost) {
      res.status(404).json({ error: "Imported post not found" });
      return;
    }

    if (importedPost.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    if (importedPost.status === ImportedPostStatus.APPROVED) {
      res.status(400).json({ error: "Post has already been approved and created as a product" });
      return;
    }

    const parseResult = approveImportSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const parsedData: any = importedPost.parsedData || {};
    const body = parseResult.data;

    // Resolve final attributes
    const name = body.name || parsedData.title || "Telegram Product";
    const description = body.description || parsedData.description || importedPost.rawCaption || "";
    const categoryId = body.categoryId !== undefined ? body.categoryId : parsedData.matchedCategoryId || null;
    const imageUrls = body.imageUrls || importedPost.imageUrls || [];
    const isPublished = body.isPublished !== undefined ? body.isPublished : true;

    // Resolve variants
    let variantsToCreate = body.variants;
    if (!variantsToCreate || variantsToCreate.length === 0) {
      const fallbackPrice = body.priceCents || parsedData.priceCents || 0;
      const fallbackSizes: string[] = parsedData.sizes || ["Standard"];
      const fallbackStock = parsedData.stock || 1;

      variantsToCreate = fallbackSizes.map((size) => ({
        label: size,
        priceCents: fallbackPrice,
        stock: fallbackStock,
      }));
    }

    // Atomic transaction: Create Product + Update ImportedPost
    const result = await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: {
          storeId: importedPost.storeId,
          categoryId,
          name,
          description,
          imageUrls,
          isPublished,
          variants: {
            create: variantsToCreate.map((v) => ({
              label: v.label,
              priceCents: v.priceCents,
              stock: v.stock,
            })),
          },
        },
        include: {
          variants: true,
          category: { select: { id: true, name: true } },
        },
      });

      const updatedImport = await tx.importedPost.update({
        where: { id: importId },
        data: {
          status: ImportedPostStatus.APPROVED,
          productId: product.id,
        },
      });

      return { product, import: updatedImport };
    });

    res.status(201).json({
      message: "Import approved and product published successfully",
      product: result.product,
    });
  } catch (error: any) {
    console.error("Approve import error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /api/imports/:id/reject
 * Rejects an imported post (e.g. announcement, quote, non-product post).
 */
importsRouter.post("/:id/reject", async (req: AuthRequest, res: Response) => {
  try {
    const importId = getParam(req.params.id);
    if (!importId) {
      res.status(400).json({ error: "Import ID is required" });
      return;
    }

    const importedPost = await prisma.importedPost.findUnique({
      where: { id: importId },
      include: { store: true },
    });

    if (!importedPost) {
      res.status(404).json({ error: "Imported post not found" });
      return;
    }

    if (importedPost.store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    const updated = await prisma.importedPost.update({
      where: { id: importId },
      data: { status: ImportedPostStatus.REJECTED },
    });

    res.json({
      message: "Import rejected successfully",
      import: updated,
    });
  } catch (error: any) {
    console.error("Reject import error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
