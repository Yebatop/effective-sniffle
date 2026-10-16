import { after, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getJob } from "@/lib/db/jobs";
import { getParagraphsSince, getTranslation } from "@/lib/db/translations";
import { needsKick, runJob } from "@/lib/server/worker";
import { fail, json, originOf, serverError } from "@/lib/server/http";
import type { JobPoll } from "@/lib/types";

export const maxDuration = 300;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const since = Math.max(0, Number(req.nextUrl.searchParams.get("since") ?? "0") || 0);
  try {
    const d = await db();
    const job = await getJob(d, id);
    if (!job) return fail(404, "not_found", "Задача не найдена.");
    // Исполнитель пропал (погас экран, оборвался вызов) — подхватываем.
    // Повторный запуск безопасен: задачу захватит только один.
    const queuedLong = job.state === "queued" && Date.now() - Date.parse(job.updatedAt) > 15_000;
    if ((job.state === "running" && needsKick(job)) || queuedLong) {
      const origin = originOf(req);
      after(() => runJob(id, { origin }).catch((e) => console.error("runJob", e)));
    }
    const paragraphs = job.translationId ? await getParagraphsSince(d, job.translationId, since) : [];
    const t = job.translationId ? await getTranslation(d, job.translationId) : null;
    const poll: JobPoll = {
      job,
      paragraphs,
      seq: paragraphs.reduce((m, p) => Math.max(m, p.seq), since),
      costUsd: t?.costUsd ?? 0,
    };
    return json(poll);
  } catch (e) {
    return serverError(e);
  }
}
