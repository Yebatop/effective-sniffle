/**
 * Снятие главы со страницы. Один код для браузера (кнопка на сайте, файлы
 * в приложении) и сервера (linkedom). Функции принимают Document и не
 * обращаются к window/глобалам — кроме removeHiddenLive, которой нужен
 * живой DOM с раскладкой.
 *
 * Результат — абзацы по блочным элементам Readability `article.content`,
 * а не textContent (тот склеивает <p> на минифицированном HTML).
 */

import type { ExtractedChapter } from "../types";

export interface ExtractOptions {
  /** Адрес страницы — для относительных ссылок «дальше» и ключа книги. */
  url: string | null;
}

/** Главное: Document → глава. Не меняет переданный документ (работает с клоном). */
export function extractFromDocument(doc: Document, opts: ExtractOptions): ExtractedChapter {
  throw new Error("not implemented");
}

/**
 * Живая страница в браузере: пометить невидимые элементы (display:none,
 * visibility:hidden, нулевые размеры, offsetParent === null у видимых
 * типов) атрибутом data-tolmach-hidden. extractFromDocument выбрасывает
 * помеченное. Так отсекаются скрытые «водяные знаки» Royal Road.
 */
export function markHiddenLive(doc: Document): number {
  throw new Error("not implemented");
}

/**
 * Документ без раскладки (DOMParser, linkedom): найти в <style> правила с
 * display:none / visibility:hidden и пометить подходящие элементы
 * data-tolmach-hidden. Плюс инлайн-стили и атрибут hidden.
 */
export function markHiddenByStyles(doc: Document): number {
  throw new Error("not implemented");
}

/** Ссылка на следующую главу: rel=next → класс/id «next» → текст ссылки; «назад» отсеивается; якоря отрезаются. */
export function findNextLink(doc: Document, url: string | null): string | null {
  throw new Error("not implemented");
}
export function findPrevLink(doc: Document, url: string | null): string | null {
  throw new Error("not implemented");
}

/** Доля текста в ссылках (оглавление ≈ 1, глава ≈ 0). */
export function linkDensity(doc: Document): number {
  throw new Error("not implemented");
}
