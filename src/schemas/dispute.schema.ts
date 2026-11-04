import { z } from "zod";

export const openDisputeSchema = z.object({
  reason: z.string().min(5, "Dispute reason must be at least 5 characters").max(1000),
  message: z.string().max(2000).optional(),
  imageUrl: z.string().url("Invalid image URL").optional(),
});

export const addEvidenceSchema = z.object({
  author: z.enum(["BUYER", "MERCHANT"]).default("BUYER"),
  message: z.string().min(2, "Evidence message must be at least 2 characters").max(2000),
  imageUrl: z.string().url("Invalid image URL").optional(),
});

export const decideDisputeSchema = z.object({
  decision: z.enum(["REFUND", "RELEASE", "PARTIAL"]),
  refundCents: z.number().int().positive().optional(),
  note: z.string().max(1000).optional(),
});

export type OpenDisputeInput = z.infer<typeof openDisputeSchema>;
export type AddEvidenceInput = z.infer<typeof addEvidenceSchema>;
export type DecideDisputeInput = z.infer<typeof decideDisputeSchema>;

