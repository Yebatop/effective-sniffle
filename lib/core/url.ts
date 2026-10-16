/**
 * Адреса глав: нормализация, ключ книги, номер главы.
 *
 * Ключ книги — самое дорогое место для ошибки: по нему у книги один
 * глоссарий. В «Толмаче» все книги Royal Road и AO3 сводились в один ключ.
 */

/** https, хост в нижнем регистре, без #, без utm_* и прочих меток, без / в конце. Не URL — null. */
export function normalizeUrl(raw: string): string | null {
  throw new Error("not implemented");
}

/**
 * Ключ книги по адресу главы. Правила для сайтов:
 * royalroad.com/fiction/{id}/... → "royalroad.com/fiction/{id}";
 * scribblehub.com/read/{id}-slug/chapter/{c} и /series/{id}/... → "scribblehub.com/series/{id}";
 * webnovel.com/book/{slug_or_id}/... → "webnovel.com/book/{id}";
 * archiveofourown.org/works/{id}/chapters/{c} → "archiveofourown.org/works/{id}";
 * wuxiaworld.com/novel/{slug}/{chapter} → "wuxiaworld.com/novel/{slug}";
 * прочие: хост + путь без последнего сегмента-главы (chapter-12, ch-12, 12, c12, glava-12 …);
 * если путь из одного сегмента — хост + этот сегмент без номера главы.
 */
export function bookKeyFromUrl(url: string): string | null {
  throw new Error("not implemented");
}

/** Номер главы: из заголовка («Chapter 12», «Ch. 12», «Глава 12», «#12»), иначе из адреса (последнее число в пути, не id книги). */
export function chapterNumberFrom(title: string | null, url: string | null): number | null {
  throw new Error("not implemented");
}

/** Хост для показа: "royalroad.com". */
export function siteOf(url: string | null): string | null {
  throw new Error("not implemented");
}
