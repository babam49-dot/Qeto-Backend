import { z } from "zod";

export const orderItemSchema = z.object({
  variantId: z.string().min(1, "Variant ID is required"),
  quantity: z.number().int().min(1, "Quantity must be at least 1"),
});

export const createOrderSchema = z.object({
  storeId: z.string().min(1, "Store ID is required"),
  customerName: z.string().min(2, "Customer name must be at least 2 characters").max(100),
  phone: z.string().min(9, "Phone number is required"),
  address: z.string().min(3, "Delivery address is required").max(500),
  paymentMethod: z.enum(["ONLINE", "COD"]).default("ONLINE"),
  items: z.array(orderItemSchema).min(1, "Order must contain at least one item"),
});

export const deliveryCodeSchema = z.object({
  deliveryCode: z.string().regex(/^\d{4}$/, "Delivery code must be exactly 4 digits"),
});

export type OrderItemInput = z.infer<typeof orderItemSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type DeliveryCodeInput = z.infer<typeof deliveryCodeSchema>;

