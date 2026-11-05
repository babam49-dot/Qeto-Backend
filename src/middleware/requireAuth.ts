import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../lib/auth.js";

// Extend Express Request to include the authenticated user ID and role
export interface AuthRequest extends Request {
  userId?: string;
  userRole?: string;
}

/**
 * Middleware that guards protected routes.
 * 1. Reads the Bearer token from the `Authorization` header.
 * 2. Verifies the token using `verifyToken`.
 * 3. Attaches `userId` and `userRole` to `req` and calls `next()`.
 * 4. Responds with 401 if missing, invalid, or expired.
 */
export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): void {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized: Not logged in" });
    return;
  }

  const token = header.slice(7).trim(); // Remove "Bearer " prefix

  if (!token) {
    res.status(401).json({ error: "Unauthorized: Token missing" });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.userId = payload.sub;
    req.userRole = payload.role;
    next();
  } catch {
    res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
}
