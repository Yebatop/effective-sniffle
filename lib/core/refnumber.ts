/**
 * Номер главы готового перевода, присланной кнопкой при обходе. Сайты
 * переводов делят главы на части («Глава 5.1», «Глава 5.2») и нумеруют
 * главы заново в каждом томе («Том 2 Глава 1») — у нас же номер один на
 * книгу и совпадает с английским оригиналом.
 *
 * - Часть 2 и дальше («5.2», «5,3») — дописать к главе 5.
 * - При обходе (expected = прошлый номер + 1) номер совпал с прошлым — это
 *   тоже продолжение прошлой главы.
 * - При обходе номер ушёл назад больше чем на одну главу — нумерация
 *   началась заново (новый том): берём ожидаемый номер.
 * - Иначе — номер из заголовка или адреса, а если его нет — ожидаемый.
 */

import { chapterNumberFrom } from "./url";

const PART = /(?<![\p{L}\p{N}])(?:глава|chapter|ch)\.?\s*[#№]?\s*(\d{1,5})[.,](\d{1,2})(?!\d)/iu;

export function resolveRefNumber(
  title: string,
  url: string | null,
  expected: number | null,
): { number: number; append: boolean } | null {
  const part = PART.exec(title);
  if (part) {
    const main = Number(part[1]);
    const n = Number(part[2]);
    if (n > 1) return { number: main, append: true };
    if (expected !== null && main < expected - 1) return { number: expected, append: false };
    return { number: main, append: false };
  }
  const raw = chapterNumberFrom(title, url);
  const parsed = raw !== null && Number.isFinite(raw) ? Math.floor(raw) : null;
  if (parsed === null || parsed <= 0) return expected !== null ? { number: expected, append: false } : null;
  if (expected !== null) {
    if (parsed === expected - 1) return { number: parsed, append: true };
    if (parsed < expected - 1) return { number: expected, append: false };
  }
  return { number: parsed, append: false };
}
