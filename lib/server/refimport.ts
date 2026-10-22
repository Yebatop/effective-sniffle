/**
 * Записать главу готового перевода от кнопки: выбрать номер (части,
 * тома с нумерацией заново, ссылка «назад» на уже записанную главу) и не
 * затереть чужую главу под тем же номером.
 */

import type { Db } from "../db/client";
import { appendRefChapterPart, prependRefChapterPart, refNumberByUrl, refTitle, upsertRefChapter } from "../db/reference";
import { resolveRefNumber, siteNumber } from "../core/refnumber";
import { normalizeUrl } from "../core/url";

export type RefImportOutcome =
  | { kind: "ok"; number: number; created: boolean; updated: boolean }
  | { kind: "conflict"; number: number }
  | { kind: "no_number" };

/**
 * Адрес для сравнения: без #, меток вроде utm_* и ysclid, без / в конце,
 * https, без www. — иначе одна и та же глава с хвостом из поиска выглядела
 * бы чужой.
 */
export function refUrl(raw: string | null): string | null {
  if (!raw) return null;
  const n = normalizeUrl(raw);
  return n ? n.replace(/^https:\/\/(?:www\d*|m)\./, "https://") : null;
}

export async function importRefChapter(
  d: Db,
  bookId: string,
  input: { title: string; url: string | null; paragraphs: string[]; expectedNumber: number | null; prevUrl: string | null },
): Promise<RefImportOutcome> {
  const url = refUrl(input.url) ?? input.url;
  const prevUrl = refUrl(input.prevUrl);
  let expected = input.expectedNumber;
  // Связь с прошлой главой: её записал этот же обход или ссылка «назад» ведёт в эту книгу.
  let linked = expected !== null;
  // Обход начат заново посреди книги: если прошлая глава (ссылка «назад»)
  // уже записана, эта — следующая за ней. Так переживается и нумерация по томам.
  if (expected === null && prevUrl) {
    const prevNumber = await refNumberByUrl(d, bookId, prevUrl);
    if (prevNumber !== null) {
      expected = prevNumber + 1;
      linked = true;
    }
  }
  const prevTitle = expected !== null && expected > 1 ? await refTitle(d, bookId, expected - 1) : null;
  const resolved = resolveRefNumber(input.title, url, expected, prevTitle);
  if (!resolved) return { kind: "no_number" };
  const { number, append } = resolved;
  const chapter = { number, title: input.title, paragraphs: input.paragraphs, url };
  let r = append ? await appendRefChapterPart(d, bookId, chapter, { linked }) : await upsertRefChapter(d, bookId, chapter);
  if (r.conflict && !append) {
    // Под номером — та же глава сайта, но более поздняя её часть (обход
    // начинали с «5.2»): эта часть идёт в начало.
    const storedTitle = await refTitle(d, bookId, number);
    const stored = storedTitle !== null ? siteNumber(storedTitle, null) : null;
    const here = siteNumber(input.title, url);
    if (stored && here && stored.main === here.main && (stored.part ?? 1) > (here.part ?? 1)) {
      r = await prependRefChapterPart(d, bookId, chapter);
    }
  }
  if (r.conflict) return { kind: "conflict", number };
  return { kind: "ok", number, created: r.created, updated: r.updated };
}
