import { Router, Request, Response } from "express";
import { prisma } from "../db.js";
import { Prisma } from "../generated/client.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { normalizePhone } from "../lib/auth.js";
import { getParam } from "../lib/params.js";
import { createStoreSchema, updateStoreSchema } from "../schemas/index.js";

export const storesRouter = Router();

// Reserved slugs that cannot be claimed by stores
const RESERVED_SLUGS = new Set([
  "api",
  "admin",
  "auth",
  "login",
  "register",
  "dashboard",
  "settings",
  "checkout",
  "orders",
  "products",
  "cart",
]);

/**
 * Converts a string into a URL-friendly slug:
 * e.g. "Abebe & Sons Boutique!" -> "abebe-sons-boutique"
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric chars with hyphens
    .replace(/^-+|-+$/g, ""); // Strip leading & trailing hyphens
}

/**
 * POST /api/stores
 * Creates a new store for the authenticated seller.
 * - Auto-generates slug from store name if not provided
 * - Validates unique slug and protects against P2002 race conditions
 * - Starts store with a 14-day free trial
 */
storesRouter.post("/", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = createStoreSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { name, slug: customSlug, phone: rawPhone, description, logoUrl, acceptTerms } = parseResult.data;

    // Normalize phone number
    const normalizedPhone = normalizePhone(rawPhone);
    if (!normalizedPhone) {
      res.status(400).json({
        error: "Invalid Ethiopian phone number. Use format: 0912345678 or +251912345678",
      });
      return;
    }

    // Determine final slug
    const finalSlug = customSlug ? slugify(customSlug) : slugify(name);

    if (finalSlug.length < 3) {
      res.status(400).json({ error: "Store slug must be at least 3 characters long" });
      return;
    }

    if (RESERVED_SLUGS.has(finalSlug)) {
      res.status(400).json({ error: `The slug "${finalSlug}" is reserved. Please pick another.` });
      return;
    }

    // Check if slug is already taken
    const existing = await prisma.store.findUnique({
      where: { slug: finalSlug },
    });
    if (existing) {
      res.status(409).json({ error: `Store slug "${finalSlug}" is already taken` });
      return;
    }

    // Set 7-day trial period per Product Design spec v1.0
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 7);

    // Client IP for agreement acceptance
    const clientIp =
      (typeof req.headers["x-forwarded-for"] === "string"
        ? req.headers["x-forwarded-for"].split(",")[0].trim()
        : req.ip) || req.socket.remoteAddress || null;
    const userAgent = req.headers["user-agent"] || null;

    // Create the store and optionally record agreement acceptance atomically
    const store = await prisma.$transaction(async (tx) => {
      const s = await tx.store.create({
        data: {
          name,
          slug: finalSlug,
          phone: normalizedPhone,
          description: description || null,
          logoUrl: logoUrl || null,
          ownerId: req.userId!,
          trialEndsAt,
        },
      });

      if (acceptTerms) {
        await tx.agreementAcceptance.upsert({
          where: { storeId: s.id },
          create: {
            userId: req.userId!,
            storeId: s.id,
            version: "v1.0",
            ip: clientIp,
            userAgent,
          },
          update: {
            version: "v1.0",
            acceptedAt: new Date(),
            ip: clientIp,
            userAgent,
          },
        });
      }

      return s;
    });

    res.status(201).json({
      message: "Store created successfully",
      store,
    });
  } catch (error) {
    // Catch P2002 unique constraint race condition on slug
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      res.status(409).json({ error: "Store slug is already taken" });
      return;
    }

    console.error("Create store error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/stores/mine
 * Returns all stores owned by the authenticated seller.
 * Includes counts of their products and orders for dashboard display.
 */
storesRouter.get("/mine", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const stores = await prisma.store.findMany({
      where: { ownerId: req.userId },
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: {
            products: true,
            orders: true,
          },
        },
      },
    });

    res.json({ stores });
  } catch (error) {
    console.error("Fetch my stores error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/stores/:slug
 * Public endpoint: accessible by buyers without logging in.
 * Returns store public info and active/published products with variants.
 */
storesRouter.get("/:slug", async (req: Request, res: Response) => {
  try {
    const slug = getParam(req.params.slug).toLowerCase();

    if (!slug) {
      res.status(400).json({ error: "Store slug is required" });
      return;
    }

    const categoryFilter = req.query.category as string | undefined;

    const store = await prisma.store.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        logoUrl: true,
        phone: true,
        status: true,
        createdAt: true,
        categories: {
          orderBy: { sortOrder: "asc" },
          select: {
            id: true,
            name: true,
            keywords: true,
            sortOrder: true,
            _count: {
              select: {
                products: { where: { isPublished: true } },
              },
            },
          },
        },
        products: {
          where: {
            isPublished: true,
            ...(categoryFilter ? { categoryId: categoryFilter } : {}),
          },
          select: {
            id: true,
            categoryId: true,
            category: { select: { id: true, name: true } },
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

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.status === "SUSPENDED") {
      res.status(403).json({ error: "This store is currently unavailable" });
      return;
    }

    // Format response so categories include productCount
    const formattedCategories = store.categories.map((c) => ({
      id: c.id,
      name: c.name,
      keywords: c.keywords,
      sortOrder: c.sortOrder,
      productCount: c._count.products,
    }));

    res.json({
      store: {
        ...store,
        categories: formattedCategories,
      },
    });
  } catch (error) {
    console.error("Get store by slug error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});


/**
 * PATCH /api/stores/:id
 * Protected endpoint: updates store details (name, phone, description, logoUrl).
 * Validates ownership — only the seller who owns the store can update it.
 */
storesRouter.patch("/:id", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.id);

    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const parseResult = updateStoreSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    // Check if store exists
    const existingStore = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!existingStore) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    // Verify ownership
    if (existingStore.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    const { name, phone: rawPhone, description, logoUrl } = parseResult.data;

    let normalizedPhone: string | null | undefined = undefined;
    if (rawPhone) {
      normalizedPhone = normalizePhone(rawPhone);
      if (!normalizedPhone) {
        res.status(400).json({
          error: "Invalid Ethiopian phone number. Use format: 0912345678 or +251912345678",
        });
        return;
      }
    }

    const updatedStore = await prisma.store.update({
      where: { id: storeId },
      data: {
        ...(name !== undefined && { name }),
        ...(normalizedPhone !== undefined && { phone: normalizedPhone }),
        ...(description !== undefined && { description: description || null }),
        ...(logoUrl !== undefined && { logoUrl: logoUrl || null }),
      },
    });

    res.json({
      message: "Store updated successfully",
      store: updatedStore,
    });
  } catch (error) {
    console.error("Update store error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
