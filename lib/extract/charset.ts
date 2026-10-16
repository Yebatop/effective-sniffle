/**
 * Байты страницы → строка с правильной кодировкой. Без зависимостей: этим
 * пользуются и сервер, и кнопка на сайтах (fetch().text() всегда читает как
 * UTF-8, а у старых сайтов бывает windows-1251 или gbk).
 */

/** Кодировка: charset из Content-Type → BOM → <meta charset> в начале → utf-8. */
export function decodeHtml(bytes: Uint8Array, contentType: string | null): string {
  let charset = charsetFrom(contentType || "");
  if (!charset) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  }
  if (!charset) {
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
    const m =
      head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i) ||
      head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w.:-]+)/i);
    if (m) charset = m[1];
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    // Неизвестное имя кодировки — TextDecoder бросает RangeError.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function charsetFrom(contentType: string): string | null {
  const m = contentType.match(/charset\s*=\s*["']?([\w.:-]+)/i);
  return m ? m[1] : null;
}
