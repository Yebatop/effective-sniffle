/** Собрать глоссарий из готового перевода (POST) или остановить сбор (DELETE). */

import { after, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getBook } from "@/lib/db/books";
import { stopGlossaryJob } from "@/lib/db/glossary-jobs";
import { runGlossaryJob, startGlossaryJob } from "@/lib/server/glossary";
import { fail, json, originOf, serverError } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const d = await db();
    if (!(await getBook(d, id))) return fail(404, "not_found", "Книга не найдена.");
    let started;
    try {
      started = await startGlossaryJob(id);
    } catch (e) {
      return fail(400, "unknown", e instanceof Error ? e.message : String(e));
    }
    const origin = originOf(req);
    const jobId = started.job.id;
    after(() => runGlossaryJob(jobId, { origin }).catch((e) => console.error("runGlossaryJob", e)));
    return json({ job: started.job, created: started.created }, started.created ? 202 : 200);
  } catch (e) {
    return serverError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const stopped = await stopGlossaryJob(await db(), id);
    return json({ stopped });
  } catch (e) {
    return serverError(e);
  }
}
