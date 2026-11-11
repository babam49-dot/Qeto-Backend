import { UserRole } from "../src/generated/client.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/lib/auth.js";

async function main() {
  console.log("🌱 Seeding Qeto database...");

  // 1. Seed Super Admin
  const adminPhone = "+251900000000";
  const adminEmail = "admin@qeto.com";
  const adminPassword = await hashPassword("Admin123456!");

  const admin = await prisma.user.upsert({
    where: { phone: adminPhone },
    update: { role: UserRole.ADMIN },
    create: {
      name: "Qeto Super Admin",
      phone: adminPhone,
      email: adminEmail,
      password: adminPassword,
      role: UserRole.ADMIN,
    },
  });
  console.log(`✓ Super Admin created: ${admin.phone} (Role: ${admin.role})`);

  // 2. Seed Verified Demo Merchant
  const merchantPhone = "+251911223344";
  const merchantEmail = "merchant@qeto.com";
  const merchantPassword = await hashPassword("Merchant123456!");

  const merchant = await prisma.user.upsert({
    where: { phone: merchantPhone },
    update: {},
    create: {
      name: "Abebe Kebede",
      phone: merchantPhone,
      email: merchantEmail,
      password: merchantPassword,
      role: UserRole.MERCHANT,
    },
  });
  console.log(`✓ Demo Merchant created: ${merchant.name} (${merchant.phone})`);

  // 3. Seed Agreement Acceptance
  const existingAgreement = await prisma.agreementAcceptance.findFirst({
    where: { userId: merchant.id, version: "v1.0" },
  });

  if (!existingAgreement) {
    await prisma.agreementAcceptance.create({
      data: {
        userId: merchant.id,
        version: "v1.0",
        ip: "127.0.0.1",
        userAgent: "Qeto-Seeder/1.0",
      },
    });
  }

  // 4. Seed Demo Store
  const trialEnds = new Date();
  trialEnds.setDate(trialEnds.getDate() + 7);

  const store = await prisma.store.upsert({
    where: { slug: "abebe-boutique" },
    update: {},
    create: {
      name: "Abebe Boutique",
      slug: "abebe-boutique",
      phone: merchantPhone,
      description: "Original sneakers, streetwear, and modern Ethiopian fashion.",
      ownerId: merchant.id,
      status: "TRIAL",
      commissionBps: 300,
      trialEndsAt: trialEnds,
    },
  });
  console.log(`✓ Demo Store created: ${store.name} (Slug: /${store.slug})`);

  // 5. Seed Categories
  const catShoes = await prisma.category.upsert({
    where: { storeId_name: { storeId: store.id, name: "Shoes & Sneakers" } },
    update: {},
    create: {
      storeId: store.id,
      name: "Shoes & Sneakers",
      keywords: ["ጫማ", "sneakers", "nike", "jordan", "boots"],
      sortOrder: 1,
    },
  });

  const catClothes = await prisma.category.upsert({
    where: { storeId_name: { storeId: store.id, name: "Clothing & Streetwear" } },
    update: {},
    create: {
      storeId: store.id,
      name: "Clothing & Streetwear",
      keywords: ["ልብስ", "hoodie", "jacket", "shirt", "pants"],
      sortOrder: 2,
    },
  });

  // 6. Seed Demo Products
  const existingShoe = await prisma.product.findFirst({
    where: { storeId: store.id, name: "Nike Air Force 1 Low" },
  });

  if (!existingShoe) {
    await prisma.product.create({
      data: {
        storeId: store.id,
        categoryId: catShoes.id,
        name: "Nike Air Force 1 Low",
        description: "Classic all-white leather sneaker with durable rubber cupsole and Air cushioning.",
        imageUrls: ["https://images.unsplash.com/photo-1595950653106-6c9ebd614d3a?w=800"],
        isPublished: true,
        variants: {
          create: [
            { label: "Size 40", priceCents: 350000, stock: 5 },
            { label: "Size 41", priceCents: 350000, stock: 4 },
            { label: "Size 42", priceCents: 350000, stock: 6 },
            { label: "Size 43", priceCents: 350000, stock: 3 },
            { label: "Size 44", priceCents: 350000, stock: 2 },
          ],
        },
      },
    });
    console.log("✓ Product created: Nike Air Force 1 (Sizes 40-44)");
  }

  const existingHoodie = await prisma.product.findFirst({
    where: { storeId: store.id, name: "Heavyweight Cotton Hoodie" },
  });

  if (!existingHoodie) {
    await prisma.product.create({
      data: {
        storeId: store.id,
        categoryId: catClothes.id,
        name: "Heavyweight Cotton Hoodie",
        description: "100% Ethiopian organic cotton with double-layer hood and kangaroo pocket.",
        imageUrls: ["https://images.unsplash.com/photo-1556905055-8f358a7a47b2?w=800"],
        isPublished: true,
        variants: {
          create: [
            { label: "Size S", priceCents: 220000, stock: 8 },
            { label: "Size M", priceCents: 220000, stock: 12 },
            { label: "Size L", priceCents: 220000, stock: 10 },
            { label: "Size XL", priceCents: 220000, stock: 5 },
          ],
        },
      },
    });
    console.log("✓ Product created: Heavyweight Cotton Hoodie (Sizes S-XL)");
  }

  console.log("🎉 Seeding completed successfully!");
}

main()
  .catch((e) => {
    console.error("Seeding error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

