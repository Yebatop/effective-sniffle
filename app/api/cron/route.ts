/**
 * Ежедневная подстраховка: продолжить зависшие переводы. Сам по себе
 * ничего не тратит — только доделывает уже заказанное. Если в Vercel
 * задан CRON_SECRET, Vercel присылает его в заголовке, и мы его проверяем.
 */

import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { staleJobs } from "@/lib/db/jobs";
import { staleGlossaryJobs } from "@/lib/db/glossary-jobs";
import { relaySecret } from "@/lib/server/worker";
import { fail, json, originOf, serverError } from "@/lib/server/http";

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) return fail(401, "unauthorized", "Нет доступа.");
  try {
    const d = await db();
    const jobs = await staleJobs(d);
    const glossaryJobs = await staleGlossaryJobs(d);
    const origin = originOf(req);
    const relay = await relaySecret(d);
    const kick = (path: string, jobId: string) =>
      fetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-relay-secret": relay },
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
    // Каждую задачу — отдельным вызовом: одна глава занимает до 5 минут.
    await Promise.all([...jobs.map((j) => kick("/api/jobs/run", j.id)), ...glossaryJobs.map((j) => kick("/api/glossary/run", j.id))]);
    return json({ resumed: jobs.length + glossaryJobs.length });
  } catch (e) {
    return serverError(e);
  }
}
