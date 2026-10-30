import { z } from "zod";
import "dotenv/config";

const schema = z.object({
    DATABASE_URL: z.string().startsWith("postgres"),
    JWT_SECRET: z.string().min(32),
    PORT: z.coerce.number().default(4000),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    CHAPA_SECRET_KEY: z.string().default("CHASECK_TEST-mock-key"),
    CHAPA_WEBHOOK_SECRET: z.string().default("chapa-webhook-secret-dev"),
    CHAPA_BASE_URL: z.string().default("https://api.chapa.co/v1"),
    APP_URL: z.string().default("http://localhost:4000"),
});

export const env = schema.parse(process.env);