import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { isUuid } from "@/lib/db/books";
import { setAddressForm } from "@/lib/db/terms";
import { fail, json, readJson, serverError } from "@/lib/server/http";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readJson<{ form?: unknown }>(req, 1_000);
  if (!isUuid(id) || (body?.form !== "ty" && body?.form !== "vy")) return fail(400, "unknown", "Обращение — «ты» или «вы».");
  try {
    await setAddressForm(await db(), id, body.form);
    return json({ ok: true });
  } catch (e) {
    return serverError(e);
  }
}
