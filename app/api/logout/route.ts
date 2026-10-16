import { type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/server/auth";
import { json } from "@/lib/server/http";

export async function POST(req: NextRequest) {
  const res = json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(req.headers.get("host")), maxAge: 0 });
  return res;
}
