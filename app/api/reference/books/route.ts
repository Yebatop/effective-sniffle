/** Книги Толмача — для выбора в кнопке на сайте готового перевода. Открыт в proxy.ts, доступ — здесь. */

import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { listRefBooks } from "@/lib/db/reference";
import { bearer, hasSession, importTokenValid } from "@/lib/server/access";
import { fail, json, serverError } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  const allowed = (await hasSession(req)) || (await importTokenValid(bearer(req)).catch(() => false));
  if (!allowed) return fail(401, "unauthorized", "Ключ кнопки не подошёл — переустановите кнопку в Толмаче («Кнопка для сайтов»).");
  try {
    return json({ books: await listRefBooks(await db()) });
  } catch (e) {
    return serverError(e);
  }
}
