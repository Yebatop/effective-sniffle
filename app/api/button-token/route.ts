import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getSecret, setSecret } from "@/lib/db/misc";
import { newToken, sha256Hex } from "@/lib/server/auth";
import { json, originOf, serverError } from "@/lib/server/http";

/** Выпущен ли ключ кнопки (сам ключ не хранится и не показывается). */
export async function GET() {
  try {
    return json({ exists: Boolean(await getSecret(await db(), "import_token_hash")) });
  } catch (e) {
    return serverError(e);
  }
}

/** Выпустить новый ключ кнопки: старый перестаёт работать сразу. */
export async function POST(req: NextRequest) {
  try {
    const token = newToken();
    await setSecret(await db(), "import_token_hash", await sha256Hex(token));
    return json({ installUrl: `${originOf(req)}/u/${token}/tolmach.user.js` });
  } catch (e) {
    return serverError(e);
  }
}
