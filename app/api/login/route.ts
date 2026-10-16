import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { failedLoginsRecent, recordLoginAttempt } from "@/lib/db/misc";
import { SESSION_COOKIE, appPassword, passwordMatches, sessionCookieOptions, signSession } from "@/lib/server/auth";
import { json, readJson, serverError } from "@/lib/server/http";

const MAX_FAILS = 5;

export async function POST(req: NextRequest) {
  const password = appPassword();
  if (!password) {
    return json({ ok: false, code: "no_password", message: "Пароль не задан: добавьте APP_PASSWORD в настройках Vercel и перевыложите." });
  }
  const body = await readJson<{ password?: unknown }>(req, 10_000);
  const given = typeof body?.password === "string" ? body.password : "";
  try {
    const d = await db();
    if ((await failedLoginsRecent(d, 15)) >= MAX_FAILS) {
      return json({ ok: false, code: "too_many", message: "Слишком много неудачных попыток. Подождите 15 минут." }, 429);
    }
    const ok = await passwordMatches(given, password);
    await recordLoginAttempt(d, ok);
    if (!ok) return json({ ok: false, code: "wrong_password", message: "Пароль не подошёл." }, 401);
    const res = json({ ok: true });
    res.cookies.set(SESSION_COOKIE, await signSession(password), sessionCookieOptions(req.headers.get("host")));
    return res;
  } catch (e) {
    return serverError(e);
  }
}
