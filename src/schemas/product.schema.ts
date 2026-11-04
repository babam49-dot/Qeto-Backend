import { z } from "zod";

export const variantInputSchema = z.object({
  label: z.string().min(1, "Variant label is required (e.g., 'Default', 'M', 'Red')").max(50),
  priceCents: z.number().int().min(0, "Price in cents must be a non-negative integer"),
  stock: z.number().int().min(0, "Stock must be a non-negative integer"),
});

export const updateVariantItemSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1).max(50),
  priceCents: z.number().int().min(0),
  stock: z.number().int().min(0),
});

export const createProductSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  categoryId: z.string().nullable().optional(),
  name: z.string().min(2, "Product name must be at least 2 characters").max(120),
  description: z.string().max(2000).optional(),
  imageUrls: z.array(z.string().url("Invalid image URL")).max(10).optional().default([]),
  isPublished: z.boolean().optional().default(true),
  variants: z
    .array(variantInputSchema)
    .min(1, "Product must have at least one variant (e.g. Standard/Default)"),
});

export const updateProductSchema = z.object({
  categoryId: z.string().nullable().optional(),
  name: z.string().min(2, "Product name must be at least 2 characters").max(120).optional(),
  description: z.string().max(2000).optional(),
  imageUrls: z.array(z.string().url("Invalid image URL")).max(10).optional(),
  isPublished: z.boolean().optional(),
  variants: z.array(updateVariantItemSchema).min(1).optional(),
});

export type VariantInput = z.infer<typeof variantInputSchema>;
export type UpdateVariantItem = z.infer<typeof updateVariantItemSchema>;
export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

