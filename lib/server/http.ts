/** Мелочи для маршрутов: JSON-ответы, чтение тела с пределом, адрес приложения. */

import { NextResponse, type NextRequest } from "next/server";

export function json(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "cache-control": "no-store" } });
}

export function fail(status: number, code: string, message: string): NextResponse {
  return json({ ok: false, code, message }, status);
}

/** Прочитать JSON не больше maxBytes; мусор или превышение — null. */
export async function readJson<T = unknown>(req: Request, maxBytes = 1_000_000): Promise<T | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  let text: string;
  try {
    text = await req.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Адрес приложения, по которому пришёл запрос: на него уходит эстафета и
 * ссылки в ответах. На Vercel x-forwarded-host — это тот домен, который
 * открыл человек (а не защищённый адрес отдельной сборки).
 */
export function originOf(req: NextRequest | Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? (host && /^(localhost|127\.0\.0\.1)/.test(host) ? "http" : "https");
  if (host) return `${proto}://${host}`;
  return new URL(req.url).origin;
}

/** Ошибка базы или чего-то внутри — человеческий ответ вместо падения страницы. */
export function serverError(e: unknown): NextResponse {
  const message = e instanceof Error ? e.message : String(e);
  if (/База не подключена/.test(message)) return fail(503, "no_db", "База не подключена: в Vercel → Storage подключите Neon и перевыложите.");
  console.error(e);
  return fail(500, "unknown", message);
}
