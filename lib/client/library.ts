/**
 * Чистые помощники библиотеки: что показать в «Продолжить» и в каком
 * порядке книги.
 */

import type { BookListItem } from "../types";

export interface ContinueTarget {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  number: number | null;
  at: string;
}

/** Последняя читанная глава по всем книгам (или null). */
export function latestRead(items: readonly BookListItem[]): ContinueTarget | null {
  let best: ContinueTarget | null = null;
  for (const it of items) {
    const lr = it.lastRead;
    if (!lr) continue;
    if (!best || lr.at > best.at) {
      best = {
        bookId: it.book.id,
        bookTitle: it.book.title,
        chapterId: lr.chapterId,
        chapterTitle: lr.chapterTitle,
        number: lr.number,
        at: lr.at,
      };
    }
  }
  return best;
}

/** Книги: сначала читанные недавно, потом обновлённые недавно. */
export function sortBooks(items: readonly BookListItem[]): BookListItem[] {
  const key = (it: BookListItem) => (it.lastRead?.at ?? "") || "";
  return items.slice().sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    const ua = a.book.updatedAt || a.book.createdAt || "";
    const ub = b.book.updatedAt || b.book.createdAt || "";
    return ua < ub ? 1 : ua > ub ? -1 : 0;
  });
}
