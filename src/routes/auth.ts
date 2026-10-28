import { Router, Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { hashPassword, signToken, normalizePhone } from "../lib/auth.js";

export const authRouter = Router();

// 1. Validation schema for input data
const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  phone: z.string().min(9, "Phone number is required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  email: z.string().email("Invalid email address").optional().or(z.literal("")),
});

/**
 * POST /api/auth/register
 */
authRouter.post("/register", async (req: Request, res: Response) => {
  try {
    // 2. Validate request body
    const parseResult = registerSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }

    const { name, phone: rawPhone, password, email: rawEmail } = parseResult.data;

    // 3. Clean and normalize the Ethiopian phone number
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      res.status(400).json({
        error: "Invalid Ethiopian phone number. Must start with 09, 07, or +251",
      });
      return;
    }

    // 4. Check if a user with this phone already exists in the database
    const existingUser = await prisma.user.findUnique({
      where: { phone },
    });
    if (existingUser) {
      res.status(409).json({ error: "Phone number is already registered" });
      return;
    }

    // 5. Check if email is already taken (if an email was provided)
    const email = rawEmail ? rawEmail.toLowerCase().trim() : null;
    if (email) {
      const existingEmail = await prisma.user.findUnique({
        where: { email },
      });
      if (existingEmail) {
        res.status(409).json({ error: "Email is already registered" });
        return;
      }
    }

    // 6. Scramble the password using hashPassword() from src/lib/auth.ts
    const hashedPassword = await hashPassword(password);

    // 7. Save the new user to PostgreSQL via Prisma
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        phone,
        email,
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        createdAt: true,
        // Notice: We NEVER select `password` to keep it safe!
      },
    });

    // 8. Generate a JWT token using signToken() from src/lib/auth.ts
    const token = signToken(user.id);

    // 9. Send back the token and user details to the client
    res.status(201).json({
      message: "User registered successfully",
      token,
      user,
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});
