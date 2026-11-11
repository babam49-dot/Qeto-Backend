import { Router, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { requireAuth, AuthRequest } from "../middleware/requireAuth.js";

export const uploadRouter = Router();

// Ensure all upload endpoints are protected by authentication
uploadRouter.use(requireAuth);

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

// Supported MIME types and their corresponding file extensions
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

// Validation schemas
const singleUploadSchema = z.object({
  image: z.string().min(1, "Base64 image data is required"),
  filename: z.string().optional(),
});

const multipleUploadSchema = z.object({
  images: z
    .array(z.string().min(1))
    .min(1, "At least one image is required")
    .max(5, "Maximum 5 images can be uploaded at once"),
});

/**
 * Parses and saves a base64-encoded image buffer to the uploads directory.
 */
async function saveBase64Image(base64Input: string): Promise<{ url: string; filename: string; sizeBytes: number }> {
  // Ensure the uploads directory exists
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  // Handle data URI format (e.g., "data:image/png;base64,iVBORw0KGgo...")
  let mimeType = "image/jpeg";
  let cleanBase64 = base64Input;

  const match = base64Input.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
  if (match) {
    mimeType = match[1].toLowerCase();
    cleanBase64 = match[2];
  }

  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error(
      `Unsupported image format: '${mimeType}'. Supported formats: JPEG, PNG, WEBP, GIF.`
    );
  }

  const buffer = Buffer.from(cleanBase64, "base64");

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(`Image size (${(buffer.length / (1024 * 1024)).toFixed(1)}MB) exceeds 5MB limit.`);
  }

  const uniqueName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const filePath = path.join(UPLOADS_DIR, uniqueName);

  await fs.writeFile(filePath, buffer);

  return {
    url: `/uploads/${uniqueName}`,
    filename: uniqueName,
    sizeBytes: buffer.length,
  };
}

/**
 * POST /api/upload
 * Single image upload for store logos, product covers, or dispute evidence.
 * Accepts { image: "data:image/png;base64,..." }
 */
uploadRouter.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = singleUploadSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { image } = parseResult.data;
    const fileResult = await saveBase64Image(image);

    res.status(201).json({
      message: "Image uploaded successfully",
      url: fileResult.url,
      filename: fileResult.filename,
      sizeBytes: fileResult.sizeBytes,
    });
  } catch (error: any) {
    console.error("Single image upload error:", error);
    res.status(400).json({ error: error.message || "Failed to upload image" });
  }
});

/**
 * POST /api/upload/multiple
 * Multi-image upload for product galleries (up to 5 images at once).
 * Accepts { images: ["data:image/png;base64,...", ...] }
 */
uploadRouter.post("/multiple", async (req: AuthRequest, res: Response) => {
  try {
    const parseResult = multipleUploadSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { images } = parseResult.data;
    const uploadedUrls: string[] = [];

    for (const img of images) {
      const fileResult = await saveBase64Image(img);
      uploadedUrls.push(fileResult.url);
    }

    res.status(201).json({
      message: `${uploadedUrls.length} image(s) uploaded successfully`,
      urls: uploadedUrls,
    });
  } catch (error: any) {
    console.error("Multi-image upload error:", error);
    res.status(400).json({ error: error.message || "Failed to upload images" });
  }
});
