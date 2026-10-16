/** Книги и главы: импорт без дублей, чтение для читалки и библиотеки. */

import type { Db } from "./client";
import type { Book, BookListItem, Chapter, ChapterSource, ExtractedChapter, Paragraph, Register, Gender } from "../types";

export interface ImportInput extends ExtractedChapter {
  source: ChapterSource;
  /** Явный выбор книги (вставка, файл). Иначе — по ключу книги из адреса. */
  bookId?: string;
}

/**
 * Записать главу. Книга: bookId → по bookKeyFromUrl(url) → новая книга
 * (название — bookTitle или «Без названия»). Глава идемпотентна по
 * (book_id, sha256 нормализованного текста): повтор возвращает
 * существующую с created=false. Если у существующей главы не было
 * next_url/prev_url/url, а теперь есть — дополнить. Абзацы пишутся в
 * chapter_paragraphs: idx 0 — название, дальше текст.
 */
export async function importChapter(d: Db, input: ImportInput): Promise<{ chapter: Chapter; book: Book; created: boolean }> {
  throw new Error("not implemented");
}

export async function getBook(d: Db, id: string): Promise<Book | null> {
  throw new Error("not implemented");
}

export async function updateBook(
  d: Db,
  id: string,
  patch: Partial<{ title: string; register: Register; narratorPerson: 1 | 3 | null; narratorGender: Gender | null; honorifics: string | null; coverUrl: string | null }>,
): Promise<Book> {
  throw new Error("not implemented");
}

export async function listBooks(d: Db): Promise<BookListItem[]> {
  throw new Error("not implemented");
}

export async function getChapter(d: Db, id: string): Promise<Chapter | null> {
  throw new Error("not implemented");
}

export async function getParagraphs(d: Db, chapterId: string): Promise<Paragraph[]> {
  throw new Error("not implemented");
}

/** Главы книги по порядку: номер, затем время добавления. */
export async function listChapters(d: Db, bookId: string): Promise<Array<Chapter & { translated: boolean }>> {
  throw new Error("not implemented");
}

/**
 * Соседи главы: предыдущая/следующая по номеру (или по next_url/prev_url,
 * если такая глава уже взята по нормализованному адресу).
 */
export async function neighbors(d: Db, chapter: Chapter): Promise<{ prev: Chapter | null; next: Chapter | null }> {
  throw new Error("not implemented");
}

/** Найти главу по нормализованному адресу. */
export async function findChapterByUrl(d: Db, url: string): Promise<Chapter | null> {
  throw new Error("not implemented");
}

export async function deleteChapter(d: Db, id: string): Promise<void> {
  throw new Error("not implemented");
}
