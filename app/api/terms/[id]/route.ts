import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/books";
import { deleteTerm, getTerm, updateTerm } from "@/lib/db/terms";
import { fail, json, readJson, serverError } from "@/lib/server/http";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return fail(404, "not_found", "Термин не найден.");
  const body = await readJson<Record<string, unknown>>(req, 20_000);
  if (!body || typeof body !== "object") return fail(400, "unknown", "Пустой запрос.");
  const patch: Parameters<typeof updateTerm>[2] = {};
  if (typeof body.ru === "string") patch.ru = body.ru.slice(0, 300);
  if (typeof body.kind === "string") patch.kind = body.kind as never;
  if ("gender" in body) patch.gender = (typeof body.gender === "string" ? body.gender : null) as never;
  if (Array.isArray(body.aliases)) patch.aliases = body.aliases.filter((a): a is string => typeof a === "string").slice(0, 30);
  if ("note" in body) patch.note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  if (body.status === "checked" || body.status === "proposed") patch.status = body.status;
  try {
    const d = await db();
    if (!(await getTerm(d, id))) return fail(404, "not_found", "Термин не найден.");
    return json(await updateTerm(d, id, patch));
  } catch (e) {
    if (e instanceof Error && /не может быть пустым/.test(e.message)) return fail(400, "unknown", e.message);
    return serverError(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  if (!isUuid(id)) return json({ ok: true });
  try {
    await deleteTerm(await db(), id);
    return json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
