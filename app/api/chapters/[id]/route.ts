import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { deleteChapter, getBook, getChapter, getParagraphs, neighbors } from "@/lib/db/books";
import { latestJobForChapter, liveJobForChapter } from "@/lib/db/jobs";
import { getPosition, getSettings } from "@/lib/db/misc";
import { listTerms } from "@/lib/db/terms";
import { getParagraphsSince, getTranslation } from "@/lib/db/translations";
import { estimateTranslationUsd } from "@/lib/core/cost";
import { fail, json, serverError } from "@/lib/server/http";
import type { Chapter, ChapterView, NeighborView } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

function neighborView(c: Chapter | null, url: string | null): NeighborView {
  return { chapterId: c?.id ?? null, url: c?.url ?? url, translated: Boolean(c?.currentTranslationId) };
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    const d = await db();
    const chapter = await getChapter(d, id);
    if (!chapter) return fail(404, "not_found", "Глава не найдена.");
    const book = await getBook(d, chapter.bookId);
    if (!book) return fail(404, "not_found", "Книга не найдена.");
    const [paragraphs, near, terms, position, settings, live, latest] = await Promise.all([
      getParagraphs(d, id),
      neighbors(d, chapter),
      listTerms(d, book.id),
      getPosition(d, book.id),
      getSettings(d),
      liveJobForChapter(d, id),
      latestJobForChapter(d, id),
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
          const usd = estimateTranslationUsd(model, chapter.words, { effort: settings.translateEffort });
          return { usd, rub: usd * settings.usdRub, model };
        })()
      : null;
    const view: ChapterView = {
      chapter,
      book,
      paragraphs,
      translation,
      job,
      prev: neighborView(near.prev, chapter.prevUrl),
      next: neighborView(near.next, chapter.nextUrl),
      terms,
      position: position && position.chapterId === id ? { paragraphIdx: position.paragraphIdx } : null,
      estimate,
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
