/**
 * Готовый перевод книги: сводка (сколько глав, что с глоссарием, цена
 * сбора) и удаление. Открытая страница книги заодно толкает зависшую задачу.
 */

import { after, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getBook } from "@/lib/db/books";
import { deleteReference } from "@/lib/db/reference";
import { glossaryNeedsKick, refSummary, runGlossaryJob, stopGlossary } from "@/lib/server/glossary";
import { fail, json, originOf, serverError } from "@/lib/server/http";

export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const d = await db();
    if (!(await getBook(d, id))) return fail(404, "not_found", "Книга не найдена.");
    const summary = await refSummary(d, id);
    const job = summary.job;
    if (job && glossaryNeedsKick(job)) {
      const origin = originOf(req);
      after(() => runGlossaryJob(job.id, { origin }).catch((e) => console.error("runGlossaryJob", e)));
    }
    return json(summary);
  } catch (e) {
    return serverError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const d = await db();
    if (!(await getBook(d, id))) return fail(404, "not_found", "Книга не найдена.");
    await stopGlossary(d, id);
    await deleteReference(d, id);
    return json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
