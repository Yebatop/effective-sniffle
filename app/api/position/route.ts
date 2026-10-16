import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getChapter } from "@/lib/db/books";
import { savePosition } from "@/lib/db/misc";
import { fail, json, readJson, serverError } from "@/lib/server/http";
import type { PositionRequest } from "@/lib/types";

export async function POST(req: NextRequest) {
  const body = await readJson<PositionRequest>(req, 2_000);
  if (!body || typeof body.chapterId !== "string" || typeof body.paragraphIdx !== "number") return fail(400, "unknown", "Неполный запрос.");
  try {
    const d = await db();
    const chapter = await getChapter(d, body.chapterId);
    if (!chapter) return fail(404, "not_found", "Глава не найдена.");
    // Книгу берём из главы, а не из запроса: так место не попадёт в чужую книгу.
    await savePosition(d, {
      bookId: chapter.bookId,
      chapterId: chapter.id,
      paragraphIdx: body.paragraphIdx,
      device: typeof body.device === "string" ? body.device.slice(0, 40) : undefined,
    });
    return json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
