import "dotenv/config";
import express from "express";
import cors from "cors";
import { prisma } from "./db.js";
import { authRouter } from "./routes/auth.js";
import { storesRouter } from "./routes/stores.js";
import { productsRouter } from "./routes/products.js";
import { ordersRouter } from "./routes/orders.js";
import { publicOrdersRouter } from "./routes/publicOrders.js";
import { paymentsRouter } from "./routes/payments.js";
import { payoutsRouter } from "./routes/payouts.js";
import { disputesRouter } from "./routes/disputes.js";
import { adminRouter } from "./routes/admin.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { startEscrowWorker } from "./workers/escrow.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (_req, res) => {
  res.json({ message: "Welcome to Qeto API", docs: "/health" });
});

app.get("/health", async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "error", database: "unreachable" });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/stores", storesRouter);
app.use("/api/products", productsRouter);
app.use("/api/public/orders", publicOrdersRouter);
app.use("/api/orders", ordersRouter);
app.use("/api/payments", paymentsRouter);
app.use("/api/payouts", payoutsRouter);
app.use("/api/disputes", disputesRouter);
app.use("/api/admin", adminRouter);

// Centralized error handling middleware
app.use(errorHandler);

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Qeto API running on http://localhost:${port}`);
  // Start background escrow worker — auto-releases funds, expires unpaid orders,
  // and refunds buyers whose sellers missed the shipping deadline.
  startEscrowWorker();
});
