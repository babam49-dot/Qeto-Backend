import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { env } from "../env.js";

export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);

export const checkPassword = (plain: string, hash: string) =>
  bcrypt.compare(plain, hash);

export function signToken(userId: string, role: string = "MERCHANT"): string {
  return jwt.sign({ sub: userId, role }, env.JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): { sub: string; role?: string } {
  return jwt.verify(token, env.JWT_SECRET) as { sub: string; role?: string };
}

// Accepts 09xxxxxxxx, 07xxxxxxxx, 9xxxxxxxx, +2519xxxxxxxx and returns +2519xxxxxxxx
export function normalizePhone(input: string): string | null {
  const m = input.replace(/[\s-]/g, "").match(/^(?:\+251|251|0)?([79]\d{8})$/);
  return m ? "+251" + m[1] : null;
}
