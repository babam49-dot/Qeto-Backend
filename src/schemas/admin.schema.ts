import { z } from "zod";

export const updateAdminStoreSchema = z.object({
  status: z.enum(["TRIAL", "ACTIVE", "SUSPENDED"]).optional(),
  commissionBps: z
    .number()
    .int()
    .min(0, "Commission cannot be negative")
    .max(5000, "Commission cannot exceed 50%")
    .optional(),
  extendTrialDays: z.number().int().positive("Days to extend must be positive").optional(),
  trialEndsAt: z.string().datetime().optional(),
});

export type UpdateAdminStoreInput = z.infer<typeof updateAdminStoreSchema>;

