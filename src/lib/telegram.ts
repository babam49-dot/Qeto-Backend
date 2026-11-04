import { prisma } from "../db.js";
import { centsToETB } from "./money.js";

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM BOT API CLIENT & POST PARSER
// ─────────────────────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_API_BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export interface ParsedProductData {
  title: string;
  description: string;
  priceCents: number | null;
  priceETB: string | null;
  sizes: string[];
  stock: number | null;
  matchedCategoryId: string | null;
  matchedCategoryName: string | null;
  confidence: "HIGH" | "MEDIUM" | "LOW";
}

/**
 * Generic Telegram Bot API caller.
 * In development or when no token is configured, safely simulates calls without crashing.
 */
export async function callTelegramApi(method: string, body: Record<string, any>): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn(`[Telegram] No TELEGRAM_BOT_TOKEN provided. Simulating API call: ${method}`);
    // Simulated responses for local testing without real bot credentials
    if (method === "getChat") {
      const username = body.chat_id?.toString().replace("@", "") || "sample_channel";
      return {
        ok: true,
        result: {
          id: -1001234567890,
          title: `${username.charAt(0).toUpperCase() + username.slice(1)} Channel`,
          username,
          type: "channel",
        },
      };
    }
    if (method === "getChatMember") {
      return {
        ok: true,
        result: {
          status: "administrator",
          can_post_messages: true,
        },
      };
    }
    if (method === "sendMessage") {
      console.log(`[Telegram Simulation] Send Message to ${body.chat_id}: ${body.text}`);
      return { ok: true, result: { message_id: 9999 } };
    }
    return { ok: true, result: {} };
  }

  try {
    const response = await fetch(`${TELEGRAM_API_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    return data;
  } catch (error: any) {
    console.error(`[Telegram] Error calling ${method}:`, error.message);
    throw error;
  }
}

/**
 * Verifies a Telegram channel and checks if the Qeto bot is an administrator.
 */
export async function verifyChannelConnection(channelUsernameOrId: string): Promise<{
  success: boolean;
  channelId?: string;
  channelTitle?: string;
  channelUsername?: string;
  error?: string;
}> {
  try {
    const formattedHandle = channelUsernameOrId.startsWith("@") || channelUsernameOrId.startsWith("-100")
      ? channelUsernameOrId
      : `@${channelUsernameOrId.replace(/^https?:\/\/t\.me\//, "")}`;

    const chatRes = await callTelegramApi("getChat", { chat_id: formattedHandle });
    if (!chatRes.ok) {
      return {
        success: false,
        error: `Could not find Telegram channel: ${chatRes.description || "Invalid channel handle"}`,
      };
    }

    const chat = chatRes.result;
    const channelId = chat.id.toString();

    // Check if bot is administrator
    if (TELEGRAM_BOT_TOKEN) {
      const meRes = await callTelegramApi("getMe", {});
      if (meRes.ok && meRes.result?.id) {
        const memberRes = await callTelegramApi("getChatMember", {
          chat_id: channelId,
          user_id: meRes.result.id,
        });

        if (!memberRes.ok || !["administrator", "creator"].includes(memberRes.result?.status)) {
          return {
            success: false,
            error: "Please add @QetoBot as an Administrator to your channel first.",
          };
        }
      }
    }

    return {
      success: true,
      channelId,
      channelTitle: chat.title || formattedHandle,
      channelUsername: chat.username || null,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || "Failed to communicate with Telegram API",
    };
  }
}

/**
 * Sends a rich order notification alert to the merchant's Telegram chat or channel.
 */
export async function sendMerchantOrderAlert(params: {
  chatId: string;
  orderToken: string;
  customerName: string;
  phone: string;
  address: string;
  totalCents: number;
  items: Array<{ label?: string; quantity: number }>;
  paymentMethod: string;
}): Promise<boolean> {
  const { chatId, orderToken, customerName, phone, address, totalCents, items, paymentMethod } = params;

  const itemsList = items.map((i) => `• ${i.quantity}x ${i.label || "Standard"}`).join("\n");
  const formattedETB = centsToETB(totalCents);

  const text =
    `🔔 *New Order Received! (#${orderToken.slice(-6).toUpperCase()})*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `💰 *Total:* ${formattedETB} ETB (${paymentMethod === "ONLINE" ? "Held in Escrow ✅" : "Cash on Delivery 💵"})\n\n` +
    `📦 *Items:*\n${itemsList}\n\n` +
    `👤 *Customer:* ${customerName}\n` +
    `📞 *Phone:* ${phone}\n` +
    `📍 *Delivery Address:* ${address}\n\n` +
    `⏰ *Action:* Please pack and ship within 3 days.`;

  try {
    const res = await callTelegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    });
    return Boolean(res.ok);
  } catch (err) {
    console.error(`[Telegram] Failed to send order alert to ${chatId}:`, err);
    return false;
  }
}

/**
 * Pure parsing function for caption text from a Telegram channel post:
 * - Detects Birr / ETB prices
 * - Detects sizes (shoe numbers 35-46 or apparel S-XXL)
 * - Detects stock quantities
 * - Matches category keywords from the provided categories
 */
export function parseTelegramCaptionSync(
  caption: string,
  storeCategories: Array<{ id: string; name: string; keywords: string[] }> = []
): ParsedProductData {
  const lines = caption
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const title = lines[0] || "New Product";
  const description = lines.slice(1).join("\n") || title;

  // 1. Extract Price (e.g. "4,500 ETB", "4500 birr", "4500 ብር", "ዋጋ: 3200")
  let priceCents: number | null = null;
  let priceETB: string | null = null;

  // Must match either:
  // (a) Price prefix + number (+ optional currency): e.g. "ዋጋ: 3,500" or "price: 2500 birr"
  // (b) Number + currency suffix: e.g. "3,500 ብር" or "2500 ETB"
  const priceRegex =
    /(?:(?:price|ዋጋ|rate)\s*[:=-]?\s*(\d{1,3}(?:,\d{3})+|\d+)\s*(?:etb|birr|ብር|br|\$)?|(\d{1,3}(?:,\d{3})+|\d+)\s*(?:etb|birr|ብር|br|\$))/i;
  const priceMatch = caption.match(priceRegex);

  if (priceMatch) {
    const rawNum = priceMatch[1] || priceMatch[2];
    if (rawNum) {
      const cleanNum = parseFloat(rawNum.replace(/,/g, ""));
      if (!isNaN(cleanNum) && cleanNum > 0) {
        priceCents = Math.round(cleanNum * 100);
        priceETB = cleanNum.toFixed(2);
      }
    }
  }

  // 2. Extract Sizes (e.g. "40-43", "40, 41, 42", "S M L XL", "Size: 42")
  const sizes: string[] = [];

  // Numeric shoe sizes: ranges like 40-44 or lists like 40, 41, 42
  const rangeMatch = caption.match(/\b([3-4][0-9])\s*[-–—to]+\s*([3-4][0-9])\b/i);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    if (start <= end && end - start <= 8) {
      for (let s = start; s <= end; s++) {
        sizes.push(s.toString());
      }
    }
  }

  // Check for line with size prefix: e.g. "Size: S M L XL" or "Size: 40, 41, 42"
  const explicitSizeLine = caption.match(/(?:size|sizes|ልክ)\s*[:=-]?\s*([^\n\r]+)/i);
  if (explicitSizeLine && sizes.length === 0) {
    const lineText = explicitSizeLine[1];
    // First try shoe sizes in that line
    const shoeMatches = lineText.match(/[3-4][0-9]/g);
    if (shoeMatches && shoeMatches.length > 0) {
      sizes.push(...Array.from(new Set(shoeMatches)));
    } else {
      // Try apparel sizes (S, M, L, XL, XXL)
      const found = lineText.match(/\b(XXL|XL|XS|[SML])\b/gi);
      if (found && found.length > 0) {
        sizes.push(...Array.from(new Set(found.map((s) => s.toUpperCase()))));
      }
    }
  }

  // Comma/space separated shoe sizes without prefix
  if (sizes.length === 0) {
    const shoeListMatch = caption.match(/\b((?:[3-4][0-9][\s,/]+)+[3-4][0-9])\b/i);
    if (shoeListMatch) {
      const extracted = shoeListMatch[1].match(/[3-4][0-9]/g);
      if (extracted && extracted.length > 1) {
        sizes.push(...Array.from(new Set(extracted)));
      }
    }
  }

  // Clothing sizes with slash/comma (e.g. "S/M/L" or "S, M, L")
  if (sizes.length === 0) {
    const slashOrCommaMatch = caption.match(/\b((?:(?:XXL|XL|XS|[SML])\s*[/,]\s*)+(?:XXL|XL|XS|[SML]))\b/i);
    if (slashOrCommaMatch) {
      const found = slashOrCommaMatch[1].match(/\b(XXL|XL|XS|[SML])\b/gi);
      if (found && found.length > 0) {
        sizes.push(...Array.from(new Set(found.map((s) => s.toUpperCase()))));
      }
    }
  }

  // Fallback variant if no sizes detected
  if (sizes.length === 0) {
    sizes.push("Standard");
  }

  // 3. Extract Quantity / Stock (e.g. "5 pcs", "3 items left", "quantity: 10")
  let stock: number | null = null;
  const stockMatch = caption.match(/\b(\d+)\s*(?:pcs|piece|pieces|items|left|ቀርቷል|ብዛት)\b/i);
  if (stockMatch && stockMatch[1]) {
    const s = parseInt(stockMatch[1], 10);
    if (!isNaN(s) && s > 0) {
      stock = s;
    }
  }

  // 4. Keyword Matching with Store Categories (from Module A)
  let matchedCategoryId: string | null = null;
  let matchedCategoryName: string | null = null;

  let bestScore = 0;
  const lowerCaption = caption.toLowerCase();

  for (const cat of storeCategories) {
    let score = 0;
    // Match category name
    if (lowerCaption.includes(cat.name.toLowerCase())) {
      score += 3;
    }
    // Match keywords
    for (const keyword of cat.keywords) {
      if (lowerCaption.includes(keyword.toLowerCase())) {
        score += 2;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      matchedCategoryId = cat.id;
      matchedCategoryName = cat.name;
    }
  }

  const confidence: "HIGH" | "MEDIUM" | "LOW" =
    priceCents !== null && sizes.length > 0 ? "HIGH" : priceCents !== null ? "MEDIUM" : "LOW";

  return {
    title,
    description,
    priceCents,
    priceETB,
    sizes,
    stock: stock || 1, // default 1 if not specified
    matchedCategoryId,
    matchedCategoryName,
    confidence,
  };
}

/**
 * Parses caption text from a Telegram channel post and matches against store categories in DB.
 */
export async function parseTelegramPost(
  caption: string,
  storeId: string
): Promise<ParsedProductData> {
  let storeCategories: Array<{ id: string; name: string; keywords: string[] }> = [];

  try {
    if (storeId) {
      storeCategories = await prisma.category.findMany({
        where: { storeId },
        select: { id: true, name: true, keywords: true },
      });
    }
  } catch (err) {
    console.error("[Telegram] Error fetching categories for parser:", err);
  }

  return parseTelegramCaptionSync(caption, storeCategories);
}

