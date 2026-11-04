import { z } from "zod";

export const payoutAccountSchema = z.object({
  bankCode: z.string().min(1, "Bank or wallet code is required"),
  bankName: z.string().min(2, "Bank or wallet name is required"),
  accountNumber: z.string().min(5, "Account or phone number must be at least 5 characters"),
  accountName: z.string().min(2, "Account holder name is required").max(100),
});

export const requestPayoutSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  amountETB: z.number().positive("Amount must be greater than 0").optional(),
});

export type PayoutAccountInput = z.infer<typeof payoutAccountSchema>;
export type RequestPayoutInput = z.infer<typeof requestPayoutSchema>;

