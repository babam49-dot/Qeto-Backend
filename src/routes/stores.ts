import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { Prisma } from "../generated/client.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { normalizePhone } from "../lib/auth.js";

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

// Validation schema for creating a store
const createStoreSchema = z.object({
  name: z.string().min(2, "Store name must be at least 2 characters").max(100),
  slug: z
    .string()
    .min(3, "Slug must be at least 3 characters")
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug can only contain lowercase letters, numbers, and hyphens")
    .optional(),
  phone: z.string().min(9, "Phone number is required"),
  description: z.string().max(500).optional(),
  logoUrl: z.string().url("Invalid logo URL").optional().or(z.literal("")),
});

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

    const { name, slug: customSlug, phone: rawPhone, description, logoUrl } = parseResult.data;

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

    // Set 14-day trial period
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    // Create the store
    const store = await prisma.store.create({
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
