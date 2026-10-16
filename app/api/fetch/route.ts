import { type NextRequest } from "next/server";
import { fetchChapter } from "@/lib/extract/server";
import { fail, json, readJson } from "@/lib/server/http";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const body = await readJson<{ url?: unknown }>(req, 10_000);
  if (typeof body?.url !== "string" || !body.url.trim()) return fail(400, "unknown", "Нужна ссылка на главу.");
  return json(await fetchChapter(body.url.trim()));
}
