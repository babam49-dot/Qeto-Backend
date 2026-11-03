import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

/**
 * Centralized Express global error handling middleware.
 */
export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  console.error("[ErrorHandler]", err);

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "Validation failed",
      details: err.flatten().fieldErrors,
    });
    return;
  }

  // Handle Prisma unique constraint violation (P2002)
  if (err?.code === "P2002") {
    const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "field";
    res.status(409).json({
      error: `A record with this ${target} already exists.`,
    });
    return;
  }

  // Handle Prisma record not found (P2025)
  if (err?.code === "P2025") {
    res.status(404).json({
      error: "Requested resource not found.",
    });
    return;
  }

  // Explicit HTTP status error (e.g. custom error with status property)
  const statusCode = typeof err.statusCode === "number" ? err.statusCode : 500;
  const message = err.message || "Internal server error";

  res.status(statusCode).json({
    error: message,
  });
}
