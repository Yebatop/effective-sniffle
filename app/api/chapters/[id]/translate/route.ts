import { after, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getChapter } from "@/lib/db/books";
import { isModelId } from "@/lib/core/models";
import { needsKick, runJob, startTranslation } from "@/lib/server/worker";
import { fail, json, originOf, readJson, serverError } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ model?: unknown }>(req, 2_000);
  const model = isModelId(body?.model) ? body.model : undefined;
  try {
    const d = await db();
    if (!(await getChapter(d, id))) return fail(404, "not_found", "Глава не найдена.");
    const { jobId, job } = await startTranslation(id, { model });
    if (needsKick(job)) {
      const origin = originOf(req);
      after(() => runJob(jobId, { origin }).catch((e) => console.error("runJob", e)));
    }
    return json({ ok: true, jobId });
  } catch (e) {
    if (e instanceof Error && /выберите модель/.test(e.message)) return json({ ok: false, code: "unknown", message: e.message }, 400);
    return serverError(e);
  }
}
