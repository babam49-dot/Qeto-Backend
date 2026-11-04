import { z } from "zod";

export const createCategorySchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  name: z.string().min(1, "Category name is required").max(60, "Category name is too long"),
  keywords: z.array(z.string().trim().min(1)).optional().default([]),
  sortOrder: z.number().int().optional().default(0),
});

export const updateCategorySchema = z.object({
  name: z.string().min(1).max(60).optional(),
  keywords: z.array(z.string().trim().min(1)).optional(),
  sortOrder: z.number().int().optional(),
});

export const reorderCategoriesSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  items: z
    .array(
      z.object({
        id: z.string().min(1),
        sortOrder: z.number().int(),
      })
    )
    .min(1, "At least one category order item is required"),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>;

