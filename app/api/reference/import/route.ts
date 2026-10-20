/**
 * Приём глав готового перевода: от кнопки на русском сайте (Bearer-ключ)
 * или из приложения (cookie). Маршрут открыт в proxy.ts — доступ здесь.
 */

import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getBook, isUuid } from "@/lib/db/books";
import { appendRefChapterPart, upsertRefChapter } from "@/lib/db/reference";
import { resolveRefNumber } from "@/lib/core/refnumber";
import { bearer, hasSession, importTokenValid } from "@/lib/server/access";
import { fail, json, readJson, serverError } from "@/lib/server/http";
import type { RefImportRequest, RefImportResponse } from "@/lib/types";

const MAX_CHAPTERS = 20;
const MAX_PARAGRAPHS = 3000;
const MAX_PARAGRAPH_CHARS = 20_000;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export async function POST(req: NextRequest) {
  const allowed = (await hasSession(req)) || (await importTokenValid(bearer(req)).catch(() => false));
  if (!allowed) return fail(401, "unauthorized", "Ключ кнопки не подошёл — переустановите кнопку в Толмаче («Кнопка для сайтов»).");

  const body = await readJson<RefImportRequest>(req, 4_000_000);
  const bookId = typeof body?.bookId === "string" ? body.bookId : "";
  if (!isUuid(bookId)) return fail(400, "unknown", "Не выбрана книга в Толмаче.");
  const list = Array.isArray(body?.chapters) ? body.chapters.slice(0, MAX_CHAPTERS) : [];
  if (list.length === 0) return fail(400, "not_chapter", "В запросе нет ни одной главы.");

  try {
    const d = await db();
    if (!(await getBook(d, bookId))) return fail(404, "unknown", "Такой книги в Толмаче нет — выберите книгу заново.");
    const items: RefImportResponse["items"] = [];
    for (const raw of list) {
      const paragraphs = Array.isArray(raw?.paragraphs)
        ? raw.paragraphs
            .filter((p): p is string => typeof p === "string")
            .map((p) => p.slice(0, MAX_PARAGRAPH_CHARS).trim())
            .filter(Boolean)
            .slice(0, MAX_PARAGRAPHS)
        : [];
      if (paragraphs.length === 0) continue;
      const title = str(raw.chapterTitle, 500) ?? "";
      const url = str(raw.url, 2000);
      const expected = typeof raw.expectedNumber === "number" && Number.isInteger(raw.expectedNumber) && raw.expectedNumber > 0 ? raw.expectedNumber : null;
      const resolved = resolveRefNumber(title, url, expected);
      if (!resolved) return fail(400, "not_chapter", `Не понял номер главы «${title.slice(0, 80)}».`);
      const { number, append } = resolved;
      const r = append
        ? await appendRefChapterPart(d, bookId, { number, title, paragraphs, url })
        : await upsertRefChapter(d, bookId, { number, title, paragraphs, url });
      items.push({ number, ...r });
    }
    if (items.length === 0) return fail(400, "not_chapter", "В присланном нет текста главы.");
    const out: RefImportResponse = { items };
    return json(out);
  } catch (e) {
    return serverError(e);
  }
}
