import { Response, NextFunction } from "express";
import { AuthRequest } from "./requireAuth.js";
import { prisma } from "../db.js";
import { UserRole } from "../generated/enums.js";

/**
 * Middleware that restricts routes exclusively to Qeto platform administrators / owners.
 * Verifies that the authenticated user has UserRole.ADMIN.
 */
export async function requireAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthorized: Not authenticated" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, role: true, email: true },
    });

    if (!user || user.role !== UserRole.ADMIN) {
      res.status(403).json({ error: "Forbidden: Platform administrator access required" });
      return;
    }

    next();
  } catch (error) {
    console.error("requireAdmin error:", error);
    res.status(500).json({ error: "Internal authorization error" });
  }
}

