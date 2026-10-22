import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { deleteChapter, getBook, getChapter, getParagraphs, neighbors } from "@/lib/db/books";
import { latestJobForChapter, liveJobForChapter } from "@/lib/db/jobs";
import { getPosition, getSettings } from "@/lib/db/misc";
import { listTerms } from "@/lib/db/terms";
import { refNumbers } from "@/lib/db/reference";
import { readyHref } from "@/lib/core/ready";
import { getParagraphsSince, getTranslation } from "@/lib/db/translations";
import { estimateTranslationUsd } from "@/lib/core/cost";
import { fail, json, serverError } from "@/lib/server/http";
import type { Chapter, ChapterView, NeighborView } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Сосед для «Дальше»/«Назад». Своего перевода у соседа нет, а глава
 * готового перевода с его номером (или с номером рядом, если соседа в
 * книге нет) есть — её и предложить читать.
 */
function neighborView(bookId: string, c: Chapter | null, url: string | null, fallbackNumber: number | null, ready: Set<number>): NeighborView {
  const translated = Boolean(c?.currentTranslationId);
  const number = c ? c.number : fallbackNumber;
  const ready_ = !translated && number !== null && number > 0 && ready.has(number) ? readyHref(bookId, number) : null;
  return { chapterId: c?.id ?? null, url: c?.url ?? url, translated, readyHref: ready_ };
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    const d = await db();
    const chapter = await getChapter(d, id);
    if (!chapter) return fail(404, "not_found", "Глава не найдена.");
    const book = await getBook(d, chapter.bookId);
    if (!book) return fail(404, "not_found", "Книга не найдена.");
    const [paragraphs, near, terms, position, settings, live, latest, ready] = await Promise.all([
      getParagraphs(d, id),
      neighbors(d, chapter),
      listTerms(d, book.id),
      getPosition(d, book.id),
      getSettings(d),
      liveJobForChapter(d, id),
      latestJobForChapter(d, id),
      refNumbers(d, book.id),
    ]);
    let translation: ChapterView["translation"] = null;
    if (chapter.currentTranslationId) {
      const t = await getTranslation(d, chapter.currentTranslationId);
      if (t) translation = { ...t, paragraphs: await getParagraphsSince(d, t.id, 0) };
    }
    // Не вышедший перевод показываем, только пока нет готового: иначе
    // старая ошибка висела бы над прочитанной главой.
    const job = live ?? (latest && latest.state === "failed" && !translation ? latest : null);
    const model = settings.translateModel;
    const estimate = model
      ? (() => {
          const usd = estimateTranslationUsd(model, chapter.words, { effort: settings.translateEffort, extractModel: settings.extractModel });
          return { usd, rub: usd * settings.usdRub, model };
        })()
      : null;
    const view: ChapterView = {
      chapter,
      book,
      paragraphs,
      translation,
      job,
      prev: neighborView(book.id, near.prev, chapter.prevUrl, chapter.number !== null ? chapter.number - 1 : null, ready),
      next: neighborView(book.id, near.next, chapter.nextUrl, chapter.number !== null ? chapter.number + 1 : null, ready),
      terms,
      position: position && position.chapterId === id ? { paragraphIdx: position.paragraphIdx } : null,
      estimate,
      readyHref: !translation && chapter.number !== null && ready.has(chapter.number) ? readyHref(book.id, chapter.number) : null,
    };
    return json(view);
  } catch (e) {
    return serverError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    await deleteChapter(await db(), id);
    return json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
