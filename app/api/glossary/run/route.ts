/** Эстафета сбора глоссария: следующий заход по секрету, без входа. */

import { after, type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { runGlossaryJob } from "@/lib/server/glossary";
import { relaySecret } from "@/lib/server/worker";
import { fail, json, originOf, readJson } from "@/lib/server/http";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const given = req.headers.get("x-relay-secret") ?? "";
  const expected = await relaySecret(await db());
  if (!given || given !== expected) return fail(401, "unauthorized", "Нет доступа.");
  const body = await readJson<{ jobId?: unknown }>(req, 1_000);
  if (typeof body?.jobId !== "string") return fail(400, "unknown", "Нет задачи.");
  const jobId = body.jobId;
  const origin = originOf(req);
  after(() => runGlossaryJob(jobId, { origin }).catch((e) => console.error("runGlossaryJob", e)));
  return json({ ok: true }, 202);
}
