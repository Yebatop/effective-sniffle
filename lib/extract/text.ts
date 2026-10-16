/**
 * Вставленный текст и «Поделиться» текстом: превратить в абзацы, угадать
 * название, срезать меню/комментарии по якорям (Previous/Next Chapter,
 * Comments, Report, Advertisement …), подвалы переводчиков по краям.
 */

import type { ExtractedChapter } from "../types";

export function chapterFromPastedText(text: string, opts?: { url?: string | null; bookTitle?: string | null }): ExtractedChapter {
  throw new Error("not implemented");
}

/** Текст «Поделиться» — это просто ссылка? Вернёт адрес или null. */
export function sharedUrl(text: string): string | null {
  throw new Error("not implemented");
}

/** Срезать подвалы переводчиков только по краям (из exttran:src/extract.ts stripCredits). */
export function stripCredits(paragraphs: string[]): string[] {
  throw new Error("not implemented");
}

/** Маркеры закрытой главы — только подсказка, и только при малом тексте. */
export function looksLocked(paragraphs: string[], pageText?: string): boolean {
  throw new Error("not implemented");
}
