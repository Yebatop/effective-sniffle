/** Проверки доступа внутри открытых маршрутов: cookie входа или ключ кнопки. */

import type { NextRequest } from "next/server";
import { db } from "../db/client";
import { getSecret } from "../db/misc";
import { SESSION_COOKIE, appPassword, sha256Hex, verifySession } from "./auth";

export async function hasSession(req: NextRequest): Promise<boolean> {
  const password = appPassword();
  return password ? verifySession(password, req.cookies.get(SESSION_COOKIE)?.value) : false;
}

/** Ключ кнопки верен? Сравниваем хеш: сам ключ в базе не хранится. */
export async function importTokenValid(token: string | null | undefined): Promise<boolean> {
  if (!token || token.length < 20 || token.length > 200) return false;
  const stored = await getSecret(await db(), "import_token_hash");
  if (!stored) return false;
  return (await sha256Hex(token)) === stored;
}

export function bearer(req: NextRequest): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m ? m[1] : null;
}
