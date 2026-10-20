/**
 * Номер главы готового перевода, присланной кнопкой при обходе. Сайты
 * переводов делят главы на части («Глава 5.1», «Глава 5.2») и нумеруют
 * главы заново в каждом томе («Том 2 Глава 1») — у нас же номер один на
 * книгу и совпадает с английским оригиналом.
 *
 * expected — номер, которого ждёт обход (прошлый + 1); prevTitle —
 * заголовок прошлой записанной главы (номер expected − 1).
 *
 * - Номер на странице тот же, что у прошлой главы на сайте («5.2» после
 *   «5.1», «Глава 1 (продолжение)» после «Том 2 Глава 1.1»), — дописать к
 *   прошлой главе.
 * - Часть 2 и дальше вне обхода — дописать к главе с этим номером.
 * - При обходе номер ушёл назад — нумерация началась заново (новый том):
 *   ожидаемый номер.
 * - Иначе — номер со страницы, а если его нет — ожидаемый.
 */

import { chapterNumberFrom } from "./url";

const PART = /(?<![\p{L}\p{N}])(?:глава|chapter|ch)\.?\s*[#№]?\s*(\d{1,5})[.,](\d{1,2})(?!\d)/iu;

/** Номер главы на сайте (без части) и номер части, если есть. */
export function siteNumber(title: string, url: string | null): { main: number; part: number | null } | null {
  const m = PART.exec(title);
  if (m) return { main: Number(m[1]), part: Number(m[2]) };
  const raw = chapterNumberFrom(title, url);
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
  return { main: Math.floor(raw), part: null };
}

export function resolveRefNumber(
  title: string,
  url: string | null,
  expected: number | null,
  prevTitle: string | null = null,
): { number: number; append: boolean } | null {
  const here = siteNumber(title, url);
  if (!here) return expected !== null ? { number: expected, append: false } : null;
  if (expected !== null && expected > 1) {
    const prev = prevTitle !== null ? siteNumber(prevTitle, null) : null;
    // Та же глава сайта, что и прошлая: её продолжение.
    if (prev && prev.main === here.main && (here.part === null || here.part > 1)) return { number: expected - 1, append: true };
    if (!prev && here.part === null && here.main === expected - 1) return { number: expected - 1, append: true };
    if (here.part !== null && here.part > 1 && here.main < expected - 1) return { number: expected - 1, append: true };
    if (here.main < expected - 1) return { number: expected, append: false };
  }
  if (here.part !== null && here.part > 1) return { number: here.main, append: true };
  return { number: here.main, append: false };
}
