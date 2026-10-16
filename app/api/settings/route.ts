import { type NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { getSettings, saveSettings } from "@/lib/db/misc";
import { fail, json, readJson, serverError } from "@/lib/server/http";
import type { Settings } from "@/lib/types";

export async function GET() {
  try {
    return json(await getSettings(await db()));
  } catch (e) {
    return serverError(e);
  }
}

export async function PATCH(req: NextRequest) {
  const body = await readJson<Partial<Settings>>(req, 5_000);
  if (!body || typeof body !== "object") return fail(400, "unknown", "Пустой запрос.");
  try {
    return json(await saveSettings(await db(), body));
  } catch (e) {
    if (e instanceof Error && /Неверное значение/.test(e.message)) return fail(400, "unknown", e.message);
    return serverError(e);
  }
}
