/**
 * Отчёт «Что-то не так» по секретной ссылке — для сессии Claude Code,
 * которая не может войти паролем и не может открыть сайт-источник.
 * Сервер добавляет к отчёту всё, что нужно для разбора: текст главы,
 * перевод, задачу и последние вызовы модели.
 */

import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getBook, getChapter, getParagraphs } from "@/lib/db/books";
import { latestJobForChapter } from "@/lib/db/jobs";
import { getReportByToken } from "@/lib/db/misc";
import { getParagraphsSince } from "@/lib/db/translations";
import { fail, json, serverError } from "@/lib/server/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const d = await db();
    const report = await getReportByToken(d, token);
    if (!report) return fail(404, "not_found", "Отчёт не найден.");
    const chapter = report.chapterId ? await getChapter(d, report.chapterId) : null;
    const [book, source, job, calls] = chapter
      ? await Promise.all([
          getBook(d, chapter.bookId),
          getParagraphs(d, chapter.id),
          latestJobForChapter(d, chapter.id),
          d.query("select model, purpose, input_tokens, output_tokens, stop_reason, usd, created_at from api_calls where chapter_id = $1 order by created_at desc limit 20", [chapter.id]),
        ])
      : [null, [], null, { rows: [] }];
    const translation = chapter?.currentTranslationId
      ? await getParagraphsSince(d, chapter.currentTranslationId, 0)
      : job?.translationId
        ? await getParagraphsSince(d, job.translationId, 0)
        : [];
    return json({
      report,
      version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      book,
      chapter,
      source,
      translation,
      job,
      calls: calls.rows,
    });
  } catch (e) {
    return serverError(e);
  }
}
