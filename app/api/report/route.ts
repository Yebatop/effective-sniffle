import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getChapter } from "@/lib/db/books";
import { createReport } from "@/lib/db/misc";
import { newToken } from "@/lib/server/auth";
import { fail, json, originOf, readJson, serverError } from "@/lib/server/http";
import type { ReportRequest } from "@/lib/types";

const KINDS = ["wrong_text", "bad_translation", "error", "other"];

export async function POST(req: NextRequest) {
  const body = await readJson<ReportRequest>(req, 1_000_000);
  if (!body || !KINDS.includes(body.kind)) return fail(400, "unknown", "Неполный отчёт.");
  try {
    const d = await db();
    const chapterId = typeof body.chapterId === "string" && (await getChapter(d, body.chapterId)) ? body.chapterId : null;
    const token = newToken();
    const id = await createReport(d, {
      token,
      chapterId,
      kind: body.kind,
      note: typeof body.note === "string" ? body.note.slice(0, 4000) : null,
      payload: body.snapshot ?? null,
    });
    return json({ id, url: `${originOf(req)}/api/report/${token}` });
  } catch (e) {
    return serverError(e);
  }
}
