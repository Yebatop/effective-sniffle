import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { bookSpentUsd, getBook, listChapters, updateBook } from "@/lib/db/books";
import { fail, json, readJson, serverError } from "@/lib/server/http";
import type { Gender, Register } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    const d = await db();
    const book = await getBook(d, id);
    if (!book) return fail(404, "not_found", "Книга не найдена.");
    const [chapters, spentUsd] = await Promise.all([listChapters(d, id), bookSpentUsd(d, id)]);
    return json({ book, chapters, spentUsd });
  } catch (e) {
    return serverError(e);
  }
}

const REGISTERS: Register[] = ["live", "plain", "elevated"];
const GENDERS: Gender[] = ["m", "f", "n", "unknown"];

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await readJson<Record<string, unknown>>(req, 20_000);
  if (!body || typeof body !== "object") return fail(400, "unknown", "Пустой запрос.");
  const patch: Parameters<typeof updateBook>[2] = {};
  if (typeof body.title === "string" && body.title.trim()) patch.title = body.title.trim().slice(0, 300);
  if (REGISTERS.includes(body.register as Register)) patch.register = body.register as Register;
  if ("narratorPerson" in body) patch.narratorPerson = body.narratorPerson === 1 || body.narratorPerson === 3 ? body.narratorPerson : null;
  if ("narratorGender" in body) patch.narratorGender = GENDERS.includes(body.narratorGender as Gender) ? (body.narratorGender as Gender) : null;
  if ("honorifics" in body) patch.honorifics = typeof body.honorifics === "string" && body.honorifics.trim() ? body.honorifics.trim().slice(0, 1000) : null;
  try {
    const d = await db();
    if (!(await getBook(d, id))) return fail(404, "not_found", "Книга не найдена.");
    return json(await updateBook(d, id, patch));
  } catch (e) {
    return serverError(e);
  }
}
