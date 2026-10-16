/**
 * Сервер пробует сам открыть страницу главы (тихая первая попытка).
 * Таймаут 10 с, предел 3 МБ, кодировка из charset, User-Agent латиницей.
 * Заглушка «вы не робот?» → { ok:false, code:"site_blocked" } сразу.
 * Разбор — linkedom + extractFromDocument.
 * Только http(s) и только наружу: внутренние адреса (localhost, 10.x, 192.168.x,
 * 169.254.x, ::1 …) отклоняются.
 */

import type { FetchResponse } from "../types";

export async function fetchChapter(url: string, opts?: { fetchImpl?: typeof fetch }): Promise<FetchResponse> {
  throw new Error("not implemented");
}

/** HTML-строка → Document (linkedom) — для сервера и тестов. */
export function parseHtml(html: string, url?: string | null): Document {
  throw new Error("not implemented");
}
