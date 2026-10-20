/**
 * Записать главу готового перевода от кнопки: выбрать номер (части,
 * тома с нумерацией заново, ссылка «назад» на уже записанную главу) и не
 * затереть чужую главу под тем же номером.
 */

import type { Db } from "../db/client";
import { appendRefChapterPart, refNumberByUrl, refTitle, upsertRefChapter } from "../db/reference";
import { resolveRefNumber } from "../core/refnumber";

export type RefImportOutcome =
  | { kind: "ok"; number: number; created: boolean; updated: boolean }
  | { kind: "conflict"; number: number }
  | { kind: "no_number" };

export async function importRefChapter(
  d: Db,
  bookId: string,
  input: { title: string; url: string | null; paragraphs: string[]; expectedNumber: number | null; prevUrl: string | null },
): Promise<RefImportOutcome> {
  let expected = input.expectedNumber;
  // Обход начат заново посреди книги: если прошлая глава (ссылка «назад»)
  // уже записана, эта — следующая за ней. Так переживается и нумерация по томам.
  if (expected === null && input.prevUrl) {
    const prevNumber = await refNumberByUrl(d, bookId, input.prevUrl);
    if (prevNumber !== null) expected = prevNumber + 1;
  }
  const prevTitle = expected !== null && expected > 1 ? await refTitle(d, bookId, expected - 1) : null;
  const resolved = resolveRefNumber(input.title, input.url, expected, prevTitle);
  if (!resolved) return { kind: "no_number" };
  const { number, append } = resolved;
  const chapter = { number, title: input.title, paragraphs: input.paragraphs, url: input.url };
  const r = append ? await appendRefChapterPart(d, bookId, chapter) : await upsertRefChapter(d, bookId, chapter);
  if (r.conflict) return { kind: "conflict", number };
  return { kind: "ok", number, created: r.created, updated: r.updated };
}
