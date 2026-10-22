/** Глава готового перевода для чтения: текст и соседи (свои главы и готовые). */

import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getBook, listChapters } from "@/lib/db/books";
import { getRefChapterByNumber, refNumbers } from "@/lib/db/reference";
import { ownAt, pickNeighbor } from "@/lib/core/ready";
import { fail, json, serverError } from "@/lib/server/http";
import type { ReadyView } from "@/lib/types";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; number: string }> }) {
  const { id, number: raw } = await params;
  const number = Number(raw);
  // Номер 0 бывает (пролог «Глава 0.1»); больше int в базе не бывает.
  if (!/^\d{1,10}$/.test(raw) || number > 2_147_483_647) return fail(404, "not_found", "Такой главы нет.");
  try {
    const d = await db();
    const book = await getBook(d, id);
    if (!book) return fail(404, "not_found", "Книга не найдена.");
    const chapter = await getRefChapterByNumber(d, id, number);
    if (!chapter) return fail(404, "not_found", "Такой главы готового перевода нет.");
    const [chapters, ready] = await Promise.all([listChapters(d, id), refNumbers(d, id)]);
    const own = chapters
      .filter((c) => c.number !== null)
      .map((c) => ({ id: c.id, number: c.number as number, translated: c.translated, started: c.started }));
    const mine = ownAt(number, own);
    const view: ReadyView = {
      book: { id: book.id, title: book.title },
      chapter,
      prev: pickNeighbor(id, number, -1, own, ready),
      next: pickNeighbor(id, number, 1, own, ready),
      own: mine ? { href: `/read/${encodeURIComponent(mine.id)}`, translated: mine.translated } : null,
    };
    return json(view);
  } catch (e) {
    return serverError(e);
  }
}
