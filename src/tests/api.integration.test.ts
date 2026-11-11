import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../app.js";
import { signToken } from "../lib/auth.js";

describe("API Integration Tests (HTTP Endpoint & Middleware Suite)", () => {
  let server: http.Server;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      // Listen on ephemeral port (0) to prevent port conflicts
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address === "object") {
          baseUrl = `http://127.0.0.1:${address.port}`;
        }
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  describe("Public Health & Root Endpoints", () => {
    it("GET / should return 200 with API welcome payload", async () => {
      const res = await fetch(`${baseUrl}/`);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.message, "Welcome to Qeto API");
      assert.equal(data.docs, "/health");
    });

    it("GET /api/agreement/current should return 200 with active platform terms", async () => {
      const res = await fetch(`${baseUrl}/api/agreement/current`);
      assert.equal(res.status, 200);

      const data = await res.json();
      assert.equal(data.agreement.version, "v1.0");
      assert.equal(data.agreement.summary.standardCommissionBps, 300);
      assert.equal(data.agreement.summary.freeTrialDays, 7);
      assert.equal(data.agreement.summary.freeTrialCommissionBps, 0);
    });
  });

  describe("Validation Middleware & Auth Guard Integration", () => {
    it("POST /api/auth/register should return 400 when required fields are missing", async () => {
      const res = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Abebe" }), // missing phone and password
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error, "Validation failed");
      assert(data.details.phone !== undefined, "Expected phone validation error");
      assert(data.details.password !== undefined, "Expected password validation error");
    });

    it("POST /api/auth/login should return 401 on non-existent account", async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: "0911000000",
          password: "wrongpassword123",
        }),
      });

      assert.equal(res.status, 401);
      const data = await res.json();
      assert.equal(data.error, "Invalid phone number or password");
    });

    it("GET /api/orders/store/:storeId should return 401 without Bearer token", async () => {
      const res = await fetch(`${baseUrl}/api/orders/store/store_nonexistent`);
      assert.equal(res.status, 401);

      const data = await res.json();
      assert.match(data.error, /Unauthorized/i);
    });

    it("GET /api/admin/disputes should return 401 without Admin token", async () => {
      const res = await fetch(`${baseUrl}/api/admin/disputes`);
      assert.equal(res.status, 401);

      const data = await res.json();
      assert.match(data.error, /Unauthorized/i);
    });
  });

  describe("Public Storefront & Orders Integration", () => {
    it("GET /api/stores/:slug should return 404 for non-existent store", async () => {
      const res = await fetch(`${baseUrl}/api/stores/non-existent-store-slug-9999`);
      assert.equal(res.status, 404);

      const data = await res.json();
      assert.equal(data.error, "Store not found");
    });

    it("POST /api/public/orders should return 400 when order body is invalid", async () => {
      const res = await fetch(`${baseUrl}/api/public/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storeId: "",
          customerName: "A", // too short
        }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.error, "Validation failed");
    });

    it("POST /api/payments/initialize should return 404 for non-existent order token", async () => {
      const res = await fetch(`${baseUrl}/api/payments/initialize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderToken: "tok_invalid_fake_order_12345",
        }),
      });

      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.error, "Order not found");
    });
  });

  describe("File Upload & Static Serving Integration", () => {
    it("POST /api/upload should return 401 without Bearer token", async () => {
      const res = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }),
      });

      assert.equal(res.status, 401);
    });

    it("POST /api/upload should successfully save image and serve statically", async () => {
      const testToken = signToken("test_merchant_user_id");
      // 1x1 transparent PNG data URI
      const base64Png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

      const uploadRes = await fetch(`${baseUrl}/api/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify({ image: base64Png }),
      });

      assert.equal(uploadRes.status, 201);
      const uploadData = await uploadRes.json();
      assert.equal(uploadData.message, "Image uploaded successfully");
      assert(uploadData.url.startsWith("/uploads/"));
      assert(uploadData.filename.endsWith(".png"));

      // Verify that the static file can be downloaded via GET /uploads/...
      const staticRes = await fetch(`${baseUrl}${uploadData.url}`);
      assert.equal(staticRes.status, 200);
      const arrayBuf = await staticRes.arrayBuffer();
      assert(arrayBuf.byteLength > 0);
    });
  });

  describe("Real-time Server-Sent Events (SSE) Live Receipt Integration", () => {
    it("GET /api/public/orders/:orderToken/live should return 404 for non-existent order", async () => {
      const res = await fetch(`${baseUrl}/api/public/orders/fake_order_token_9999/live`);
      assert.equal(res.status, 404);

      const data = await res.json();
      assert.equal(data.error, "Order not found");
    });
  });
});
