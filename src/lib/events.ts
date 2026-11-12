import { EventEmitter } from "node:events";

export interface OrderUpdatePayload {
  orderToken: string;
  status: string;
  paymentStatus?: string;
  deliveryCode?: string | null;
  deliveredAt?: Date | null;
  releaseAt?: Date | null;
  message: string;
  updatedAt: string;
}

export interface StoreOrderPayload {
  orderId?: string;
  orderToken: string;
  status: string;
  customerName?: string;
  phone?: string;
  totalCents?: number;
  message: string;
  updatedAt: string;
}

class OrderEventEmitter extends EventEmitter {
  constructor() {
    super();
    // Allow up to 500 concurrent live SSE connections without memory leak warnings
    this.setMaxListeners(500);
  }

  // 1. Buyer Live Stream Events
  emitOrderUpdate(orderToken: string, payload: OrderUpdatePayload): void {
    this.emit(`order:${orderToken}`, payload);
  }

  subscribeToOrder(
    orderToken: string,
    listener: (payload: OrderUpdatePayload) => void
  ): () => void {
    const eventName = `order:${orderToken}`;
    this.on(eventName, listener);
    return () => {
      this.off(eventName, listener);
    };
  }

  // 2. Seller / Merchant Dashboard Live Stream Events
  emitStoreOrderUpdate(storeId: string, payload: StoreOrderPayload): void {
    this.emit(`store:${storeId}`, payload);
  }

  subscribeToStore(
    storeId: string,
    listener: (payload: StoreOrderPayload) => void
  ): () => void {
    const eventName = `store:${storeId}`;
    this.on(eventName, listener);
    return () => {
      this.off(eventName, listener);
    };
  }
}

export const orderEvents = new OrderEventEmitter();
