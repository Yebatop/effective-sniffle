/**
 * Приём глав: от кнопки на сайте (Bearer-ключ) и из приложения (cookie).
 * Маршрут открыт в proxy.ts — доступ проверяется здесь.
 */

import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { importChapter } from "@/lib/db/books";
import { bearer, hasSession, importTokenValid } from "@/lib/server/access";
import { fail, json, readJson, serverError } from "@/lib/server/http";
import type { ChapterSource, ImportRequest, ImportResponseItem } from "@/lib/types";

const SOURCES: ChapterSource[] = ["button", "share", "paste", "file", "server", "bridge"];
const MAX_CHAPTERS = 20;
const MAX_PARAGRAPHS = 3000;
const MAX_PARAGRAPH_CHARS = 20_000;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);

export async function POST(req: NextRequest) {
  const allowed = (await hasSession(req)) || (await importTokenValid(bearer(req)).catch(() => false));
  if (!allowed) return fail(401, "unauthorized", "Ключ кнопки не подошёл — переустановите кнопку в Толмаче («Кнопка для сайтов»).");

  const body = await readJson<ImportRequest>(req, 4_000_000);
  const list = Array.isArray(body?.chapters) ? body.chapters.slice(0, MAX_CHAPTERS) : [];
  if (list.length === 0) return fail(400, "not_chapter", "В запросе нет ни одной главы.");

  try {
    const d = await db();
    const items: ImportResponseItem[] = [];
    for (const raw of list) {
      const paragraphs = Array.isArray(raw?.paragraphs)
        ? raw.paragraphs.filter((p): p is string => typeof p === "string").slice(0, MAX_PARAGRAPHS).map((p) => p.slice(0, MAX_PARAGRAPH_CHARS))
        : [];
      if (paragraphs.length === 0) continue;
      const { chapter, book, created } = await importChapter(d, {
        source: SOURCES.includes(raw.source) ? raw.source : "paste",
        bookId: typeof raw.bookId === "string" ? raw.bookId : undefined,
        url: str(raw.url, 2000),
        bookTitle: str(raw.bookTitle, 300),
        chapterTitle: str(raw.chapterTitle, 500) ?? "",
        paragraphs,
        nextUrl: str(raw.nextUrl, 2000),
        prevUrl: str(raw.prevUrl, 2000),
        coverUrl: str(raw.coverUrl, 2000),
        words: 0,
        looksLocked: Boolean(raw.looksLocked),
        looksLikeIndex: Boolean(raw.looksLikeIndex),
      });
      items.push({
        chapterId: chapter.id,
        bookId: book.id,
        created,
        title: chapter.titleSrc,
        words: chapter.words,
        hasTranslation: chapter.currentTranslationId != null,
      });
    }
    if (items.length === 0) return fail(400, "not_chapter", "В присланном нет текста главы.");
    return json({ items });
  } catch (e) {
    if (e instanceof Error && /Книга не найдена|нет текста/.test(e.message)) return fail(400, "unknown", e.message);
    return serverError(e);
  }
}
