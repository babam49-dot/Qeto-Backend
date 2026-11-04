import { z } from "zod";

export const createStoreSchema = z.object({
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
  acceptTerms: z.boolean().optional(),
});

export const updateStoreSchema = createStoreSchema.partial();

export type CreateStoreInput = z.infer<typeof createStoreSchema>;
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

