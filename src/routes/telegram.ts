import { Router, Request, Response } from "express";
import { prisma } from "../db.js";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";
import { getParam } from "../lib/params.js";
import {
  verifyChannelConnection,
  parseTelegramPost,
} from "../lib/telegram.js";
import { ImportedPostStatus } from "../generated/enums.js";
import {
  connectChannelSchema,
  updateTelegramSettingsSchema as updateSettingsSchema,
} from "../schemas/index.js";

export const telegramRouter = Router();

// =============================================================
// MERCHANT TELEGRAM SETTINGS
// =============================================================

/**
 * POST /api/telegram/connect
 * Protected endpoint: Connects a merchant's Telegram channel to their store.
 * - Checks bot admin permissions
 * - Saves channel ID mapping
 */
telegramRouter.post("/connect", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = connectChannelSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { storeId, channelHandle, alertChatId } = parseResult.data;

    const store = await prisma.store.findUnique({
      where: { id: storeId },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    // Verify channel and admin status with Telegram Bot API
    const verifyResult = await verifyChannelConnection(channelHandle);
    if (!verifyResult.success || !verifyResult.channelId) {
      res.status(400).json({ error: verifyResult.error || "Failed to verify Telegram channel" });
      return;
    }

    // Save or update channel connection
    const connection = await prisma.telegramConnection.upsert({
      where: { storeId },
      create: {
        storeId,
        channelId: verifyResult.channelId,
        channelUsername: verifyResult.channelUsername,
        channelTitle: verifyResult.channelTitle || channelHandle,
        alertChatId: alertChatId || null,
        autoImport: true,
        notifyOnOrder: true,
      },
      update: {
        channelId: verifyResult.channelId,
        channelUsername: verifyResult.channelUsername,
        channelTitle: verifyResult.channelTitle || channelHandle,
        alertChatId: alertChatId !== undefined ? alertChatId : undefined,
      },
    });

    res.json({
      message: "Telegram channel connected successfully",
      connection,
    });
  } catch (error: any) {
    console.error("Connect telegram error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /api/telegram/connection/:storeId
 * Protected endpoint: Returns current connection status and settings.
 */
telegramRouter.get("/connection/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { telegramConnection: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    res.json({
      isConnected: Boolean(store.telegramConnection),
      connection: store.telegramConnection,
    });
  } catch (error: any) {
    console.error("Get telegram connection error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * PATCH /api/telegram/connection/:storeId
 * Protected endpoint: Updates channel auto-import and order alert preferences.
 */
telegramRouter.patch("/connection/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const parseResult = updateSettingsSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { telegramConnection: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    if (!store.telegramConnection) {
      res.status(400).json({ error: "No Telegram channel connected yet" });
      return;
    }

    const updated = await prisma.telegramConnection.update({
      where: { storeId },
      data: parseResult.data,
    });

    res.json({
      message: "Telegram settings updated successfully",
      connection: updated,
    });
  } catch (error: any) {
    console.error("Update telegram settings error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * DELETE /api/telegram/connection/:storeId
 * Protected endpoint: Disconnects the Telegram channel.
 */
telegramRouter.delete("/connection/:storeId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const storeId = getParam(req.params.storeId);
    if (!storeId) {
      res.status(400).json({ error: "Store ID is required" });
      return;
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { telegramConnection: true },
    });

    if (!store) {
      res.status(404).json({ error: "Store not found" });
      return;
    }

    if (store.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden: You do not own this store" });
      return;
    }

    if (store.telegramConnection) {
      await prisma.telegramConnection.delete({
        where: { storeId },
      });
    }

    res.json({ message: "Telegram channel disconnected successfully" });
  } catch (error: any) {
    console.error("Disconnect telegram error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// TELEGRAM WEBHOOK RECEIVER
// =============================================================

/**
 * POST /api/telegram/webhook
 * Public endpoint called by Telegram Bot webhook when a new post is published in any channel.
 * 1. Matches chat.id to registered Store
 * 2. Deduplicates by (channelId, messageId)
 * 3. Parses caption (price, sizes, category keywords)
 * 4. Saves to merchant's Import Inbox (or auto-publishes if configured)
 */
telegramRouter.post("/webhook", async (req: Request, res: Response) => {
  try {
    const update = req.body;

    // We listen to channel_post (channels) or message (groups/test channels)
    const post = update.channel_post || update.message;
    if (!post || !post.chat?.id || !post.message_id) {
      res.status(200).json({ ok: true, ignored: "No channel post" });
      return;
    }

    const channelId = post.chat.id.toString();
    const messageId = post.message_id;
    const mediaGroupId = post.media_group_id ? post.media_group_id.toString() : null;
    const caption = post.caption || post.text || "";

    // 1. Find matching store connection
    const connection = await prisma.telegramConnection.findUnique({
      where: { channelId },
      include: { store: true },
    });

    if (!connection) {
      // Post from an unregistered channel — safely ignore
      res.status(200).json({ ok: true, ignored: "Unregistered channel" });
      return;
    }

    if (!connection.autoImport) {
      res.status(200).json({ ok: true, ignored: "Auto-import disabled" });
      return;
    }

    // 2. Prevent duplicate processing
    const existingImport = await prisma.importedPost.findUnique({
      where: {
        channelId_messageId: {
          channelId,
          messageId,
        },
      },
    });

    if (existingImport) {
      res.status(200).json({ ok: true, ignored: "Post already imported" });
      return;
    }

    // 3. Extract photos if present
    const imageUrls: string[] = [];
    if (post.photo && Array.isArray(post.photo) && post.photo.length > 0) {
      // Pick highest resolution photo
      const bestPhoto = post.photo[post.photo.length - 1];
      if (bestPhoto.file_id) {
        // Save file reference (can be resolved to download URL or hosted storage)
        imageUrls.push(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${bestPhoto.file_id}`);
      }
    }

    // 4. Parse caption for price, sizes, stock, category
    const parsed = await parseTelegramPost(caption, connection.storeId);

    // 5. Handle Auto-Publish vs Save as Draft
    let autoCreatedProductId: string | null = null;
    let postStatus: ImportedPostStatus = ImportedPostStatus.PENDING;

    if (connection.autoPublish && parsed.confidence === "HIGH" && parsed.priceCents) {
      // Create product immediately
      const newProduct = await prisma.product.create({
        data: {
          storeId: connection.storeId,
          categoryId: parsed.matchedCategoryId,
          name: parsed.title,
          description: parsed.description,
          imageUrls,
          isPublished: true,
          variants: {
            create: parsed.sizes.map((s) => ({
              label: s,
              priceCents: parsed.priceCents!,
              stock: parsed.stock || 1,
            })),
          },
        },
      });

      autoCreatedProductId = newProduct.id;
      postStatus = ImportedPostStatus.APPROVED;
    }

    // 6. Record in ImportedPost table
    const importedPost = await prisma.importedPost.create({
      data: {
        storeId: connection.storeId,
        channelId,
        messageId,
        mediaGroupId,
        rawCaption: caption,
        imageUrls,
        parsedData: parsed as any,
        status: postStatus,
        productId: autoCreatedProductId,
      },
    });

    res.status(200).json({
      ok: true,
      importedPostId: importedPost.id,
      autoPublished: Boolean(autoCreatedProductId),
    });
  } catch (error: any) {
    console.error("Telegram webhook error:", error);
    // Return 200 to Telegram so it doesn't repeatedly retry on application error
    res.status(200).json({ ok: false, error: error.message });
  }
});

