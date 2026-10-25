import { z } from "zod";
import "dotenv/config";

const schema = z.object({
    DATABASE_URL: z.string().startsWith("postgres"),
    JWT_SECRET: z.string().min(32),
    PORT: z.coerce.number().default(4000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export const env = schema.parse(process.env);