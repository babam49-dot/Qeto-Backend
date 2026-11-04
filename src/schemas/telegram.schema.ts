import { z } from "zod";

export const connectChannelSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  channelHandle: z.string().min(2, "Channel username or link is required"),
  alertChatId: z.string().optional(),
});

export const updateTelegramSettingsSchema = z.object({
  autoImport: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  notifyOnOrder: z.boolean().optional(),
  alertChatId: z.string().optional(),
});

export const approveImportSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  categoryId: z.string().nullable().optional(),
  priceCents: z.number().int().positive().optional(),
  variants: z
    .array(
      z.object({
        label: z.string().min(1).max(50),
        priceCents: z.number().int().positive(),
        stock: z.number().int().min(0).default(1),
      })
    )
    .min(1)
    .optional(),
  imageUrls: z.array(z.string().url()).optional(),
  isPublished: z.boolean().optional().default(true),
});

export type ConnectChannelInput = z.infer<typeof connectChannelSchema>;
export type UpdateTelegramSettingsInput = z.infer<typeof updateTelegramSettingsSchema>;
export type ApproveImportInput = z.infer<typeof approveImportSchema>;

