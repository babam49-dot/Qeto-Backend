import { z } from "zod";

export const acceptAgreementSchema = z.object({
  version: z.string().min(1, "Agreement version is required"),
  storeId: z.string().optional(),
});

export type AcceptAgreementInput = z.infer<typeof acceptAgreementSchema>;

