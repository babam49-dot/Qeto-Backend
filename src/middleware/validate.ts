import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

/**
 * Express middleware that validates req.body against a Zod schema.
 */
export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parseResult = schema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }
    req.body = parseResult.data;
    next();
  };
}

/**
 * Express middleware that validates req.query against a Zod schema.
 */
export function validateQuery(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parseResult = schema.safeParse(req.query);
    if (!parseResult.success) {
      res.status(400).json({
        error: "Query validation failed",
        details: parseResult.error.flatten().fieldErrors,
      });
      return;
    }
    req.query = parseResult.data as any;
    next();
  };
}

