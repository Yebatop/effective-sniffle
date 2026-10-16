/**
 * Сохранённая страница Chrome (.mht/.mhtml): разрезать MIME-части, найти
 * первую text/html-часть с содержимым (не преамбулу!), декодировать
 * quoted-printable или base64 как UTF-8 (через TextDecoder, не побайтно),
 * учесть charset части. Возвращает HTML и адрес страницы (Content-Location).
 * Работает и в браузере, и в Node.
 */
export function decodeMhtml(raw: string | Uint8Array): { html: string; url: string | null } {
  throw new Error("not implemented");
}
