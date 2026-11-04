import { z } from "zod";

export const initializePaymentSchema = z.object({
  orderToken: z.string().min(1, "Order token is required"),
  email: z.string().email("Invalid email").optional(),
  returnUrl: z.string().url("Invalid return URL").optional(),
});

export type InitializePaymentInput = z.infer<typeof initializePaymentSchema>;

