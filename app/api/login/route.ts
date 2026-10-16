import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { beginLoginAttempt, loginSucceeded } from "@/lib/db/misc";
import { SESSION_COOKIE, appPassword, passwordMatches, sessionCookieOptions, signSession } from "@/lib/server/auth";
import { json, readJson, serverError } from "@/lib/server/http";

const MAX_FAILS = 5;

/** Адрес клиента: на Vercel x-real-ip ставит их край сети, подделать его клиент не может. */
function clientIp(req: NextRequest): string {
  return req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
}

export async function POST(req: NextRequest) {
  const password = appPassword();
  if (!password) {
    return json({ ok: false, code: "no_password", message: "Пароль не задан: добавьте APP_PASSWORD в настройках Vercel и перевыложите." });
  }
  const body = await readJson<{ password?: unknown }>(req, 10_000);
  const given = typeof body?.password === "string" ? body.password : "";
  try {
    const d = await db();
    const ip = clientIp(req);
    const attempt = await beginLoginAttempt(d, ip, 15);
    if (attempt.failures > MAX_FAILS) {
      return json({ ok: false, code: "too_many", message: "Слишком много неудачных попыток с этого устройства. Подождите 15 минут." }, 429);
    }
    if (!(await passwordMatches(given, password))) {
      return json({ ok: false, code: "wrong_password", message: "Пароль не подошёл." }, 401);
    }
    await loginSucceeded(d, attempt.id, ip);
    const res = json({ ok: true });
    res.cookies.set(SESSION_COOKIE, await signSession(password), sessionCookieOptions(req.headers.get("host")));
    return res;
  } catch (e) {
    return serverError(e);
  }
}
