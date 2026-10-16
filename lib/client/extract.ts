/**
 * Снятие главы из файла прямо в браузере: сохранённая страница (.mht/.mhtml,
 * .html/.htm). На сервер уходит только текст.
 */

import { decodeMhtml } from "../extract/mhtml";
import { extractFromDocument, markHiddenByStyles } from "../extract/dom";
import type { ExtractedChapter } from "../types";

export const FILE_ACCEPT = ".mht,.mhtml,.html,.htm,text/html,multipart/related,message/rfc822";

/** Файл похож на MHTML: по имени, типу или первым строкам. */
export function looksLikeMhtml(name: string, type: string, head: string): boolean {
  if (/\.mht(ml)?$/i.test(name)) return true;
  if (/multipart\/related|message\/rfc822/i.test(type)) return true;
  return /^(MIME-Version:|From:|Snapshot-Content-Location:|Content-Type:\s*multipart\/related)/im.test(head.slice(0, 2000));
}

/** Кодировка из <meta charset> или http-equiv в начале страницы. */
export function declaredCharset(head: string): string | null {
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i) ??
    head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset=([\w-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Байты HTML → строка: UTF-8, а если страница объявила другую кодировку — она. */
export function decodeHtmlBytes(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  const cs = declaredCharset(utf8.slice(0, 4096));
  if (cs && cs !== "utf-8" && cs !== "utf8") {
    try {
      return new TextDecoder(cs).decode(bytes);
    } catch {
      // неизвестная кодировка — остаёмся на UTF-8
    }
  }
  return utf8;
}

/** Адрес страницы, если он есть в сохранённом HTML. */
export function urlFromHtml(html: string, doc?: Document): string | null {
  const saved = html.slice(0, 2000).match(/<!--\s*saved from url=\(\d+\)(\S+?)\s*-->/i);
  if (saved && /^https?:\/\//i.test(saved[1])) return saved[1];
  if (doc) {
    const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
    if (canonical && /^https?:\/\//i.test(canonical)) return canonical;
    const og = doc.querySelector('meta[property="og:url"]')?.getAttribute("content");
    if (og && /^https?:\/\//i.test(og)) return og;
  }
  return null;
}

/** HTML-строка → глава (в браузере, через DOMParser). */
export function chapterFromHtml(html: string, url: string | null): ExtractedChapter {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const pageUrl = url ?? urlFromHtml(html, doc);
  markHiddenByStyles(doc);
  return extractFromDocument(doc, { url: pageUrl });
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") return new Uint8Array(await file.arrayBuffer());
  // Очень старые браузеры: через FileReader.
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error ?? new Error("Не удалось прочитать файл"));
    r.readAsArrayBuffer(file);
  });
}

/** Байты сохранённой страницы → глава. */
export function chapterFromBytes(bytes: Uint8Array, name: string, type: string): ExtractedChapter {
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 4096));
  if (looksLikeMhtml(name, type, head)) {
    const { html, url } = decodeMhtml(bytes);
    if (!html || !html.trim()) throw new Error("В файле не нашлось страницы. Сохраните главу ещё раз: меню браузера → «Скачать» или «Сохранить страницу».");
    return chapterFromHtml(html, url);
  }
  return chapterFromHtml(decodeHtmlBytes(bytes), null);
}

export async function chapterFromFile(file: File): Promise<ExtractedChapter> {
  if (file.size > 30 * 1024 * 1024) throw new Error("Файл слишком большой — больше 30 МБ. Сохраните одну главу.");
  const bytes = await readFileBytes(file);
  return chapterFromBytes(bytes, file.name || "", file.type || "");
}
