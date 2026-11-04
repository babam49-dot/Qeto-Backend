import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTelegramCaptionSync } from "../lib/telegram.js";

describe("Telegram Caption Parser (parseTelegramCaptionSync)", () => {
  const mockCategories = [
    {
      id: "cat_shoes",
      name: "Shoes & Footwear",
      keywords: ["ጫማ", "sneakers", "boots", "nike", "jordan", "loafers"],
    },
    {
      id: "cat_clothes",
      name: "Clothing & Apparel",
      keywords: ["ልብስ", "jacket", "hoodie", "t-shirt", "dress", "pants"],
    },
    {
      id: "cat_electronics",
      name: "Electronics",
      keywords: ["phone", "airpods", "charger", "watch", "ስልክ"],
    },
  ];

  it("should parse Ethiopian Birr price with Amharic currency symbol", () => {
    const caption = `Nike Air Force 1
ዋጋ: 3,500 ብር
Size: 40-44
Addis Ababa delivery available`;

    const result = parseTelegramCaptionSync(caption, mockCategories);

    assert.equal(result.title, "Nike Air Force 1");
    assert.equal(result.priceCents, 350000); // 3,500 ETB = 350,000 cents
    assert.equal(result.priceETB, "3500.00");
    assert.deepEqual(result.sizes, ["40", "41", "42", "43", "44"]);
    assert.equal(result.matchedCategoryId, "cat_shoes");
    assert.equal(result.confidence, "HIGH");
  });

  it("should parse price with English ETB format and comma separators", () => {
    const caption = `Designer Cotton Hoodie
Price: 2,200 ETB
Size: S M L XL
Only 4 pcs left!`;

    const result = parseTelegramCaptionSync(caption, mockCategories);

    assert.equal(result.title, "Designer Cotton Hoodie");
    assert.equal(result.priceCents, 220000);
    assert.equal(result.priceETB, "2200.00");
    assert.deepEqual(result.sizes, ["S", "M", "L", "XL"]);
    assert.equal(result.stock, 4);
    assert.equal(result.matchedCategoryId, "cat_clothes");
    assert.equal(result.confidence, "HIGH");
  });

  it("should match category by keywords even when category name is not in text", () => {
    const caption = `ኦሪጅናል ስልክ ቻርጀር
ዋጋ 850 birr
Stock: 10 items`;

    const result = parseTelegramCaptionSync(caption, mockCategories);

    assert.equal(result.priceCents, 85000);
    assert.equal(result.matchedCategoryId, "cat_electronics");
    assert.deepEqual(result.sizes, ["Standard"]); // fallback variant
    assert.equal(result.stock, 10);
  });

  it("should provide graceful defaults when price or sizes are absent", () => {
    const caption = "Just arrived! DM for price and info.";

    const result = parseTelegramCaptionSync(caption, []);

    assert.equal(result.title, "Just arrived! DM for price and info.");
    assert.equal(result.priceCents, null);
    assert.equal(result.priceETB, null);
    assert.deepEqual(result.sizes, ["Standard"]);
    assert.equal(result.stock, 1);
    assert.equal(result.matchedCategoryId, null);
    assert.equal(result.confidence, "LOW");
  });
});
